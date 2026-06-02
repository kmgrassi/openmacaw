defmodule SymphonyElixir.AgentInventory.Database do
  @moduledoc """
  Supabase/PostgREST-backed agent inventory adapter.

  Configuration is read from `Application.get_env(:symphony_elixir, :agent_inventory, ...)`:

      config :symphony_elixir, :agent_inventory,
        endpoint: "https://xyz.supabase.co/rest/v1",
        api_key: System.get_env("SUPABASE_SERVICE_KEY"),
        table: "agents"
  """

  @behaviour SymphonyElixir.AgentInventory

  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.AgentInventory.StoredCredential
  alias SymphonyElixir.PostgRESTClient
  alias SymphonyElixir.Supabase
  alias SymphonyElixir.SupabaseSchema

  @spec list_agents() :: {:ok, [Agent.t()]} | {:error, term()}
  def list_agents do
    with {:ok, config} <- inventory_config() do
      query =
        %{
          "select" => SupabaseSchema.select_columns!("agent"),
          "order" => "updated_at.desc.nullslast"
        }

      case PostgRESTClient.get(client(config), config.table, query,
             log_metadata: log_metadata("agent_inventory.list_agents", config.table)
           ) do
        {:ok, rows} when is_list(rows) ->
          with :ok <- SupabaseSchema.validate_rows("agent", rows) do
            workspace_ids =
              rows
              |> Enum.map(&Map.get(&1, "workspace_id"))
              |> Enum.filter(&(is_binary(&1) and &1 != ""))

            credential_workspace_ids = credential_workspace_ids(workspace_ids, config)

            {:ok,
             Enum.map(rows, fn row ->
               Agent.from_row(row, has_credentials: Map.get(row, "workspace_id") in credential_workspace_ids)
             end)}
          end

        {:ok, _body} ->
          {:error, :invalid_response}

        {:error, _reason} = error ->
          error
      end
    end
  end

  @spec get_agent(String.t()) :: {:ok, Agent.t()} | {:error, term()}
  def get_agent(agent_id) when is_binary(agent_id) and agent_id != "" do
    with {:ok, config} <- inventory_config() do
      query =
        %{
          "id" => "eq.#{agent_id}",
          "select" => SupabaseSchema.select_columns!("agent"),
          "limit" => "1"
        }

      case PostgRESTClient.get(client(config), config.table, query,
             log_metadata:
               log_metadata("agent_inventory.get_agent", config.table, agent_id: agent_id)
           ) do
        {:ok, [row]} ->
          with :ok <- SupabaseSchema.validate_row("agent", row) do
            has_credentials = Map.get(row, "workspace_id") in credential_workspace_ids([Map.get(row, "workspace_id")], config)

            {:ok, Agent.from_row(row, has_credentials: has_credentials)}
          end

        {:ok, []} ->
          {:error, :not_found}

        {:ok, _rows} ->
          {:error, :invalid_response}

        {:error, _reason} = error ->
          error
      end
    end
  end

  def get_agent(_agent_id), do: {:error, :invalid_agent_id}

  @spec list_credentials(String.t()) :: {:ok, [StoredCredential.t()]} | {:error, term()}
  def list_credentials(agent_id) when is_binary(agent_id) and agent_id != "" do
    with {:ok, config} <- inventory_config(),
         {:ok, workspace_id} <- agent_workspace_id(agent_id, config) do
      query =
        %{
          "select" => SupabaseSchema.select_columns!("credential"),
          "workspace_id" => "eq.#{workspace_id}",
          "order" => "updated_at.desc"
        }

      case PostgRESTClient.get(client(config), config.credential_table, query,
             log_metadata:
               log_metadata("agent_inventory.list_credentials", config.credential_table,
                 agent_id: agent_id,
                 workspace_id: workspace_id
               )
           ) do
        {:ok, rows} when is_list(rows) ->
          with :ok <- SupabaseSchema.validate_rows("credential", rows) do
            {:ok, rows |> Enum.flat_map(&to_stored_credentials(&1, agent_id))}
          end

        {:ok, _body} ->
          {:error, :invalid_response}

        {:error, _reason} = error ->
          error
      end
    end
  end

  def list_credentials(_agent_id), do: {:error, :invalid_agent_id}

  @doc false
  def req_options, do: Application.get_env(:symphony_elixir, :agent_inventory_req_options, [])

  defp client(config), do: PostgRESTClient.new(config, req_options())

  defp inventory_config do
    config =
      Application.get_env(:symphony_elixir, :agent_inventory, [])
      |> Enum.into(%{})
      |> Map.put_new(:table, "agent")
      |> Map.put_new(:credential_table, "credential")

    config
    |> Supabase.merge_connection!()
    |> validate_table(:table)
    |> validate_table(:credential_table)
  rescue
    error in [ArgumentError] ->
      {:error, {:missing_supabase_config, Exception.message(error)}}
  end

  defp validate_table({:error, _reason} = error, _key), do: error

  defp validate_table({:ok, config}, key), do: validate_table(config, key)

  defp validate_table(config, key) do
    case Map.fetch!(config, key) do
      table when is_binary(table) and table != "" ->
        {:ok, config}

      table ->
        {:error, {:invalid_agent_inventory_config, "agent_inventory #{key} must be a non-empty string, got: #{inspect(table)}"}}
    end
  end

  @spec agent_workspace_id(String.t(), map()) :: {:ok, String.t()} | {:error, term()}
  defp agent_workspace_id(agent_id, config) do
    query =
      %{
        "id" => "eq.#{agent_id}",
        "select" => SupabaseSchema.select_columns!("agent", ["workspace_id"]),
        "limit" => "1"
      }

    case PostgRESTClient.get(client(config), config.table, query,
           log_metadata:
             log_metadata("agent_inventory.agent_workspace_id", config.table, agent_id: agent_id)
         ) do
      {:ok, [%{"workspace_id" => workspace_id}]} when is_binary(workspace_id) and workspace_id != "" ->
        {:ok, workspace_id}

      {:ok, [%{workspace_id: workspace_id}]} when is_binary(workspace_id) and workspace_id != "" ->
        {:ok, workspace_id}

      {:ok, []} ->
        {:error, :not_found}

      {:ok, _rows} ->
        {:error, :invalid_response}

      {:error, _reason} = error ->
        error
    end
  end

  @spec credential_workspace_ids([String.t()], map()) :: [String.t()]
  defp credential_workspace_ids([], _config), do: []

  defp credential_workspace_ids(workspace_ids, config) do
    workspace_ids =
      workspace_ids
      |> Enum.filter(&(is_binary(&1) and &1 != ""))
      |> Enum.uniq()

    if workspace_ids == [] do
      []
    else
      fetch_credential_workspace_ids(workspace_ids, config)
    end
  end

  defp fetch_credential_workspace_ids(workspace_ids, config) do
    query =
      %{
        "select" => SupabaseSchema.select_columns!("credential", ["workspace_id"]),
        "workspace_id" => "in.(#{Enum.join(workspace_ids, ",")})"
      }

    case PostgRESTClient.get(client(config), config.credential_table, query,
           log_metadata:
             log_metadata("agent_inventory.credential_workspace_ids", config.credential_table)
         ) do
      {:ok, rows} when is_list(rows) ->
        case SupabaseSchema.validate_rows("credential", rows, ["workspace_id"]) do
          :ok ->
            rows
            |> Enum.map(&Map.get(&1, "workspace_id"))
            |> Enum.filter(&(is_binary(&1) and &1 != ""))
            |> Enum.uniq()

          {:error, _reason} ->
            []
        end

      _ ->
        []
    end
  end

  defp to_stored_credentials(row, agent_id) when is_map(row) do
    raw = map_value(row, "key_value")

    provider = detect_credential_provider(raw)
    key_last4 = string_value(raw, "key_last4")

    [
      %{
        env_var: "OPENAI_API_KEY",
        label: (key_last4 && "OpenAI API key ••••#{key_last4}") || "OpenAI API key",
        aliases: ["OPENAI_API_KEY", "openai_api_key", "api_key"],
        launchable_kind: (provider == "openai" && "codex") || nil,
        requires_provider: nil,
        secret_ref_for_provider: "openai"
      },
      %{
        env_var: "ANTHROPIC_API_KEY",
        label: (key_last4 && "Anthropic API key ••••#{key_last4}") || "Anthropic API key",
        aliases: ["ANTHROPIC_API_KEY", "anthropic_api_key"],
        launchable_kind: nil,
        requires_provider: nil,
        secret_ref_for_provider: nil
      },
      %{
        env_var: "OPENAI_API_KEY",
        label: chatgpt_oauth_label(raw),
        aliases: ["access_token"],
        launchable_kind: "codex",
        requires_provider: "openai_codex",
        secret_ref_for_provider: "openai_codex"
      }
    ]
    |> Enum.flat_map(fn mapping ->
      has_secret = has_inline_secret?(raw, mapping.aliases)
      has_secret_reference = is_binary(string_value(raw, "secret_ref"))

      provider_ok = mapping.requires_provider == nil or provider == mapping.requires_provider

      secret_ref_ok =
        has_secret_reference and mapping.secret_ref_for_provider != nil and
          provider == mapping.secret_ref_for_provider

      should_include = provider_ok and (has_secret or secret_ref_ok)

      if should_include do
        [
          %StoredCredential{
            id: "#{Map.get(row, "id")}:#{mapping.env_var}",
            agent_id: agent_id,
            workspace_id: Map.get(row, "workspace_id"),
            provider: provider,
            label: mapping.label,
            env_var: mapping.env_var,
            updated_at: Map.get(row, "updated_at"),
            launchable_kind: mapping.launchable_kind,
            has_secret: has_secret or has_secret_reference,
            secret_value: detect_inline_secret(raw, mapping.aliases),
            secret_ref: (has_secret_reference && String.trim(string_value(raw, "secret_ref"))) || nil,
            aliases: mapping.aliases
          }
        ]
      else
        []
      end
    end)
  end

  defp chatgpt_oauth_label(raw) when is_map(raw) do
    email = string_value(raw, "email")
    plan = string_value(raw, "plan_type")

    cond do
      is_binary(email) and email != "" and is_binary(plan) and plan != "" -> "ChatGPT (#{email}, #{plan})"
      is_binary(email) and email != "" -> "ChatGPT (#{email})"
      true -> "ChatGPT account"
    end
  end

  defp chatgpt_oauth_label(_raw), do: "ChatGPT account"

  defp log_metadata(caller, table, extra \\ []) do
    extra
    |> Map.new()
    |> Map.merge(%{caller: caller, action: caller, table: table})
    |> Map.reject(fn {_key, value} -> value in [nil, ""] end)
  end

  defp detect_credential_provider(raw) when is_map(raw) do
    provider = string_value(raw, "provider")

    cond do
      is_binary(provider) and provider != "" -> String.downcase(provider)
      is_binary(string_value(raw, "OPENAI_API_KEY")) or is_binary(string_value(raw, "openai_api_key")) -> "openai"
      is_binary(string_value(raw, "ANTHROPIC_API_KEY")) or is_binary(string_value(raw, "anthropic_api_key")) -> "anthropic"
      true -> nil
    end
  end

  defp detect_credential_provider(_raw), do: nil

  defp has_inline_secret?(raw, aliases) when is_map(raw) do
    Enum.any?(aliases, fn alias_name ->
      value = string_value(raw, alias_name)
      is_binary(value) and value != ""
    end)
  end

  defp has_inline_secret?(_raw, _aliases), do: false

  defp detect_inline_secret(raw, aliases) when is_map(raw) do
    Enum.find_value(aliases, fn alias_name ->
      value = string_value(raw, alias_name)
      if is_binary(value) and value != "", do: String.trim(value), else: nil
    end)
  end

  defp detect_inline_secret(_raw, _aliases), do: nil

  defp map_value(map, key) do
    value = Map.get(map, key) || Map.get(map, String.to_atom(key))
    if is_map(value), do: value, else: %{}
  rescue
    ArgumentError -> %{}
  end

  defp string_value(map, key) do
    Map.get(map, key) || Map.get(map, String.to_atom(key))
  rescue
    ArgumentError -> nil
  end
end
