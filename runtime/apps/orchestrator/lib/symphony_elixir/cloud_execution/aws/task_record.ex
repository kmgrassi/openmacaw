defmodule SymphonyElixir.CloudExecution.Aws.TaskRecord do
  @moduledoc """
  Persisted ECS task lifecycle state owned by the Runtime.
  """

  @derive Jason.Encoder
  defstruct [
    :task_arn,
    :workspace_id,
    :session_id,
    :run_id,
    :cluster,
    :status,
    :last_status,
    :desired_status,
    :stopped_reason,
    :container_exit_code,
    :container_reason,
    :log_stream,
    :timeout_at,
    :terminal_at,
    :created_at,
    :updated_at
  ]

  @type t :: %__MODULE__{
          task_arn: String.t(),
          workspace_id: String.t() | nil,
          session_id: String.t() | nil,
          run_id: String.t() | nil,
          cluster: String.t() | nil,
          status: String.t() | nil,
          last_status: String.t() | nil,
          desired_status: String.t() | nil,
          stopped_reason: String.t() | nil,
          container_exit_code: integer() | nil,
          container_reason: String.t() | nil,
          log_stream: String.t() | nil,
          timeout_at: String.t() | nil,
          terminal_at: String.t() | nil,
          created_at: String.t() | nil,
          updated_at: String.t() | nil
        }

  @terminal_statuses MapSet.new(["STOPPED"])

  @spec new(map(), map()) :: t()
  def new(attrs, task) do
    now = DateTime.utc_now() |> DateTime.to_iso8601()

    %__MODULE__{
      task_arn: task_arn(task),
      workspace_id: string_attr(attrs, :workspace_id),
      session_id: string_attr(attrs, :session_id),
      run_id: string_attr(attrs, :run_id),
      cluster: string_attr(attrs, :cluster),
      timeout_at: timeout_at(attrs),
      created_at: now,
      updated_at: now
    }
    |> merge_task(task)
  end

  @spec from_map(map()) :: t()
  def from_map(map) do
    fields = __struct__() |> Map.from_struct() |> Map.keys()

    attrs =
      Map.new(fields, fn field ->
        {field, Map.get(map, Atom.to_string(field)) || Map.get(map, field)}
      end)

    struct(__MODULE__, attrs)
  end

  @spec merge_task(t(), map()) :: t()
  def merge_task(%__MODULE__{} = record, task) do
    now = DateTime.utc_now() |> DateTime.to_iso8601()
    last_status = get_in_value(task, ["lastStatus"]) || record.last_status
    container = first_container(task)

    terminal_at =
      if terminal_status?(last_status) do
        record.terminal_at || now
      else
        nil
      end

    %{
      record
      | task_arn: task_arn(task) || record.task_arn,
        status: status_for(last_status),
        last_status: last_status,
        desired_status: get_in_value(task, ["desiredStatus"]) || record.desired_status,
        stopped_reason: get_in_value(task, ["stoppedReason"]) || record.stopped_reason,
        container_exit_code: get_in_value(container, ["exitCode"]) || record.container_exit_code,
        container_reason: get_in_value(container, ["reason"]) || record.container_reason,
        log_stream: log_stream(container) || record.log_stream,
        terminal_at: terminal_at,
        updated_at: now
    }
  end

  @spec terminal?(t()) :: boolean()
  def terminal?(%__MODULE__{status: "terminal"}), do: true
  def terminal?(%__MODULE__{last_status: last_status}), do: terminal_status?(last_status)

  defp status_for(last_status), do: if(terminal_status?(last_status), do: "terminal", else: "running")

  defp terminal_status?(status) when is_binary(status), do: MapSet.member?(@terminal_statuses, status)
  defp terminal_status?(_status), do: false

  defp task_arn(task), do: get_in_value(task, ["taskArn"]) || get_in_value(task, [:task_arn])

  defp first_container(task) do
    case get_in_value(task, ["containers"]) do
      [container | _rest] -> container
      _other -> %{}
    end
  end

  defp log_stream(container) do
    get_in_value(container, ["logStreamName"]) ||
      get_in_value(container, ["logConfiguration", "options", "awslogs-stream-prefix"])
  end

  defp timeout_at(attrs) do
    case Map.get(attrs, :timeout_seconds) || Map.get(attrs, "timeout_seconds") do
      seconds when is_integer(seconds) and seconds > 0 ->
        DateTime.utc_now() |> DateTime.add(seconds, :second) |> DateTime.to_iso8601()

      _other ->
        nil
    end
  end

  defp string_attr(map, key), do: Map.get(map, key) || Map.get(map, Atom.to_string(key))

  defp get_in_value(nil, _keys), do: nil

  defp get_in_value(map, [key | rest]) when is_map(map) do
    value = Map.get(map, key) || Map.get(map, maybe_atom(key))
    get_in_value(value, rest)
  end

  defp get_in_value(value, []), do: value
  defp get_in_value(_value, _keys), do: nil

  defp maybe_atom(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> key
  end

  defp maybe_atom(key), do: key
end
