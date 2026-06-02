defmodule SymphonyElixir.ExecutionAdapterTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.ExecutionAdapter
  alias SymphonyElixir.ExecutionAdapter.Error

  setup do
    previous_config = Application.fetch_env(:symphony_elixir, :aws_execution_adapter)
    Application.delete_env(:symphony_elixir, :aws_execution_adapter)

    on_exit(fn ->
      restore_app_env(previous_config)
    end)
  end

  describe "resolve/1" do
    test "selects local helper adapter for local helper targets" do
      assert {:ok, SymphonyElixir.ExecutionAdapter.LocalHelper} = ExecutionAdapter.resolve("local_helper")
      assert {:ok, SymphonyElixir.ExecutionAdapter.LocalHelper} = ExecutionAdapter.resolve("local_relay")
    end

    test "selects AWS adapter for container targets" do
      assert {:ok, SymphonyElixir.ExecutionAdapter.Aws} = ExecutionAdapter.resolve("aws")
      assert {:ok, SymphonyElixir.ExecutionAdapter.Aws} = ExecutionAdapter.resolve("container")
      assert {:ok, SymphonyElixir.ExecutionAdapter.Aws} = ExecutionAdapter.resolve("ecs")
    end

    test "returns structured error for unsupported targets" do
      assert {:error, %Error{} = error} = ExecutionAdapter.resolve("bare_metal")
      assert error.code == :unsupported_execution_target
      assert error.details.target == "bare_metal"
    end
  end

  test "local helper start path leaves existing local relay routing intact" do
    assert {:ok, result} =
             ExecutionAdapter.start_run(%{
               "execution_target" => "local_helper",
               "workspace_id" => "workspace-1",
               "agent_id" => "agent-1",
               "run_id" => "run-1",
               "execution_mode" => "planning_read_only"
             })

    assert result.adapter == "local_helper"
    assert result.status == "selected"
  end

  test "AWS target with missing cluster/task config is rejected before task launch" do
    assert {:error, %Error{} = error} =
             ExecutionAdapter.start_run(%{
               "execution_target" => "aws",
               "workspace_id" => "workspace-1",
               "agent_id" => "agent-1",
               "run_id" => "run-1",
               "execution_mode" => "planning_read_only",
               "resources" => []
             })

    assert error.code == :missing_adapter_config
    assert "cluster" in error.details.missing
    assert "task_definition" in error.details.missing
  end

  test "resolves nested atom-key execution target before normalizing request" do
    assert {:error, %Error{} = error} =
             ExecutionAdapter.start_run(%{
               execution_profile: %{adapter_config: %{execution_target: "aws"}},
               workspace_id: "workspace-1",
               agent_id: "agent-1",
               run_id: "run-1",
               execution_mode: "planning_read_only",
               resources: []
             })

    assert error.code == :missing_adapter_config
    assert error.details.adapter == "aws"
  end

  test "AWS target coerces nil adapter_config to structured missing config error" do
    assert {:error, %Error{} = error} =
             ExecutionAdapter.start_run(%{
               "execution_target" => "aws",
               "workspace_id" => "workspace-1",
               "agent_id" => "agent-1",
               "run_id" => "run-1",
               "execution_mode" => "planning_read_only",
               "adapter_config" => nil,
               "resources" => []
             })

    assert error.code == :missing_adapter_config
    assert error.details.adapter == "aws"
  end

  test "AWS stub returns hello-world response when configured" do
    Application.put_env(:symphony_elixir, :aws_execution_adapter, %{
      "cluster" => "test-cluster",
      "task_definition" => "hello-world:1",
      "subnets" => ["subnet-1"],
      "security_groups" => ["sg-1"]
    })

    assert {:ok, result} =
             ExecutionAdapter.start_run(%{
               "execution_target" => "aws",
               "workspace_id" => "workspace-1",
               "agent_id" => "agent-1",
               "run_id" => "run-1",
               "execution_mode" => "planning_read_only",
               "resources" => []
             })

    assert result.adapter == "aws"
    assert result.status == "hello_world_started"
    assert result.metadata["cluster"] == "test-cluster"
    assert result.metadata["task_definition"] == "hello-world:1"
  end

  test "AWS target rejects unsupported execution mode with structured error" do
    assert {:error, %Error{} = error} =
             ExecutionAdapter.start_run(%{
               "execution_target" => "aws",
               "workspace_id" => "workspace-1",
               "agent_id" => "agent-1",
               "run_id" => "run-1",
               "execution_mode" => "shell_admin",
               "resources" => []
             })

    assert error.code == :unsupported_execution_mode
    assert error.details.adapter == "aws"
  end

  test "AWS target rejects resources missing grant metadata before config validation" do
    assert {:error, %Error{} = error} =
             ExecutionAdapter.start_run(%{
               "execution_target" => "aws",
               "workspace_id" => "workspace-1",
               "agent_id" => "agent-1",
               "run_id" => "run-1",
               "execution_mode" => "planning_read_only",
               "resources" => [
                 %{"resource_id" => "repo-1", "alias" => "parallel-agent-runtime"}
               ]
             })

    assert error.code == :missing_resource_grant_metadata
    assert [%{resource_id: "repo-1", alias: "parallel-agent-runtime"}] = error.details.resources
  end

  test "AWS target reports unavailable capacity as a structured pre-launch error" do
    Application.put_env(:symphony_elixir, :aws_execution_adapter, %{
      "cluster" => "test-cluster",
      "task_definition" => "hello-world:1",
      "subnets" => ["subnet-1"],
      "security_groups" => ["sg-1"],
      "capacity_available" => false
    })

    assert {:error, %Error{} = error} =
             ExecutionAdapter.start_run(%{
               "execution_target" => "aws",
               "workspace_id" => "workspace-1",
               "agent_id" => "agent-1",
               "run_id" => "run-1",
               "execution_mode" => "planning_read_only",
               "resources" => []
             })

    assert error.code == :unavailable_capacity
  end

  defp restore_app_env({:ok, config}), do: Application.put_env(:symphony_elixir, :aws_execution_adapter, config)
  defp restore_app_env(:error), do: Application.delete_env(:symphony_elixir, :aws_execution_adapter)
end
