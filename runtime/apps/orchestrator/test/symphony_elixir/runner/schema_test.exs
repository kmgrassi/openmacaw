defmodule SymphonyElixir.Runner.SchemaTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Config

  describe "runner config schema" do
    test "defaults to codex runner" do
      settings = Config.settings!()
      assert settings.runners.default == "codex"
    end

    test "runner config defaults are empty maps" do
      settings = Config.settings!()
      assert settings.runners.codex == %{}
      assert settings.runners.openclaw == %{}
      assert settings.runners.openclaw_ws == %{}
      assert settings.runners.computer_use == %{}
      assert settings.runners.local_relay == %{}
    end

    test "runner_config/0 returns structured config" do
      config = Config.runner_config()
      assert config["default"] == "codex"
      assert is_map(config["codex"])
      assert is_map(config["openclaw"])
      assert is_map(config["openclaw_ws"])
      assert is_map(config["computer_use"])
      assert is_map(config["local_relay"])
    end
  end
end
