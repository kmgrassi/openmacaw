defmodule SymphonyElixir.Diagnostic.ContainerInventory do
  @moduledoc """
  Runtime container inventory — both reusable snapshot helpers and the
  boot-time logging that surfaces "binary or env var missing in the
  container" to CloudWatch on every container start.

  `snapshot/0` and `binary_slice/1` are side-effect-free helpers used by
  per-agent probes to attach missing-binary context without logging
  secrets.

  `emit_startup_log/0` is the side-effecty boot-time entry point: called
  once from `SymphonyElixir.Application.start/2`, emits a structured
  `:container_inventory_completed` event listing every required binary
  and env var with presence flags, and additionally emits one
  `:container_inventory_binary_missing` or
  `:container_inventory_env_var_missing` warning per missing item so each
  is independently grep-able in CloudWatch.

  Env var presence is recorded as `true`/`false`. Values are never
  logged.
  """

  require Logger

  alias SymphonyElixir.RuntimeLog

  @required_binaries ~w(bash git gh aws codex ssh)

  # Logical credential groups. Each group lists the env vars that satisfy the
  # same underlying requirement — any one of them being set marks the group
  # satisfied. Groups exist so alias pairs (e.g. `GH_TOKEN` / `GITHUB_TOKEN`,
  # which the `gh` CLI and the `git.run` tool both treat as alternatives)
  # don't generate false-positive `env_var_missing` warnings when only one is
  # configured.
  #
  # IMPORTANT — only list env vars the orchestrator container actually needs at
  # the *container* level. Per-workspace LLM credentials (OPENAI_API_KEY,
  # ANTHROPIC_API_KEY, etc.) live in the Supabase `credential` table and are
  # resolved per-agent through routing rules + execution profiles; they are
  # NOT supposed to be injected as container env vars and listing them here
  # produces false-positive boot warnings on every container start.
  @required_env_var_groups [
    {"github_token", ~w(GH_TOKEN GITHUB_TOKEN)},
    {"supabase_url", ~w(SUPABASE_URL)},
    {"supabase_service_role_key", ~w(SUPABASE_SERVICE_ROLE_KEY)}
  ]

  # Flat list of every individual env var we record presence for. Derived from
  # the groups so adding a new alias doesn't require touching two places.
  @required_env_vars Enum.flat_map(@required_env_var_groups, fn {_name, vars} -> vars end)

  @spec snapshot() :: %{
          binaries: %{required(String.t()) => boolean()},
          env_vars: %{required(String.t()) => boolean()},
          missing_binaries: [String.t()],
          missing_env_vars: [String.t()]
        }
  def snapshot do
    binaries = Map.new(@required_binaries, &{&1, not is_nil(System.find_executable(&1))})
    env_vars = Map.new(@required_env_vars, &{&1, present?(System.get_env(&1))})

    %{
      binaries: binaries,
      env_vars: env_vars,
      missing_binaries: missing_keys(binaries),
      missing_env_vars: missing_keys(env_vars)
    }
  end

  @spec binary_slice([String.t()]) :: %{required(String.t()) => boolean()}
  def binary_slice(names) when is_list(names) do
    snapshot = snapshot()
    Map.take(snapshot.binaries, names)
  end

  @doc """
  Emit boot-time inventory logs. Safe to call before the rest of the
  supervision tree starts — uses only `Logger` (already configured by
  `SymphonyElixir.LogFile.configure/0`) via `RuntimeLog.log/3`.

  Returns the snapshot so the caller (typically `Application.start/2`)
  can do an early-exit decision if it wants to fail closed on a missing
  binary in the future. Today this is informational only — boot
  proceeds regardless.
  """
  @spec emit_startup_log() :: :ok
  def emit_startup_log do
    # Idempotent: production calls this from the escript launcher main path
    # AND dev/test boots may call it via `Application.start/2`. Both call
    # sites are correct — we just don't want to double-emit if both paths
    # happen to run in the same node (e.g. running `iex -S mix` and then
    # invoking the CLI helpers).
    case :persistent_term.get({__MODULE__, :emitted?}, false) do
      true ->
        :ok

      false ->
        emit_now()
        :persistent_term.put({__MODULE__, :emitted?}, true)
        :ok
    end
  end

  # Test-only escape hatch: reset the emitted-flag so a test can assert
  # the emit path twice in a single VM. Not part of the public surface.
  @doc false
  @spec reset_emitted_flag_for_test!() :: :ok
  def reset_emitted_flag_for_test! do
    :persistent_term.erase({__MODULE__, :emitted?})
    :ok
  end

  defp emit_now do
    inv = snapshot()
    missing_groups = missing_env_var_groups(inv.env_vars)

    RuntimeLog.log(:info, :container_inventory_completed, %{
      binaries: inv.binaries,
      env_vars: inv.env_vars,
      missing_binaries: inv.missing_binaries,
      missing_env_vars: inv.missing_env_vars,
      missing_env_var_groups: Enum.map(missing_groups, fn {name, _} -> name end),
      ecs_metadata_uri_present: ecs_metadata_present?()
    })

    Enum.each(inv.missing_binaries, fn binary ->
      RuntimeLog.log(:warning, :container_inventory_binary_missing, %{
        binary: binary,
        expected_on_path: true
      })
    end)

    # One warning per missing credential GROUP, not per env var, so e.g.
    # setting only GH_TOKEN doesn't also fire a GITHUB_TOKEN warning.
    Enum.each(missing_groups, fn {group_name, vars} ->
      RuntimeLog.log(:warning, :container_inventory_env_var_missing, %{
        credential: group_name,
        env_vars: vars
      })
    end)

    :ok
  end

  defp missing_env_var_groups(env_vars) when is_map(env_vars) do
    for {group_name, vars} <- @required_env_var_groups,
        not Enum.any?(vars, &(Map.get(env_vars, &1) == true)) do
      {group_name, vars}
    end
  end

  defp ecs_metadata_present? do
    case System.get_env("ECS_CONTAINER_METADATA_URI_V4") do
      uri when is_binary(uri) and uri != "" -> true
      _ -> false
    end
  end

  defp missing_keys(values) do
    values
    |> Enum.reject(fn {_key, present?} -> present? end)
    |> Enum.map(fn {key, _present?} -> key end)
    |> Enum.sort()
  end

  defp present?(value) when is_binary(value), do: String.trim(value) != ""
  defp present?(_value), do: false
end
