defmodule SymphonyElixir.CloudExecution.Aws.TaskStore do
  @moduledoc """
  JSON-backed store for ECS tasks launched by the Runtime.
  """

  use GenServer

  alias SymphonyElixir.CloudExecution.Aws.Config
  alias SymphonyElixir.CloudExecution.Aws.TaskRecord

  @type server :: GenServer.server()

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @spec upsert(TaskRecord.t(), server()) :: :ok
  def upsert(%TaskRecord{} = record, server \\ __MODULE__) do
    GenServer.call(server, {:upsert, record})
  end

  @spec get(String.t(), server()) :: TaskRecord.t() | nil
  def get(task_arn, server \\ __MODULE__) do
    GenServer.call(server, {:get, task_arn})
  end

  @spec list(server()) :: [TaskRecord.t()]
  def list(server \\ __MODULE__), do: GenServer.call(server, :list)

  @spec non_terminal(server()) :: [TaskRecord.t()]
  def non_terminal(server \\ __MODULE__), do: GenServer.call(server, :non_terminal)

  @impl true
  def init(opts) do
    path = Keyword.get(opts, :path) || configured_path()
    records = load_records(path)
    {:ok, %{path: path, records: records}}
  end

  @impl true
  def handle_call({:upsert, %TaskRecord{} = record}, _from, state) do
    records = Map.put(state.records, record.task_arn, record)
    state = %{state | records: records}
    :ok = persist(state)
    {:reply, :ok, state}
  end

  def handle_call({:get, task_arn}, _from, state) do
    {:reply, Map.get(state.records, task_arn), state}
  end

  def handle_call(:list, _from, state) do
    {:reply, Map.values(state.records), state}
  end

  def handle_call(:non_terminal, _from, state) do
    records =
      state.records
      |> Map.values()
      |> Enum.reject(&TaskRecord.terminal?/1)

    {:reply, records, state}
  end

  defp configured_path do
    case Config.load() do
      {:ok, config} -> config.task_store_path
      {:error, _reason} -> Path.join(System.tmp_dir!(), "parallel-agent-runtime-aws-tasks.json")
    end
  end

  defp load_records(path) do
    with {:ok, body} <- File.read(path),
         {:ok, decoded} <- Jason.decode(body),
         true <- is_list(decoded) do
      Map.new(decoded, fn map ->
        record = TaskRecord.from_map(map)
        {record.task_arn, record}
      end)
    else
      _other -> %{}
    end
  end

  defp persist(%{path: path, records: records}) do
    path |> Path.dirname() |> File.mkdir_p!()

    body =
      records
      |> Map.values()
      |> Jason.encode_to_iodata!()

    File.write!(path, body)
    :ok
  end
end
