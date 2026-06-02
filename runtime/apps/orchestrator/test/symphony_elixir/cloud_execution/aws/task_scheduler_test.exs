defmodule SymphonyElixir.CloudExecution.Aws.TaskSchedulerTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.CloudExecution.Aws.Config
  alias SymphonyElixir.CloudExecution.Aws.TaskRecord
  alias SymphonyElixir.CloudExecution.Aws.TaskScheduler
  alias SymphonyElixir.CloudExecution.Aws.TaskStore

  defmodule StubEcsClient do
    @behaviour SymphonyElixir.CloudExecution.Aws.EcsClient

    @impl true
    def run_task(_config, payload) do
      Process.put(:ecs_run_task_payload, payload)
      Process.get(:ecs_run_task_response)
    end

    @impl true
    def describe_tasks(_config, task_arns) do
      Process.put(:ecs_describe_task_arns, task_arns)

      case Process.get(:ecs_describe_responses) do
        [response | rest] ->
          Process.put(:ecs_describe_responses, rest)
          response

        response ->
          response
      end
    end

    @impl true
    def stop_task(_config, task_arn, reason) do
      Process.put(:ecs_stop_task_arn, task_arn)
      Process.put(:ecs_stop_reason, reason)
      Process.get(:ecs_stop_response)
    end

    @impl true
    def list_tasks(_config, opts) do
      Process.put(:ecs_list_tasks_opts, opts)
      Process.get(:ecs_list_tasks_response)
    end
  end

  setup do
    store_name = Module.concat(__MODULE__, :"TaskStore#{System.unique_integer([:positive])}")
    store_path = Path.join(System.tmp_dir!(), "aws-task-store-#{System.unique_integer([:positive])}.json")
    start_supervised!({TaskStore, name: store_name, path: store_path})

    Process.put(:ecs_run_task_response, nil)
    Process.put(:ecs_describe_responses, nil)
    Process.put(:ecs_stop_response, nil)
    Process.put(:ecs_list_tasks_response, nil)

    on_exit(fn -> File.rm(store_path) end)

    {:ok, store: store_name}
  end

  test "config rejects missing required AWS scheduler fields" do
    assert {:error, {:aws_scheduler_not_configured, missing}} = Config.load(%{})
    assert :cluster in missing
    assert :task_definition in missing
    assert :subnets in missing
  end

  test "launch starts a tagged Fargate task and persists ownership fields", %{store: store} do
    Process.put(:ecs_run_task_response, {:ok, %{"tasks" => [running_task("task-1")]}})

    assert {:ok, %TaskRecord{} = record} =
             TaskScheduler.launch(
               %{
                 workspace_id: "workspace-1",
                 session_id: "session-1",
                 run_id: "run-1",
                 timeout_seconds: 60,
                 command: ["echo", "hello"],
                 environment: %{"WORKSPACE_ID" => "workspace-1"}
               },
               scheduler_opts(store)
             )

    payload = Process.get(:ecs_run_task_payload)
    assert payload["cluster"] == "cluster-a"
    assert payload["taskDefinition"] == "task-def:1"
    assert payload["networkConfiguration"]["awsvpcConfiguration"]["subnets"] == ["subnet-a"]
    assert %{"key" => "runtime", "value" => "parallel-agent-runtime"} in payload["tags"]
    assert %{"key" => "workspace_id", "value" => "workspace-1"} in payload["tags"]

    assert record.task_arn == "task-1"
    assert record.workspace_id == "workspace-1"
    assert record.run_id == "run-1"
    assert TaskStore.get("task-1", store).task_arn == "task-1"
  end

  test "wait stops a nonterminal task after its runtime timeout", %{store: store} do
    past_timeout = DateTime.utc_now() |> DateTime.add(-1, :second) |> DateTime.to_iso8601()

    :ok =
      TaskStore.upsert(
        %TaskRecord{
          task_arn: "task-timeout",
          workspace_id: "workspace-1",
          session_id: "session-1",
          run_id: "run-1",
          cluster: "cluster-a",
          status: "running",
          last_status: "RUNNING",
          timeout_at: past_timeout
        },
        store
      )

    Process.put(:ecs_describe_responses, {:ok, %{"tasks" => [running_task("task-timeout")]}})
    Process.put(:ecs_stop_response, {:ok, %{"task" => stopped_task("task-timeout", 137)}})

    assert {:ok, %TaskRecord{status: "terminal", container_exit_code: 137}} =
             TaskScheduler.wait("task-timeout", scheduler_opts(store))

    assert Process.get(:ecs_stop_task_arn) == "task-timeout"
    assert Process.get(:ecs_stop_reason) == "runtime timeout"
  end

  test "wait returns a structured error when ECS does not describe the task", %{store: store} do
    Process.put(
      :ecs_describe_responses,
      {:ok,
       %{
         "tasks" => [],
         "failures" => [%{"arn" => "missing-task", "reason" => "MISSING"}]
       }}
    )

    assert {:error, {:aws_ecs_task_not_found, "missing-task", [%{"arn" => "missing-task", "reason" => "MISSING"}]}} =
             TaskScheduler.wait("missing-task", scheduler_opts(store))
  end

  test "wait keeps polling through deprovisioning until stopped", %{store: store} do
    Process.put(:ecs_describe_responses, [
      {:ok, %{"tasks" => [deprovisioning_task("task-deprovisioning")]}},
      {:ok, %{"tasks" => [stopped_task("task-deprovisioning", 0)]}}
    ])

    assert {:ok, %TaskRecord{status: "terminal", last_status: "STOPPED", container_exit_code: 0}} =
             TaskScheduler.wait("task-deprovisioning", scheduler_opts(store))
  end

  test "reconcile imports owned running tasks and refreshes known task state", %{store: store} do
    :ok =
      TaskStore.upsert(
        %TaskRecord{
          task_arn: "known-task",
          workspace_id: "workspace-known",
          session_id: "session-known",
          run_id: "run-known",
          cluster: "cluster-a",
          status: "running",
          last_status: "RUNNING"
        },
        store
      )

    Process.put(:ecs_list_tasks_response, {:ok, %{"taskArns" => ["owned-task", "foreign-task"]}})

    Process.put(:ecs_describe_responses, [
      {:ok, %{"tasks" => [running_task("owned-task"), foreign_task("foreign-task")]}},
      {:ok, %{"tasks" => [stopped_task("known-task", 0)]}}
    ])

    assert {:ok, records} = TaskScheduler.reconcile(scheduler_opts(store))

    assert Enum.map(records, & &1.task_arn) |> Enum.sort() == ["known-task", "owned-task"]
    assert TaskStore.get("owned-task", store).workspace_id == "workspace-1"
    assert TaskStore.get("known-task", store).status == "terminal"
    refute TaskStore.get("foreign-task", store)
  end

  defp scheduler_opts(store) do
    [
      client: StubEcsClient,
      store: store,
      poll_interval_ms: 0,
      config: %{
        region: "us-east-1",
        cluster: "cluster-a",
        task_definition: "task-def:1",
        subnets: ["subnet-a"],
        security_groups: ["sg-a"],
        container_name: "executor"
      }
    ]
  end

  defp running_task(task_arn) do
    %{
      "taskArn" => task_arn,
      "lastStatus" => "RUNNING",
      "desiredStatus" => "RUNNING",
      "tags" => ownership_tags()
    }
  end

  defp stopped_task(task_arn, exit_code) do
    %{
      "taskArn" => task_arn,
      "lastStatus" => "STOPPED",
      "desiredStatus" => "STOPPED",
      "stoppedReason" => "Essential container in task exited",
      "containers" => [
        %{
          "exitCode" => exit_code,
          "reason" => "done",
          "logStreamName" => "ecs/executor/#{task_arn}"
        }
      ],
      "tags" => ownership_tags()
    }
  end

  defp deprovisioning_task(task_arn) do
    %{
      "taskArn" => task_arn,
      "lastStatus" => "DEPROVISIONING",
      "desiredStatus" => "STOPPED",
      "tags" => ownership_tags()
    }
  end

  defp foreign_task(task_arn) do
    %{
      "taskArn" => task_arn,
      "lastStatus" => "RUNNING",
      "desiredStatus" => "RUNNING",
      "tags" => [%{"key" => "runtime", "value" => "other"}]
    }
  end

  defp ownership_tags do
    [
      %{"key" => "runtime", "value" => "parallel-agent-runtime"},
      %{"key" => "workspace_id", "value" => "workspace-1"},
      %{"key" => "session_id", "value" => "session-1"},
      %{"key" => "run_id", "value" => "run-1"}
    ]
  end
end
