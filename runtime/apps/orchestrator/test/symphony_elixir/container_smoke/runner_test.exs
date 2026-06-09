defmodule SymphonyElixir.ContainerSmoke.RunnerTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.ContainerSmoke.Catalog
  alias SymphonyElixir.ContainerSmoke.Runner

  defmodule MetricClient do
    def put_metric_data(namespace, metrics, opts) do
      send(self(), {:metric_data, namespace, metrics, opts})
      :ok
    end
  end

  setup do
    env_names =
      Catalog.tests()
      |> Enum.map(& &1.command_env)
      |> Kernel.++(["CONTAINER_SMOKE_FORCE_FAIL", "CONTAINER_SMOKE_METRIC_NAMESPACE"])

    previous = Map.new(env_names, &{&1, System.get_env(&1)})
    Enum.each(env_names, &System.delete_env/1)

    on_exit(fn ->
      Enum.each(previous, fn
        {name, nil} -> System.delete_env(name)
        {name, value} -> System.put_env(name, value)
      end)
    end)

    :ok
  end

  test "catalog defines exactly the eleven production smoke tests" do
    assert Catalog.test_ids() == [
             "task_launch",
             "log_split",
             "egress_allow",
             "egress_deny",
             "secret_injection",
             "sts_scope_positive",
             "sts_scope_negative",
             "vpc_endpoint_reachability",
             "queue_round_trip",
             "cancellation",
             "end_to_end"
           ]
  end

  test "dry-run validates catalog without requiring CloudWatch config" do
    assert :ok = Runner.run(dry_run: true)
  end

  test "emits one pass and failure metric per smoke test" do
    Enum.each(Catalog.tests(), fn test ->
      System.put_env(test.command_env, "true")
    end)

    System.put_env("CONTAINER_SMOKE_EGRESS_DENY_COMMAND", "false")

    assert {:error, {:container_smoke_failed, ["egress_deny"]}} =
             Runner.run([metric_namespace: "OpenMacaw/dev/container-execution"], %{metric_client: MetricClient})

    assert_received {:metric_data, "OpenMacaw/dev/container-execution", metrics, _opts}

    failure_metrics = Enum.filter(metrics, &(&1.name == "SmokeTestFailed"))
    assert length(failure_metrics) == 11

    assert Enum.find(failure_metrics, &(&1.dimensions["TestName"] == "egress_deny")).value == 1
    assert Enum.find(failure_metrics, &(&1.dimensions["TestName"] == "task_launch")).value == 0
  end

  test "force-fail can intentionally trip a single alarm" do
    Enum.each(Catalog.tests(), fn test ->
      System.put_env(test.command_env, "true")
    end)

    assert {:error, {:container_smoke_failed, ["task_launch"]}} =
             Runner.run([force_fail: "task_launch", metric_namespace: "OpenMacaw/dev/container-execution"], %{
               metric_client: MetricClient
             })

    assert_received {:metric_data, _namespace, metrics, _opts}
    assert Enum.find(metrics, &(&1.name == "SmokeTestFailed" and &1.dimensions["TestName"] == "task_launch")).value == 1
  end
end
