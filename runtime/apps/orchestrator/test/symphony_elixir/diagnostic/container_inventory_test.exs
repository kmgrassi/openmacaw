defmodule SymphonyElixir.Diagnostic.ContainerInventoryTest do
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias SymphonyElixir.Diagnostic.ContainerInventory

  describe "snapshot/0" do
    test "returns the expected shape with boolean presence flags" do
      snap = ContainerInventory.snapshot()

      assert is_map(snap.binaries)
      assert is_map(snap.env_vars)
      assert is_list(snap.missing_binaries)
      assert is_list(snap.missing_env_vars)

      # bash should always be present in any sane environment (CI included)
      assert Map.get(snap.binaries, "bash") == true

      # Every binary tracked must appear in the map with a boolean value
      for {name, present} <- snap.binaries do
        assert is_binary(name)
        assert is_boolean(present)
      end

      for {name, present} <- snap.env_vars do
        assert is_binary(name)
        assert is_boolean(present)
      end

      # missing_binaries should be exactly the keys with `false` values, sorted
      assert snap.missing_binaries ==
               snap.binaries
               |> Enum.reject(fn {_, present} -> present end)
               |> Enum.map(fn {name, _} -> name end)
               |> Enum.sort()
    end
  end

  describe "binary_slice/1" do
    test "returns only the requested keys that are tracked in the snapshot" do
      # bash and codex are both in @required_binaries; an unknown name is
      # silently dropped (binary_slice operates over the snapshot, not an
      # arbitrary lookup).
      slice = ContainerInventory.binary_slice(["bash", "codex", "not-tracked"])
      assert "bash" in Map.keys(slice)
      assert "codex" in Map.keys(slice)
      refute "not-tracked" in Map.keys(slice)
      assert slice["bash"] == true
    end
  end

  describe "emit_startup_log/0" do
    setup do
      # Each emit_startup_log test starts from a clean slate so the
      # :persistent_term idempotence guard doesn't suppress the emission.
      ContainerInventory.reset_emitted_flag_for_test!()
      on_exit(fn -> ContainerInventory.reset_emitted_flag_for_test!() end)
      :ok
    end

    test "is idempotent — second call is a no-op" do
      first =
        capture_log(fn ->
          assert :ok = ContainerInventory.emit_startup_log()
        end)

      second =
        capture_log(fn ->
          assert :ok = ContainerInventory.emit_startup_log()
        end)

      assert first =~ "container_inventory_completed"
      refute second =~ "container_inventory_completed",
             "second emit_startup_log emitted a duplicate completed event"
    end

    test "emits the container_inventory_completed event" do
      log =
        capture_log(fn ->
          assert :ok = ContainerInventory.emit_startup_log()
        end)

      assert log =~ "container_inventory_completed"
      assert log =~ "\"binaries\""
      assert log =~ "\"env_vars\""
      assert log =~ "\"missing_binaries\""
      assert log =~ "\"missing_env_vars\""
    end

    test "does not leak env var values — only presence flags" do
      # Set a marker env var that looks like a secret; presence-only must be logged
      System.put_env("SUPABASE_SERVICE_ROLE_KEY", "this-string-must-not-appear-in-logs")

      on_exit(fn -> System.delete_env("SUPABASE_SERVICE_ROLE_KEY") end)

      log =
        capture_log(fn ->
          ContainerInventory.emit_startup_log()
        end)

      refute log =~ "this-string-must-not-appear-in-logs"
    end

    test "emits a per-missing-binary warning so each is independently grep-able" do
      log =
        capture_log(fn ->
          ContainerInventory.emit_startup_log()
        end)

      # The standard CI environment has bash but not necessarily codex/gh/aws.
      # For any binary that the current snapshot marks missing, the per-binary
      # warning must appear with that binary's name.
      snap = ContainerInventory.snapshot()

      for binary <- snap.missing_binaries do
        assert log =~ "container_inventory_binary_missing", "no warning event in log"
        assert log =~ binary, "missing binary #{binary} not surfaced in per-binary warning"
      end
    end

    test "emits one warning per missing credential GROUP, not per env var" do
      # Force all tracked env vars to be absent
      tracked = ~w(GH_TOKEN GITHUB_TOKEN SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY)
      previous = Enum.map(tracked, fn name -> {name, System.get_env(name)} end)
      Enum.each(tracked, &System.delete_env/1)

      on_exit(fn ->
        Enum.each(previous, fn
          {name, nil} -> System.delete_env(name)
          {name, value} -> System.put_env(name, value)
        end)
      end)

      log =
        capture_log(fn ->
          ContainerInventory.emit_startup_log()
        end)

      # Each missing group surfaces by its group name in the warning payload.
      # The list intentionally tracks only container-level secrets — per-workspace
      # credentials (openai_api_key, anthropic_api_key, etc.) live in Supabase
      # and resolve at agent-start, so they're not required at container boot.
      for credential <- ~w(github_token supabase_url supabase_service_role_key) do
        assert log =~ "container_inventory_env_var_missing"
        assert log =~ credential, "missing credential group #{credential} not surfaced"
      end
    end

    test "does NOT warn for github_token when only GH_TOKEN is set (alias case)" do
      # Codex P2 on PR #438: GH_TOKEN and GITHUB_TOKEN are alternatives. A
      # deployment that sets only GH_TOKEN must not generate a
      # `container_inventory_env_var_missing` warning for the github_token
      # credential group, otherwise every container boot produces a
      # persistent false-positive.
      previous = {
        System.get_env("GH_TOKEN"),
        System.get_env("GITHUB_TOKEN")
      }

      System.put_env("GH_TOKEN", "fake-test-token")
      System.delete_env("GITHUB_TOKEN")

      on_exit(fn ->
        case previous do
          {nil, _} -> System.delete_env("GH_TOKEN")
          {value, _} -> System.put_env("GH_TOKEN", value)
        end

        case previous do
          {_, nil} -> System.delete_env("GITHUB_TOKEN")
          {_, value} -> System.put_env("GITHUB_TOKEN", value)
        end
      end)

      log =
        capture_log(fn ->
          ContainerInventory.emit_startup_log()
        end)

      # The completed event still records GITHUB_TOKEN as absent (data is granular)
      assert log =~ "container_inventory_completed"

      # But no per-credential warning fires for the github_token group, since
      # GH_TOKEN satisfies it.
      refute log =~ "\"credential\":\"github_token\"",
             "github_token group warning emitted even though GH_TOKEN is set"
    end
  end
end
