defmodule SymphonyElixir.Planner.DatabaseTools.Payloads do
  @moduledoc false

  alias SymphonyElixir.Config
  alias SymphonyElixir.Planner.DatabaseTools.Arguments
  alias SymphonyElixir.Routing.IntentVocabulary
  alias SymphonyElixir.Schema.ExecutionProfile

  @task_label_rules [
    {"docs", ["doc", "docs", "documentation", "readme"]},
    {"test", ["test", "tests", "spec", "coverage"]},
    {"frontend", ["frontend", "ui", "react", "browser"]},
    {"runtime", ["runtime", "orchestrator", "launcher"]}
  ]

  @spec optional_runner_kind(map()) :: {:ok, String.t() | nil} | {:error, tuple()}
  def optional_runner_kind(args) do
    case Arguments.optional_value(args, "runner_kind") do
      nil ->
        {:ok, nil}

      value when is_binary(value) ->
        if value in ExecutionProfile.supported_runner_kinds() do
          {:ok, value}
        else
          {:error, {:invalid_argument, "runner_kind", "must be a supported runner kind"}}
        end

      _ ->
        {:error, {:invalid_argument, "runner_kind", "must be a string"}}
    end
  end

  @spec task_schedule_payload(map()) :: {:ok, map()} | {:error, tuple()}
  def task_schedule_payload(args) do
    with :ok <- Arguments.require_present(args, "next_poll_at"),
         {:ok, next_poll_at} <- Arguments.nullable_iso8601(args, "next_poll_at"),
         {:ok, poll_cadence_seconds} <- Arguments.optional_positive_integer(args, "poll_cadence_seconds") do
      payload =
        %{"next_poll_at" => next_poll_at}
        |> Arguments.maybe_put_optional("poll_cadence_seconds", poll_cadence_seconds)

      {:ok, payload}
    end
  end

  @spec plan_create_payload(map(), String.t(), String.t(), keyword()) :: {:ok, map()} | {:error, tuple()}
  def plan_create_payload(args, workspace_id, name, opts) do
    with {:ok, metadata} <- plan_metadata(args) do
      default_repository = Arguments.optional_value(args, "default_repository") || default_repository(opts)
      default_runner_kind = Arguments.optional_value(args, "default_runner_kind") || default_runner_kind(opts)

      payload =
        %{"workspace_id" => workspace_id, "name" => name}
        |> Arguments.put_optional(args, "description")
        |> Arguments.put_optional(args, "type")
        |> Arguments.put_optional(args, "is_ongoing")
        |> Arguments.put_optional(args, "intent")
        |> Arguments.put_optional(args, "default_model")
        |> Arguments.maybe_put_optional("default_runner_kind", default_runner_kind)
        |> Arguments.maybe_put_optional(
          "metadata",
          metadata
          |> Arguments.maybe_put_optional("default_repository", default_repository)
          |> metadata_if_present()
        )

      {:ok, payload}
    end
  end

  @spec task_create_payload(map(), String.t(), String.t(), map() | nil, keyword()) ::
          {:ok, map()} | {:error, tuple()}
  def task_create_payload(args, workspace_id, name, plan_row, opts) do
    with :ok <- validate_routing_conflicts(args),
         {:ok, runner_kind} <- optional_runner_kind(args),
         {:ok, repository} <- Arguments.optional_string(args, "repository"),
         {:ok, poll_cadence_seconds} <- Arguments.optional_positive_integer(args, "poll_cadence_seconds"),
         {:ok, author_task_id} <- Arguments.optional_string(args, "author_task_id"),
         {:ok, metadata} <- planner_metadata(args, "task.create", plan_row, opts) do
      metadata =
        metadata
        |> Arguments.maybe_put_optional("runner_kind", runner_kind)
        |> Arguments.maybe_put_optional("repository", repository)
        |> Arguments.maybe_put_optional("author_task_id", author_task_id)

      routing_runner_kind = Arguments.optional_value(metadata, "runner_kind")
      routing_repository = Arguments.optional_value(metadata, "repository") || Arguments.optional_value(metadata, "repository_id")

      payload =
        %{
          "workspace_id" => workspace_id,
          "title" => name,
          "instructions" => task_instructions(args, name),
          "state" => task_state(args),
          "source" => "planner",
          "metadata" => metadata
        }
        |> Arguments.put_optional_non_blank(args, "plan_id")
        |> Arguments.maybe_put_optional("runner_kind", routing_runner_kind)
        |> Arguments.maybe_put_optional("repository", routing_repository)
        |> Arguments.put_optional(args, "description")
        |> Arguments.put_optional(args, "priority")
        |> Arguments.maybe_put_optional("labels", Arguments.optional_value(args, "labels") || inferred_labels(args))
        |> Arguments.put_optional(args, "depends_on")
        |> Arguments.maybe_put_optional("completion_gates", task_completion_gates(args, plan_row, opts))
        |> Arguments.put_optional(args, "next_poll_at")
        |> Arguments.maybe_put_optional("poll_cadence_seconds", poll_cadence_seconds)
        |> Arguments.put_optional(args, "manager_runner_id")
        |> Arguments.put_optional(args, "not_before_at")
        |> Arguments.put_optional(args, "scheduled_reason")
        |> Arguments.put_optional(args, "scheduled_by_user_id")

      {:ok, payload}
    end
  end

  @spec default_task_create_args(map(), map() | nil, keyword()) :: {:ok, map(), [map()]} | {:error, tuple()}
  def default_task_create_args(args, plan_row, opts) do
    with :ok <- validate_repository_default(args, plan_row, opts),
         {:ok, args} <- normalize_task_when(args) do
      {args, feedback} = default_name(args)

      if present_string?(Map.get(args, "name")) do
        {:ok, args, feedback}
      else
        {:error,
         {:validation_failed,
          validation_feedback(
            "missing_name",
            "name",
            "Task name is required when no title, description, or instructions can provide a safe default.",
            true,
            nil,
            true
          )}}
      end
    end
  end

  defp normalize_task_when(args) do
    case Arguments.optional_value(args, "when") do
      nil ->
        {:ok, args}

      %{} = timing ->
        normalize_task_when_map(args, timing)

      _ ->
        {:error, {:invalid_argument, "when", "must be an object"}}
    end
  end

  defp normalize_task_when_map(args, timing) do
    mode = Arguments.optional_value(timing, "mode") || Arguments.optional_value(timing, "kind")
    state = Arguments.optional_value(timing, "state") || "running"

    with {:ok, state} <- manager_pickup_state(state) do
      case mode do
        "planned" ->
          {:ok, args}

        "now" ->
          {:ok, put_manager_pickup(args, state, DateTime.utc_now() |> DateTime.to_iso8601())}

        "at" ->
          with {:ok, at} <- Arguments.nullable_iso8601(timing, "at"),
               {:ok, at} <- require_when_at(at) do
            {:ok, put_manager_pickup(args, state, at)}
          end

        _ ->
          {:error, {:invalid_argument, "when.mode", "must be planned, now, or at"}}
      end
    end
  end

  defp manager_pickup_state(state) when state in ["running", "awaiting_review"], do: {:ok, state}
  defp manager_pickup_state(_state), do: {:error, {:invalid_argument, "when.state", "must be running or awaiting_review"}}

  defp require_when_at(value) when is_binary(value), do: {:ok, value}
  defp require_when_at(_value), do: {:error, {:missing_argument, "when.at"}}

  defp put_manager_pickup(args, state, next_poll_at) do
    args
    |> Map.put("state", state)
    |> Map.put("next_poll_at", next_poll_at)
  end

  defp default_name(args) do
    cond do
      present_string?(Map.get(args, "name")) ->
        {args, []}

      present_string?(Map.get(args, "title")) ->
        title = Map.get(args, "title") |> String.trim()
        {Map.put(args, "name", title), [validation_feedback("defaulted_name", "name", "Derived task name from title.", true, title, false)]}

      default = default_name_from_text(Arguments.optional_value(args, "description") || Arguments.optional_value(args, "instructions")) ->
        {Map.put(args, "name", default), [validation_feedback("defaulted_name", "name", "Derived task name from task context.", true, default, false)]}

      true ->
        {args, []}
    end
  end

  defp default_name_from_text(text) when is_binary(text) do
    text
    |> String.trim()
    |> String.split(~r/[\.\n]/, parts: 2)
    |> List.first()
    |> case do
      value when is_binary(value) ->
        value
        |> String.trim()
        |> truncate_title()
        |> case do
          "" -> nil
          title -> title
        end

      _ ->
        nil
    end
  end

  defp default_name_from_text(_text), do: nil

  defp truncate_title(title), do: title |> String.slice(0, 80) |> String.trim()

  defp validate_repository_default(args, plan_row, opts) do
    candidates = repository_candidates(opts)

    cond do
      Arguments.optional_value(args, "repository") ->
        :ok

      inherited_plan_repository(plan_row) || default_repository(opts) ->
        :ok

      length(candidates) > 1 ->
        {:error,
         {:validation_failed,
          validation_feedback(
            "ambiguous_repository",
            "repository",
            "Multiple repository candidates are available; choose the intended repository before creating routed work.",
            true,
            nil,
            true
          )}}

      true ->
        :ok
    end
  end

  defp repository_candidates(opts) do
    opts
    |> Arguments.option_value(:repository_candidates)
    |> List.wrap()
    |> Enum.filter(&present_string?/1)
    |> Enum.uniq()
  end

  defp validate_routing_conflicts(args) do
    top_level_runner_kind = Arguments.optional_value(args, "runner_kind")
    routing_runner_kind = routing_runner_kind(args)

    if present_string?(top_level_runner_kind) and present_string?(routing_runner_kind) and
         top_level_runner_kind != routing_runner_kind do
      {:error,
       {:validation_failed,
        validation_feedback(
          "conflicting_runner_kind",
          "runner_kind",
          "Top-level runner_kind conflicts with routing.runner_kind.",
          false,
          top_level_runner_kind,
          false
        )}}
    else
      :ok
    end
  end

  @spec planner_metadata(map(), String.t(), map() | nil, keyword()) :: {:ok, map()} | {:error, tuple()}
  def planner_metadata(args, tool, plan_row, opts) do
    with {:ok, metadata} <- optional_metadata(args),
         {:ok, routing} <- optional_routing(args) do
      metadata =
        metadata
        |> maybe_put_inherited_runner_kind(inherited_plan_runner_kind(plan_row))
        |> maybe_put_inherited_runner_kind(default_runner_kind(opts))
        |> maybe_put_inherited_repository(inherited_plan_repository(plan_row))
        |> maybe_put_inherited_repository(default_repository(opts))
        |> maybe_put_routing(routing)
        |> Map.merge(default_planner_metadata(tool))

      {:ok, metadata}
    end
  end

  defp task_instructions(args, name) do
    Arguments.optional_value(args, "instructions") || Arguments.optional_value(args, "description") || name
  end

  defp task_state(args),
    do: Arguments.optional_value(args, "state") || Arguments.optional_value(args, "status") || "todo"

  defp plan_metadata(args) do
    with {:ok, metadata} <- optional_metadata(args) do
      metadata =
        metadata
        |> Arguments.maybe_put_optional("default_repository", Arguments.optional_value(args, "default_repository"))

      {:ok, metadata}
    end
  end

  defp metadata_if_present(metadata) when map_size(metadata) == 0, do: nil
  defp metadata_if_present(metadata), do: metadata

  defp inherited_plan_repository(nil), do: nil

  defp inherited_plan_repository(plan_row) when is_map(plan_row) do
    metadata =
      case Map.get(plan_row, "metadata") do
        metadata when is_map(metadata) -> metadata
        _ -> %{}
      end

    Arguments.optional_value(plan_row, "default_repository") || Arguments.optional_value(metadata, "default_repository")
  end

  defp inherited_plan_runner_kind(nil), do: nil
  defp inherited_plan_runner_kind(plan_row) when is_map(plan_row), do: Arguments.optional_value(plan_row, "default_runner_kind")

  defp task_completion_gates(args, plan_row, opts) do
    Arguments.optional_value(args, "completion_gates") ||
      inherited_plan_completion_gates(plan_row) ||
      Arguments.option_value(opts, :default_completion_gates)
  end

  defp inherited_plan_completion_gates(nil), do: nil

  defp inherited_plan_completion_gates(plan_row) when is_map(plan_row) do
    metadata =
      case Map.get(plan_row, "metadata") do
        metadata when is_map(metadata) -> metadata
        _ -> %{}
      end

    Arguments.optional_value(plan_row, "default_completion_gates") ||
      Arguments.optional_value(metadata, "default_completion_gates")
  end

  defp default_planner_metadata(tool) do
    %{"created_via" => "planner_task_tool", "planner_tool" => tool}
  end

  defp optional_metadata(args) do
    case Arguments.optional_value(args, "metadata") do
      nil -> {:ok, %{}}
      metadata when is_map(metadata) -> {:ok, metadata}
      _ -> {:error, {:invalid_argument, "metadata", "must be an object"}}
    end
  end

  defp optional_routing(args) do
    case Arguments.optional_value(args, "routing") do
      nil -> {:ok, nil}
      routing when is_map(routing) -> validate_routing(routing)
      _ -> {:error, {:invalid_argument, "routing", "must be an object"}}
    end
  end

  defp validate_routing(routing) do
    with :ok <- validate_optional_enum(routing, "intent", IntentVocabulary.intents()),
         :ok <- validate_optional_enum(routing, "runner_kind", ExecutionProfile.supported_runner_kinds()) do
      {:ok, routing}
    end
  end

  defp validate_optional_enum(map, key, allowed_values) do
    case Arguments.optional_value(map, key) do
      nil -> :ok
      value when is_binary(value) -> if(value in allowed_values, do: :ok, else: invalid_enum(key, allowed_values))
      _ -> {:error, {:invalid_argument, key, "must be a string"}}
    end
  end

  defp invalid_enum(key, allowed_values), do: {:error, {:invalid_argument, key, "must be one of #{Enum.join(allowed_values, ", ")}"}}

  defp routing_runner_kind(args) do
    metadata_routing =
      case Arguments.optional_value(args, "metadata") do
        %{} = metadata -> Arguments.optional_value(metadata, "routing")
        _ -> nil
      end

    routing =
      case Arguments.optional_value(args, "routing") || metadata_routing do
        %{} = routing -> routing
        _ -> %{}
      end

    Arguments.optional_value(routing, "runner_kind")
  end

  defp maybe_put_routing(metadata, nil), do: metadata
  defp maybe_put_routing(metadata, routing), do: Map.put(metadata, "routing", routing)

  defp maybe_put_inherited_runner_kind(metadata, nil), do: metadata

  defp maybe_put_inherited_runner_kind(metadata, runner_kind) do
    if Arguments.optional_value(metadata, "runner_kind") do
      metadata
    else
      Map.put(metadata, "runner_kind", runner_kind)
    end
  end

  defp maybe_put_inherited_repository(metadata, nil), do: metadata

  defp maybe_put_inherited_repository(metadata, repository) do
    if Arguments.optional_value(metadata, "repository") || Arguments.optional_value(metadata, "repository_id") do
      metadata
    else
      Map.put(metadata, "repository", repository)
    end
  end

  defp default_repository(opts) do
    Arguments.option_value(opts, :default_repository) ||
      Arguments.option_value(opts, :repository) ||
      configured_repository() ||
      workspace_repository(opts)
  end

  defp default_runner_kind(opts) do
    opts
    |> Arguments.option_value(:default_runner_kind)
    |> supported_runner_kind_or_nil()
    |> case do
      nil -> configured_default_runner_kind()
      runner_kind -> runner_kind
    end
  end

  defp configured_default_runner_kind do
    case Config.settings() do
      {:ok, settings} ->
        settings.runners.default
        |> supported_runner_kind_or_nil()

      {:error, _reason} ->
        nil
    end
  end

  defp configured_repository do
    case Config.settings() do
      {:ok, settings} -> Arguments.optional_value(%{"repository" => settings.workspace.repository}, "repository")
      {:error, _reason} -> nil
    end
  end

  defp workspace_repository(opts) do
    workspace = Arguments.option_value(opts, :workspace) || Arguments.option_value(opts, :workspace_root)

    with workspace when is_binary(workspace) and workspace != "" <- workspace,
         true <- File.dir?(workspace),
         {remote, 0} <- System.cmd("git", ["-C", workspace, "config", "--get", "remote.origin.url"], stderr_to_stdout: true),
         remote <- String.trim(remote),
         true <- remote != "" do
      normalize_repository_remote(remote)
    else
      _ -> nil
    end
  end

  defp normalize_repository_remote("git@github.com:" <> rest), do: trim_git_suffix(rest)

  defp normalize_repository_remote(remote) do
    case URI.parse(remote) do
      %URI{host: "github.com", path: "/" <> path} -> trim_git_suffix(path)
      _ -> remote
    end
  end

  defp trim_git_suffix(repository) do
    repository
    |> String.trim()
    |> String.trim_trailing(".git")
  end

  defp supported_runner_kind_or_nil(value) when is_binary(value) do
    if value in ExecutionProfile.supported_runner_kinds(), do: value
  end

  defp supported_runner_kind_or_nil(_value), do: nil

  defp inferred_labels(args) do
    text =
      [
        Arguments.optional_value(args, "name"),
        Arguments.optional_value(args, "description"),
        Arguments.optional_value(args, "instructions")
      ]
      |> Enum.filter(&is_binary/1)
      |> Enum.join(" ")
      |> String.downcase()

    labels =
      Enum.flat_map(@task_label_rules, fn {label, terms} ->
        if Enum.any?(terms, &String.contains?(text, &1)), do: [label], else: []
      end)

    case labels do
      [] -> nil
      labels -> labels
    end
  end

  defp validation_feedback(code, field, message, recoverable, suggested_default, ask_user) do
    %{
      "code" => code,
      "field" => field,
      "message" => message,
      "recoverable" => recoverable,
      "suggested_default" => suggested_default,
      "ask_user" => ask_user
    }
  end

  defp present_string?(value) when is_binary(value), do: String.trim(value) != ""
  defp present_string?(_value), do: false
end
