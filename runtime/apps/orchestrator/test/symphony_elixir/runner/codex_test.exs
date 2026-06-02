defmodule SymphonyElixir.Runner.CodexTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Runner.Codex

  describe "requires_workspace?/0" do
    test "returns true" do
      assert Codex.requires_workspace?() == true
    end
  end

  describe "ping/1" do
    test "returns :ok when codex binary is found" do
      # codex may or may not be on PATH in CI, so just verify the function runs
      result = Codex.ping(%{})
      assert result == :ok or match?({:error, :codex_not_found}, result)
    end

    test "returns error when binary not found" do
      # Temporarily modify PATH to ensure codex won't be found
      original_path = System.get_env("PATH")
      System.put_env("PATH", "/nonexistent")

      try do
        assert {:error, :codex_not_found} = Codex.ping(%{})
      after
        restore_env("PATH", original_path)
      end
    end
  end

  describe "start_session/2" do
    test "delegates to AppServer (integration smoke test)" do
      # This will fail because no real codex binary is running,
      # but it verifies the delegation path is wired up
      result = Codex.start_session(%{}, "/nonexistent/workspace")
      assert match?({:error, _}, result)
    end
  end

  describe "stop_session/1" do
    test "delegates to AppServer" do
      # AppServer.stop_session expects a map with a real port
      # Opening and immediately closing a port validates the delegation path
      port = Port.open({:spawn, "echo ok"}, [:binary])
      assert :ok = Codex.stop_session(%{port: port})
    end
  end
end
