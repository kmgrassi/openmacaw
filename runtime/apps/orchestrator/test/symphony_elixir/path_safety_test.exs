defmodule SymphonyElixir.PathSafetyTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.PathSafety

  test "validate_path_segment accepts simple issue-safe names" do
    assert :ok = PathSafety.validate_path_segment("MT-123_fix.1")
  end

  test "validate_path_segment rejects empty, relative, separator, and control-character segments" do
    assert {:error, {:invalid_path_segment, "", :empty}} =
             PathSafety.validate_path_segment("")

    assert {:error, {:invalid_path_segment, ".", :relative_segment}} =
             PathSafety.validate_path_segment(".")

    assert {:error, {:invalid_path_segment, "..", :relative_segment}} =
             PathSafety.validate_path_segment("..")

    assert {:error, {:invalid_path_segment, "../escape", :path_separator}} =
             PathSafety.validate_path_segment("../escape")

    assert {:error, {:invalid_path_segment, "nested/path", :path_separator}} =
             PathSafety.validate_path_segment("nested/path")

    assert {:error, {:invalid_path_segment, "bad\nname", :invalid_characters}} =
             PathSafety.validate_path_segment("bad\nname")
  end

  test "workspace_child_path rejects traversal before joining with the root" do
    root = Path.join(System.tmp_dir!(), "path-safety-segment-#{System.unique_integer([:positive])}")

    assert {:error, {:invalid_path_segment, "..", :relative_segment}} =
             PathSafety.workspace_child_path(root, "..")
  end

  test "validate_workspace_child accepts canonical children and rejects the root itself" do
    root = Path.join(System.tmp_dir!(), "path-safety-root-#{System.unique_integer([:positive])}")

    try do
      child = Path.join(root, "child")

      File.mkdir_p!(child)

      assert :ok = PathSafety.validate_workspace_child(child, root)

      assert {:ok, canonical_root} = PathSafety.canonicalize(root)

      assert {:error, {:workspace_equals_root, ^canonical_root, ^canonical_root}} =
               PathSafety.validate_workspace_child(root, root)
    after
      File.rm_rf(root)
    end
  end

  test "validate_workspace_child rejects symlinks that escape the root" do
    root = Path.join(System.tmp_dir!(), "path-safety-symlink-root-#{System.unique_integer([:positive])}")

    try do
      workspace_root = Path.join(root, "workspaces")
      outside_root = Path.join(root, "outside")
      symlink_path = Path.join(workspace_root, "linked")

      File.mkdir_p!(workspace_root)
      File.mkdir_p!(outside_root)
      File.ln_s!(outside_root, symlink_path)

      assert {:ok, canonical_workspace_root} = PathSafety.canonicalize(workspace_root)

      assert {:error, {:workspace_symlink_escape, ^symlink_path, ^canonical_workspace_root}} =
               PathSafety.validate_workspace_child(symlink_path, workspace_root)
    after
      File.rm_rf(root)
    end
  end

  test "validate_local_workspace_cwd accepts canonical children and rejects symlink escapes" do
    root = Path.join(System.tmp_dir!(), "path-safety-cwd-root-#{System.unique_integer([:positive])}")

    try do
      workspace_root = Path.join(root, "workspaces")
      workspace = Path.join(workspace_root, "child")
      outside_root = Path.join(root, "outside")
      symlink_path = Path.join(workspace_root, "linked")

      File.mkdir_p!(workspace)
      File.mkdir_p!(outside_root)
      File.ln_s!(outside_root, symlink_path)

      assert {:ok, canonical_workspace} =
               PathSafety.validate_local_workspace_cwd(workspace, workspace_root)

      assert {:ok, expected_workspace} = PathSafety.canonicalize(workspace)
      assert canonical_workspace == expected_workspace

      assert {:ok, canonical_workspace_root} = PathSafety.canonicalize(workspace_root)

      assert {:error, {:invalid_workspace_cwd, :symlink_escape, ^symlink_path, ^canonical_workspace_root}} =
               PathSafety.validate_local_workspace_cwd(symlink_path, workspace_root)
    after
      File.rm_rf(root)
    end
  end

  test "validate_local_workspace_cwd can require an existing directory" do
    root = Path.join(System.tmp_dir!(), "path-safety-cwd-dir-#{System.unique_integer([:positive])}")

    try do
      workspace_root = Path.join(root, "workspaces")
      missing_workspace = Path.join(workspace_root, "missing")

      File.mkdir_p!(workspace_root)

      assert {:ok, canonical_missing_workspace} = PathSafety.canonicalize(missing_workspace)

      assert {:error, {:invalid_workspace_cwd, :cwd_not_found, ^canonical_missing_workspace}} =
               PathSafety.validate_local_workspace_cwd(missing_workspace, workspace_root, require_dir?: true)
    after
      File.rm_rf(root)
    end
  end
end
