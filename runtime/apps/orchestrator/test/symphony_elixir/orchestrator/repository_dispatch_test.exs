defmodule SymphonyElixir.Orchestrator.RepositoryDispatchTest do
  use SymphonyElixir.TestSupport

  test "leaves active repository-targeted work items for the matching worker when this worker is not configured for that repository" do
    write_workflow_file!(
      Workflow.workflow_file_path(),
      tracker_kind: "memory",
      workspace_repository: "repo-a",
      poll_interval_ms: 10
    )

    issue = %WorkItem{
      id: "wi-repo-b",
      identifier: "WI-REPO-B",
      title: "Repo B task",
      state: "Todo",
      repository_id: "repo-b"
    }

    put_app_env(:symphony_elixir, :memory_tracker_issues, [issue])
    put_app_env(:symphony_elixir, :memory_tracker_recipient, self())

    orchestrator_name = Module.concat(__MODULE__, :RepositoryGateOrchestrator)
    {:ok, pid} = Orchestrator.start_link(name: orchestrator_name)

    on_exit(fn ->
      if Process.alive?(pid), do: Process.exit(pid, :normal)
    end)

    refute_receive {:memory_tracker_state_update, "wi-repo-b", _state}, 100
  end
end
