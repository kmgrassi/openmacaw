defmodule SymphonyElixir.LocalRelay.MachineHeartbeatRecorder do
  @moduledoc """
  Behaviour for persisting helper presence to `local_runtime_machine` on
  every register, heartbeat, and disconnect at the relay socket.

  The in-process registry (`SymphonyElixir.LocalRelay.Registry`) and
  presence module (`SymphonyElixir.LocalRelay.Presence`) remain the
  source of truth for routing. This recorder is observability: it
  refreshes `last_seen_at`, the advertised runner kinds, and the helper
  version on the DB row so the platform UI can render presence without
  reaching into the in-memory orchestrator state.

  The default (`Noop`) is wired in dev/test so unit tests don't have to
  stand up a database. Production overrides to `PostgREST` in
  `config/prod.exs`.

  See `docs/local-helper-page-runtime-scope.md` for context.
  """

  @typedoc "UUID of a `local_runtime_machine` row."
  @type machine_id :: String.t()

  @typedoc "Optional helper-reported fields that go on every write."
  @type fields :: %{
          optional(:helper_version) => String.t() | nil,
          optional(:advertised_runner_kinds) => [String.t()]
        }

  @callback record_register(machine_id(), fields()) :: :ok
  @callback record_heartbeat(machine_id(), fields()) :: :ok
  @callback record_disconnect(machine_id()) :: :ok

  @spec record_register(machine_id(), fields()) :: :ok
  def record_register(machine_id, fields \\ %{}) when is_binary(machine_id) do
    adapter().record_register(machine_id, fields)
  end

  @spec record_heartbeat(machine_id(), fields()) :: :ok
  def record_heartbeat(machine_id, fields \\ %{}) when is_binary(machine_id) do
    adapter().record_heartbeat(machine_id, fields)
  end

  @spec record_disconnect(machine_id()) :: :ok
  def record_disconnect(machine_id) when is_binary(machine_id) do
    adapter().record_disconnect(machine_id)
  end

  defp adapter do
    Application.get_env(
      :symphony_elixir,
      :local_relay_machine_heartbeat_recorder,
      __MODULE__.Noop
    )
  end
end
