defmodule SymphonyElixir.RepositoryIdentityTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.RepositoryIdentity
  alias SymphonyElixir.WorkItem
  alias SymphonyElixir.WorkerBridge.RepositoryManager

  describe "repo_id/1" do
    test "normalizes repository resource URLs with the worker bridge repo id contract" do
      repository = %{"url" => " https://github.com/kmgrassi/parallel-agent-runtime.git "}

      assert RepositoryIdentity.repo_id(repository) ==
               {:ok, RepositoryManager.repo_id(%{"url" => "https://github.com/kmgrassi/parallel-agent-runtime.git"})}
    end

    test "uses explicit repo ids when no URL-like locator is present" do
      assert RepositoryIdentity.repo_id(%{"repo_id" => "repo-db-id"}) == {:ok, "repo-db-id"}
    end

    test "computes the canonical repo id for a work item repository URL" do
      work_item = %WorkItem{
        repository_id: "repo-db-id",
        repository: "https://github.com/kmgrassi/parallel-agent-runtime.git"
      }

      assert RepositoryIdentity.repo_id(work_item) ==
               {:ok, RepositoryManager.repo_id("https://github.com/kmgrassi/parallel-agent-runtime")}
    end

    test "falls back to work item repository metadata" do
      work_item = %WorkItem{metadata: %{"repository_url" => "git@github.com:kmgrassi/parallel-agent-runtime.git"}}

      assert {:ok, repo_id} = RepositoryIdentity.repo_id(work_item)
      assert repo_id == RepositoryManager.repo_id("git@github.com:kmgrassi/parallel-agent-runtime")
    end

    test "rejects blank repository values" do
      assert RepositoryIdentity.repo_id(%{"url" => " "}) == {:error, :missing_repository}
    end
  end
end
