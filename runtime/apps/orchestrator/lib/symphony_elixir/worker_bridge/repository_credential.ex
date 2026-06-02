defmodule SymphonyElixir.WorkerBridge.RepositoryCredential do
  @moduledoc """
  Resolves repository-scoped credentials for worker bridge materialization.

  The resolved token is only returned to the repository manager for `git`
  execution environment injection. Public session metadata and logs should carry
  credential references, never token values.
  """

  alias SymphonyElixir.AgentInventory.StoredCredential
  alias SymphonyElixir.WorkerBridge.SecretResolver

  @type t :: %__MODULE__{
          token: String.t(),
          username: String.t(),
          source: String.t(),
          ref: String.t() | nil
        }

  defstruct [:token, username: "x-access-token", source: "unknown", ref: nil]

  @spec resolve(map()) :: {:ok, t() | nil} | {:error, term()}
  def resolve(repository) when is_map(repository) do
    with :ok <- production_gate(repository),
         {:ok, spec} <- credential_spec(repository) do
      resolve_spec(spec)
    end
  end

  def resolve(_repository), do: {:error, :invalid_repository}

  defp credential_spec(repository) do
    cond do
      is_map(Map.get(repository, "credential")) ->
        {:ok, Map.get(repository, "credential")}

      is_map(Map.get(repository, "credential_ref")) ->
        {:ok, Map.get(repository, "credential_ref")}

      is_map(Map.get(repository, "resource_grant")) ->
        grant = Map.get(repository, "resource_grant")

        cond do
          is_map(Map.get(grant, "credential")) -> {:ok, Map.get(grant, "credential")}
          is_map(Map.get(grant, "credential_ref")) -> {:ok, Map.get(grant, "credential_ref")}
          true -> {:ok, nil}
        end

      true ->
        {:ok, nil}
    end
  end

  defp resolve_spec(nil), do: {:ok, nil}

  defp resolve_spec(%{"source" => "inline"} = spec) do
    with {:ok, token} <- token_from_spec(spec) do
      {:ok, build(spec, token)}
    end
  end

  defp resolve_spec(%{"source" => "env", "name" => env_name} = spec) when is_binary(env_name) do
    case System.get_env(env_name) do
      token when is_binary(token) and token != "" ->
        {:ok, build(spec, token, "env:#{env_name}")}

      _ ->
        {:error, {:missing_repository_credential_env, env_name}}
    end
  end

  defp resolve_spec(%{"source" => "secret_ref", "ref" => secret_ref} = spec)
       when is_binary(secret_ref) and secret_ref != "" do
    credential = %StoredCredential{
      env_var: "GIT_TOKEN",
      secret_ref: secret_ref,
      aliases: aliases(spec)
    }

    case SecretResolver.resolve(credential) do
      {:ok, %{"GIT_TOKEN" => token}} -> {:ok, build(spec, token, secret_ref)}
      {:error, reason} -> {:error, reason}
    end
  end

  defp resolve_spec(%{"source" => "github_app_installation_token"} = spec) do
    with {:ok, token} <- token_from_spec(spec) do
      {:ok, build(spec, token)}
    end
  end

  defp resolve_spec(%{"type" => "github_app_installation_token"} = spec) do
    with {:ok, token} <- token_from_spec(spec) do
      {:ok, build(Map.put(spec, "source", "github_app_installation_token"), token)}
    end
  end

  defp resolve_spec(%{"token" => token} = spec) when is_binary(token) and token != "" do
    {:ok, build(Map.put_new(spec, "source", "inline"), token)}
  end

  defp resolve_spec(%{"value" => token} = spec) when is_binary(token) and token != "" do
    {:ok, build(Map.put_new(spec, "source", "inline"), token)}
  end

  defp resolve_spec(%{"source" => source}), do: {:error, {:unsupported_repository_credential_source, source}}
  defp resolve_spec(_spec), do: {:error, :invalid_repository_credential}

  defp token_from_spec(spec) do
    case Map.get(spec, "token") || Map.get(spec, "value") do
      token when is_binary(token) and token != "" -> {:ok, token}
      _ -> {:error, :repository_credential_missing}
    end
  end

  defp build(spec, token, ref \\ nil) do
    %__MODULE__{
      token: token,
      username: username(spec),
      source: Map.get(spec, "source", "unknown"),
      ref: Map.get(spec, "ref") || Map.get(spec, "id") || ref
    }
  end

  defp username(spec) do
    case Map.get(spec, "username") do
      username when is_binary(username) and username != "" -> username
      _ -> "x-access-token"
    end
  end

  defp aliases(spec) do
    case Map.get(spec, "aliases") do
      aliases when is_list(aliases) -> Enum.filter(aliases, &(is_binary(&1) and &1 != ""))
      _ -> ["token", "access_token", "github_token"]
    end
  end

  defp production_gate(repository) do
    if has_repository_credential?(repository) and production?() and not resource_authorization_enforced?() do
      {:error, :resource_authorization_required_for_private_repository_credentials}
    else
      :ok
    end
  end

  defp has_repository_credential?(repository) do
    is_map(Map.get(repository, "credential")) or
      is_map(Map.get(repository, "credential_ref")) or
      (is_map(Map.get(repository, "resource_grant")) and
         (is_map(get_in(repository, ["resource_grant", "credential"])) or
            is_map(get_in(repository, ["resource_grant", "credential_ref"]))))
  end

  defp production? do
    config_env() == :prod
  end

  defp config_env do
    Application.get_env(:symphony_elixir, :runtime_env) ||
      Application.get_env(:symphony_elixir, :env) ||
      system_env()
  end

  defp system_env do
    case System.get_env("MIX_ENV") do
      value when is_binary(value) and value != "" -> String.to_atom(value)
      _ -> :dev
    end
  end

  defp resource_authorization_enforced? do
    Application.get_env(:symphony_elixir, :resource_authorization_enforced, false) == true or
      System.get_env("SYMPHONY_RESOURCE_AUTHORIZATION_ENFORCED") in ["1", "true", "TRUE"]
  end
end
