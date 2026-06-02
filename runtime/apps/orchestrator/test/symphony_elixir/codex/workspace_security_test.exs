defmodule SymphonyElixir.Codex.WorkspaceSecurityTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Codex.WorkspaceSecurity

  test "rejects local workspace root and paths outside the configured root" do
    test_root =
      Path.join(
        System.tmp_dir!(),
        "symphony-elixir-workspace-security-#{System.unique_integer([:positive])}"
      )

    try do
      workspace_root = Path.join(test_root, "workspaces")
      outside_workspace = Path.join(test_root, "outside")

      File.mkdir_p!(workspace_root)
      File.mkdir_p!(outside_workspace)

      write_workflow_file!(Workflow.workflow_file_path(), workspace_root: workspace_root)

      assert {:error, {:invalid_workspace_cwd, :workspace_root, _path}} =
               WorkspaceSecurity.validate_cwd(workspace_root, nil)

      assert {:error, {:invalid_workspace_cwd, :outside_workspace_root, _path, _root}} =
               WorkspaceSecurity.validate_cwd(outside_workspace, nil)
    after
      File.rm_rf(test_root)
    end
  end

  test "validates remote workspace strings without local canonicalization" do
    assert {:ok, "/remote/workspace"} = WorkspaceSecurity.validate_cwd("/remote/workspace", "worker-1")

    assert {:error, {:invalid_workspace_cwd, :empty_remote_workspace, "worker-1"}} =
             WorkspaceSecurity.validate_cwd("  ", "worker-1")

    assert {:error, {:invalid_workspace_cwd, :invalid_remote_workspace, "worker-1", "bad\npath"}} =
             WorkspaceSecurity.validate_cwd("bad\npath", "worker-1")
  end
end
