defmodule SymphonyElixir.LocalModelCoding.PatchExecutorTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.LocalModelCoding.PatchExecutor

  setup do
    root = Path.join(System.tmp_dir!(), "patch-executor-test-#{System.unique_integer([:positive])}")
    File.mkdir_p!(root)

    on_exit(fn -> File.rm_rf(root) end)

    %{root: root}
  end

  test "applies add update delete operations and emits changed file summaries", %{root: root} do
    File.write!(Path.join(root, "existing.txt"), "alpha\nbeta\ngamma")
    File.write!(Path.join(root, "remove.txt"), "old\nfile\n")

    patch = """
    *** Begin Patch
    *** Add File: nested/new.txt
    +first
    +second
    *** Update File: existing.txt
    @@
     alpha
    -beta
    +bravo
     gamma
    *** Delete File: remove.txt
    *** End Patch
    """

    assert {:ok, result} =
             PatchExecutor.execute(%{"patch" => patch},
               workspace_root: root,
               on_event: fn event -> send(self(), {:patch_event, event}) end
             )

    assert result["success"] == true
    assert File.read!(Path.join(root, "nested/new.txt")) == "first\nsecond"
    assert File.read!(Path.join(root, "existing.txt")) == "alpha\nbravo\ngamma"
    refute File.exists?(Path.join(root, "remove.txt"))

    assert_receive {:patch_event, %{event: :patch_apply_begin, payload: %{"changes" => begin_changes}}}
    assert_receive {:patch_event, %{event: :patch_apply_end, payload: %{"success" => true, "changes" => end_changes}}}

    assert Enum.map(begin_changes, & &1["path"]) == ["nested/new.txt", "existing.txt", "remove.txt"]
    assert Enum.find(end_changes, &(&1["path"] == "existing.txt"))["additions"] == 1
    assert Enum.find(end_changes, &(&1["path"] == "existing.txt"))["deletions"] == 1
  end

  test "rejects writes outside the workspace", %{root: root} do
    patch = """
    *** Begin Patch
    *** Add File: ../escape.txt
    +nope
    *** End Patch
    """

    assert {:ok, result} = PatchExecutor.execute(%{"patch" => patch}, workspace_root: root)

    assert result["success"] == false
    assert result["error"] =~ "workspace_path_escape"
    refute File.exists?(Path.expand("../escape.txt", root))
  end

  test "rejects symlink escapes before writing", %{root: root} do
    outside = Path.join(System.tmp_dir!(), "patch-executor-outside-#{System.unique_integer([:positive])}")
    File.mkdir_p!(outside)
    File.ln_s!(outside, Path.join(root, "linked"))

    patch = """
    *** Begin Patch
    *** Add File: linked/escape.txt
    +nope
    *** End Patch
    """

    try do
      assert {:ok, result} = PatchExecutor.execute(%{"patch" => patch}, workspace_root: root)

      assert result["success"] == false
      assert result["error"] =~ "workspace_path_escape"
      refute File.exists?(Path.join(outside, "escape.txt"))
    after
      File.rm_rf(outside)
    end
  end

  test "accepts update patches with an end-of-file sentinel", %{root: root} do
    path = Path.join(root, "existing.txt")
    File.write!(path, "alpha\nbeta")

    patch = """
    *** Begin Patch
    *** Update File: existing.txt
    @@
     alpha
    -beta
    +bravo
    *** End of File
    *** End Patch
    """

    assert {:ok, result} = PatchExecutor.execute(%{"patch" => patch}, workspace_root: root)

    assert result["success"] == true
    assert File.read!(path) == "alpha\nbravo"
  end

  test "resolves patch paths from a workspace-relative cwd", %{root: root} do
    File.mkdir_p!(Path.join(root, "nested"))

    patch = """
    *** Begin Patch
    *** Add File: created.txt
    +inside cwd
    *** End Patch
    """

    assert {:ok, result} = PatchExecutor.execute(%{"patch" => patch, "cwd" => "nested"}, workspace_root: root)

    assert result["success"] == true
    assert File.read!(Path.join([root, "nested", "created.txt"])) == "inside cwd"
  end

  test "rejects patch cwd symlink escapes", %{root: root} do
    outside = Path.join(System.tmp_dir!(), "patch-executor-cwd-outside-#{System.unique_integer([:positive])}")
    File.mkdir_p!(outside)
    File.ln_s!(outside, Path.join(root, "linked-cwd"))

    patch = """
    *** Begin Patch
    *** Add File: created.txt
    +nope
    *** End Patch
    """

    try do
      assert {:ok, result} = PatchExecutor.execute(%{"patch" => patch, "cwd" => "linked-cwd"}, workspace_root: root)

      assert result["success"] == false
      assert result["error"] =~ "workspace_path_escape"
      refute File.exists?(Path.join(outside, "created.txt"))
    after
      File.rm_rf(outside)
    end
  end

  test "rejects add-file hunks with unprefixed content lines", %{root: root} do
    patch = """
    *** Begin Patch
    *** Add File: malformed.txt
    +good
    missing-prefix
    *** End Patch
    """

    assert {:ok, result} = PatchExecutor.execute(%{"patch" => patch}, workspace_root: root)

    assert result["success"] == false
    assert result["error"] =~ "invalid_add_file_line"
    refute File.exists?(Path.join(root, "malformed.txt"))
  end

  test "reports patch failures without partially changing unmatched update files", %{root: root} do
    path = Path.join(root, "existing.txt")
    File.write!(path, "alpha\nbeta\n")

    patch = """
    *** Begin Patch
    *** Update File: existing.txt
    @@
    -missing
    +replacement
    *** End Patch
    """

    assert {:ok, result} =
             PatchExecutor.execute(%{"patch" => patch},
               workspace_root: root,
               on_event: fn event -> send(self(), {:patch_event, event}) end
             )

    assert result["success"] == false
    assert result["error"] =~ "patch_context_not_found"
    assert File.read!(path) == "alpha\nbeta\n"
    assert_receive {:patch_event, %{event: :patch_apply_end, payload: %{"success" => false, "error" => error}}}
    assert error =~ "patch_context_not_found"
  end
end
