defmodule SymphonyElixir.WorkerBridge.SecretResolver do
  @moduledoc """
  Resolves worker-bridge credential material from either inline values or secret references.
  """

  alias SymphonyElixir.AgentInventory.StoredCredential

  @type resolver_fun :: (String.t(), [String.t()] -> {:ok, String.t()} | {:error, term()})

  @spec resolve(StoredCredential.t()) :: {:ok, %{String.t() => String.t()}} | {:error, term()}
  def resolve(%StoredCredential{env_var: env_var, secret_value: value})
      when is_binary(env_var) and is_binary(value) and value != "" do
    {:ok, %{env_var => value}}
  end

  def resolve(%StoredCredential{env_var: env_var, secret_ref: secret_ref, aliases: aliases})
      when is_binary(env_var) and is_binary(secret_ref) and secret_ref != "" do
    case resolver().(secret_ref, aliases) do
      {:ok, value} when is_binary(value) and value != "" ->
        {:ok, %{env_var => value}}

      {:ok, _value} ->
        {:error, :credential_secret_missing}

      {:error, reason} ->
        {:error, reason}
    end
  end

  def resolve(_credential), do: {:error, :credential_secret_missing}

  defp resolver do
    Application.get_env(
      :symphony_elixir,
      :worker_bridge_secret_ref_resolver,
      &default_resolve_secret_ref/2
    )
  end

  defp default_resolve_secret_ref(secret_ref, aliases) do
    case System.find_executable("aws") do
      nil ->
        {:error, :aws_cli_not_found}

      _path ->
        case System.cmd(
               "aws",
               ["secretsmanager", "get-secret-value", "--secret-id", secret_ref, "--output", "json"],
               stderr_to_stdout: true
             ) do
          {output, 0} ->
            extract_secret_value(output, aliases)

          {output, status} ->
            {:error, {:secret_ref_resolution_failed, status, String.trim(output)}}
        end
    end
  end

  defp extract_secret_value(payload, aliases) when is_binary(payload) do
    with {:ok, decoded} <- Jason.decode(payload),
         %{"SecretString" => secret_string} when is_binary(secret_string) <- decoded do
      decode_secret_string(secret_string, aliases)
    else
      {:error, reason} -> {:error, {:invalid_secret_manager_payload, reason}}
      _ -> {:error, :secret_string_missing}
    end
  end

  defp decode_secret_string(secret_string, aliases) do
    trimmed = String.trim(secret_string)

    case Jason.decode(trimmed) do
      {:ok, value} when is_binary(value) and value != "" ->
        {:ok, value}

      {:ok, record} when is_map(record) ->
        extract_from_record(record, aliases)

      {:ok, _other} ->
        {:error, :credential_secret_missing}

      {:error, _reason} ->
        if trimmed == "", do: {:error, :credential_secret_missing}, else: {:ok, trimmed}
    end
  end

  defp extract_from_record(record, aliases) do
    Enum.find_value(aliases ++ ["value", "secret", "api_key"], {:error, :credential_secret_missing}, fn key ->
      case Map.get(record, key) do
        value when is_binary(value) and value != "" -> {:ok, String.trim(value)}
        _ -> false
      end
    end)
  end
end
