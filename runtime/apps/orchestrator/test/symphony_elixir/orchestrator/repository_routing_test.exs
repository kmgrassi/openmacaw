defmodule SymphonyElixir.Orchestrator.RepositoryRoutingTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Orchestrator.RepositoryRouting
  alias SymphonyElixir.WorkItem

  describe "dispatch_decision/2" do
    test "allows untargeted work items" do
      assert RepositoryRouting.dispatch_decision(%WorkItem{}, settings("repo-a")) == :routable
    end

    test "allows work items targeted to the configured repository" do
      issue = %WorkItem{repository_id: "repo-a"}

      assert RepositoryRouting.dispatch_decision(issue, settings("repo-a")) == :routable
    end

    test "skips work items targeted to a different repository" do
      issue = %WorkItem{repository_id: "repo-b"}

      assert RepositoryRouting.dispatch_decision(issue, settings("repo-a")) == {:skip, "repo-b"}
    end

    test "falls back to repository metadata while first-class columns roll out" do
      issue = %WorkItem{metadata: %{"repository_id" => "repo-b"}}

      assert RepositoryRouting.dispatch_decision(issue, settings("repo-a")) == {:skip, "repo-b"}
    end

    test "matches repository URL/name even when repository_id is also present" do
      issue = %WorkItem{
        repository_id: "repo-db-id",
        repository: "https://github.com/kmgrassi/parallel-agent-runtime"
      }

      assert RepositoryRouting.dispatch_decision(
               issue,
               settings("https://github.com/kmgrassi/parallel-agent-runtime")
             ) == :routable
    end

    test "matches GitHub URL config against owner/repo work item repository" do
      issue = %WorkItem{repository: "kmgrassi/parallel-agent-runtime"}

      assert RepositoryRouting.dispatch_decision(
               issue,
               settings("https://github.com/kmgrassi/parallel-agent-runtime.git")
             ) == :routable
    end
  end

  defp settings(repository) do
    %{
      workspace: %{repository: repository},
      tracker: %{repository: nil}
    }
  end
end
