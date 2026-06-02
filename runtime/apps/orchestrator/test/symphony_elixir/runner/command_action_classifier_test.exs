defmodule SymphonyElixir.Runner.CommandActionClassifierTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Runner.CommandActionClassifier

  describe "classify/1" do
    test "classifies common file readers" do
      assert CommandActionClassifier.classify(["cat", "README.md"]) == :read
      assert CommandActionClassifier.classify(["/usr/bin/head", "-n", "20", "lib/app.ex"]) == :read
      assert CommandActionClassifier.classify("tail -50 var/log/app.log") == :read
      assert CommandActionClassifier.classify(["sed", "-n", "1,40p", "mix.exs"]) == :read
    end

    test "classifies common directory listers" do
      assert CommandActionClassifier.classify(["ls"]) == :list_files
      assert CommandActionClassifier.classify(["ls", "-la", "apps/orchestrator"]) == :list_files
      assert CommandActionClassifier.classify("find apps -maxdepth 2 -type f") == :list_files
    end

    test "classifies common searches" do
      assert CommandActionClassifier.classify(["rg", "CommandActionClassifier", "lib"]) == :search
      assert CommandActionClassifier.classify("grep -R classify apps/orchestrator/lib") == :search
    end

    test "falls back to unknown for shell composition and shell wrappers" do
      assert CommandActionClassifier.classify("cat README.md | wc -l") == :unknown
      assert CommandActionClassifier.classify(["cat", "README.md", "|", "wc", "-l"]) == :unknown
      assert CommandActionClassifier.classify(["sh", "-c", "cat README.md"]) == :unknown
      assert CommandActionClassifier.classify(["bash", "-lc", "rg TODO"]) == :unknown
    end

    test "falls back to unknown for write-capable command forms" do
      assert CommandActionClassifier.classify(["sed", "-i", "s/old/new/g", "file.txt"]) == :unknown
      assert CommandActionClassifier.classify(["sed", "-n", "1,10w out.txt", "file.txt"]) == :unknown
      assert CommandActionClassifier.classify(["sed", "-n", "1wout.txt", "file.txt"]) == :unknown
      assert CommandActionClassifier.classify(["sed", "-n", "1e/bin/date", "file.txt"]) == :unknown
      assert CommandActionClassifier.classify(["find", ".", "-name", "*.tmp", "-delete"]) == :unknown
      assert CommandActionClassifier.classify(["find", ".", "-name", "*.ex", "-fprint", "matches.txt"]) == :unknown
      assert CommandActionClassifier.classify(["find", ".", "-name", "*.ex", "-fprintf", "matches.txt", "%p"]) == :unknown
      assert CommandActionClassifier.classify(["find", ".", "-name", "*.ex", "-fprint0", "matches.txt"]) == :unknown
      assert CommandActionClassifier.classify(["find", ".", "-name", "*.ex", "-fls", "matches.txt"]) == :unknown
      assert CommandActionClassifier.classify(["find", ".", "-exec", "rm", "{}", ";"]) == :unknown
    end

    test "falls back to unknown for invalid or unsupported commands" do
      assert CommandActionClassifier.classify([]) == :unknown
      assert CommandActionClassifier.classify(["mix", "test"]) == :unknown
      assert CommandActionClassifier.classify(["git", "status"]) == :unknown
      assert CommandActionClassifier.classify(["cat", ""]) == :unknown
      assert CommandActionClassifier.classify(%{}) == :unknown
    end
  end

  test "metadata uses external event vocabulary" do
    assert CommandActionClassifier.metadata(["ls", "apps"]) == %{"command_action" => "listFiles"}
    assert CommandActionClassifier.metadata(["rg", "TODO"]) == %{"command_action" => "search"}
    assert CommandActionClassifier.metadata(["mix", "test"]) == %{"command_action" => "unknown"}
  end
end
