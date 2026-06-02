defmodule SymphonyElixir.LocalRelay.TokenValidator do
  @moduledoc """
  Validates workspace-scoped local runtime helper tokens.

  Runtime owns the relay socket, but platform owns token issuance and
  revocation. This module is the runtime hook point for that platform lookup.

  Two adapters are available, selected via the
  `:local_relay_token_validator` application env key:

  - `SymphonyElixir.LocalRelay.TokenValidator.Config` (default in `:dev`
    and `:test`) validates against token hashes configured in
    application env. Keeps tests and local deployments deterministic
    without storing raw token material in state.
  - `SymphonyElixir.LocalRelay.TokenValidator.PostgREST` (wired in
    `config/prod.exs`) validates against `local_runtime_token` and
    `local_runtime_machine` in `harper-server` via `PostgRESTClient`
    (service-role key), since the relay socket runs in launcher escript
    mode and never starts `SymphonyElixir.Repo`.
  """

  @type token_metadata :: %{
          required(:workspace_id) => String.t(),
          required(:machine_id) => String.t(),
          optional(:token_id) => String.t(),
          optional(:runner_kinds) => [String.t()],
          optional(:revoked?) => boolean()
        }

  @type validation_attrs :: %{
          optional(:workspace_id) => String.t(),
          optional(:machine_id) => String.t(),
          optional(:peer_data) => term()
        }

  @type error_reason ::
          :missing_token
          | :invalid_token
          | :local_runtime_token_revoked
          | :workspace_mismatch
          | :machine_mismatch
          | :validator_unavailable

  @callback validate(String.t(), validation_attrs()) ::
              {:ok, token_metadata()} | {:error, error_reason()}

  @doc """
  Validate a presented local relay token with no additional frame attributes.
  """
  @spec validate(String.t() | nil) :: {:ok, token_metadata()} | {:error, error_reason()}
  def validate(token), do: validate(token, %{})

  @doc """
  Validate a presented local relay token through the configured adapter.
  """
  @spec validate(String.t() | nil, validation_attrs()) ::
          {:ok, token_metadata()} | {:error, error_reason()}
  def validate(token, _attrs) when token in [nil, ""], do: {:error, :missing_token}

  def validate(token, attrs) when is_binary(token) and is_map(attrs) do
    adapter =
      Application.get_env(:symphony_elixir, :local_relay_token_validator, __MODULE__.Config)

    adapter.validate(token, attrs)
  rescue
    _error -> {:error, :validator_unavailable}
  catch
    :exit, _reason -> {:error, :validator_unavailable}
  end

  @doc """
  Return a lowercase SHA-256 token hash suitable for configuration.
  """
  @spec hash_token(String.t()) :: String.t()
  def hash_token(token) when is_binary(token) do
    :crypto.hash(:sha256, token) |> Base.encode16(case: :lower)
  end
end

defmodule SymphonyElixir.LocalRelay.TokenValidator.Config do
  @moduledoc """
  Token validator backed by `:local_relay_token_hashes` application env.

  Expected shape:

      config :symphony_elixir,
        local_relay_token_hashes: %{
          "sha256-token-hash" => %{
            workspace_id: "workspace-id",
            machine_id: "machine-id",
            token_id: "token-id",
            revoked?: false
          }
        }
  """

  @behaviour SymphonyElixir.LocalRelay.TokenValidator

  alias SymphonyElixir.LocalRelay.TokenValidator

  @impl true
  def validate(token, attrs) when is_binary(token) and is_map(attrs) do
    hashes = Application.get_env(:symphony_elixir, :local_relay_token_hashes, %{})
    token_hash = TokenValidator.hash_token(token)

    case Map.get(hashes, token_hash) do
      nil -> {:error, :invalid_token}
      metadata -> validate_metadata(normalize_metadata(metadata), attrs)
    end
  end

  @spec validate_metadata(TokenValidator.token_metadata(), TokenValidator.validation_attrs()) ::
          {:ok, TokenValidator.token_metadata()} | {:error, TokenValidator.error_reason()}
  def validate_metadata(%{revoked?: true}, _attrs), do: {:error, :local_runtime_token_revoked}

  def validate_metadata(metadata, attrs) when is_map(metadata) and is_map(attrs) do
    with :ok <- match_attr(metadata, attrs, :workspace_id, :workspace_mismatch),
         :ok <- match_attr(metadata, attrs, :machine_id, :machine_mismatch) do
      {:ok, metadata}
    end
  end

  defp normalize_metadata(metadata) when is_map(metadata) do
    metadata
    |> Enum.map(fn {key, value} -> {normalize_key(key), value} end)
    |> Map.new()
  end

  defp normalize_key("workspace_id"), do: :workspace_id
  defp normalize_key("machine_id"), do: :machine_id
  defp normalize_key("token_id"), do: :token_id
  defp normalize_key("runner_kinds"), do: :runner_kinds
  defp normalize_key("revoked?"), do: :revoked?
  defp normalize_key("revoked"), do: :revoked?
  defp normalize_key(key) when is_binary(key), do: key
  defp normalize_key(key), do: key

  defp match_attr(metadata, attrs, key, reason) do
    expected = Map.get(metadata, key)
    actual = Map.get(attrs, key)

    cond do
      not is_binary(expected) or expected == "" -> :ok
      not is_binary(actual) or actual == "" -> :ok
      expected == actual -> :ok
      true -> {:error, reason}
    end
  end
end
