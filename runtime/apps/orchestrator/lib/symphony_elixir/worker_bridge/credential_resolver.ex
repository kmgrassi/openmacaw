defmodule SymphonyElixir.WorkerBridge.CredentialResolver do
  @moduledoc """
  Resolves worker bridge credential specs into environment variables.

  The initial bridge supports:

  - inline values supplied in the API request
  - references to existing environment variables on the launcher host

  Secret-manager-backed resolution is intentionally left for a follow-up adapter.
  """

  @type spec_map :: %{
          optional(String.t()) => String.t() | %{optional(String.t()) => term()}
        }

  @spec resolve(spec_map()) :: {:ok, %{optional(String.t()) => String.t()}} | {:error, term()}
  def resolve(credentials) when credentials in [%{}, nil], do: {:ok, %{}}

  def resolve(credentials) when is_map(credentials) do
    Enum.reduce_while(credentials, {:ok, %{}}, fn {env_var, spec}, {:ok, resolved} ->
      case resolve_one(env_var, spec) do
        {:ok, value} ->
          {:cont, {:ok, Map.put(resolved, env_var, value)}}

        {:error, reason} ->
          {:halt, {:error, reason}}
      end
    end)
  end

  def resolve(_credentials), do: {:error, :invalid_credentials}

  defp resolve_one(env_var, value) when is_binary(env_var) and is_binary(value) and env_var != "" do
    {:ok, value}
  end

  defp resolve_one(env_var, %{"source" => "inline", "value" => value})
       when is_binary(env_var) and is_binary(value) and env_var != "" do
    {:ok, value}
  end

  defp resolve_one(env_var, %{"source" => "env", "name" => source_env})
       when is_binary(env_var) and is_binary(source_env) and env_var != "" do
    case System.get_env(source_env) do
      value when is_binary(value) and value != "" ->
        {:ok, value}

      _ ->
        {:error, {:missing_env_credential, env_var, source_env}}
    end
  end

  defp resolve_one(env_var, %{"source" => source}) when is_binary(env_var) and env_var != "" do
    {:error, {:unsupported_credential_source, env_var, source}}
  end

  defp resolve_one(env_var, _spec) when is_binary(env_var) and env_var != "" do
    {:error, {:invalid_credential_spec, env_var}}
  end

  defp resolve_one(_env_var, _spec), do: {:error, :invalid_credential_name}
end
