defmodule SymphonyElixir.Launcher.SupervisorTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.Launcher.Supervisor, as: LauncherSupervisor

  @env "LAUNCHER_BIND_HOST"
  @app_key :launcher_bind_host

  setup do
    prior_env = System.get_env(@env)
    prior_app = Application.get_env(:symphony_elixir, @app_key)

    on_exit(fn ->
      restore_env(@env, prior_env)
      restore_app(@app_key, prior_app)
    end)

    System.delete_env(@env)
    Application.delete_env(:symphony_elixir, @app_key)

    :ok
  end

  test "starts PubSub before manager bootstrapper" do
    assert {:ok, {_flags, children}} = LauncherSupervisor.init(port: 0)

    child_ids = Enum.map(children, & &1.id)

    assert Enum.find_index(child_ids, &(&1 == Phoenix.PubSub.Supervisor)) <
             Enum.find_index(child_ids, &(&1 == SymphonyElixir.Manager.Bootstrapper))
  end

  test "starts the isolated LocalRelay.Supervisor before the manager" do
    # The relay lives in its own supervised subtree (so a relay crash-loop can't
    # take down orchestrator launching), and must start before the manager so
    # the registry is available when the manager first dispatches.
    assert {:ok, {_flags, children}} = LauncherSupervisor.init(port: 0)
    child_ids = Enum.map(children, & &1.id)

    assert SymphonyElixir.LocalRelay.Supervisor in child_ids

    assert Enum.find_index(child_ids, &(&1 == SymphonyElixir.LocalRelay.Supervisor)) <
             Enum.find_index(child_ids, &(&1 == SymphonyElixir.Manager.Bootstrapper))
  end

  describe "launcher_bind_ip/0" do
    test "defaults to loopback IPv4 when nothing is configured" do
      assert {127, 0, 0, 1} = LauncherSupervisor.launcher_bind_ip()
    end

    test "accepts an IPv4 literal from LAUNCHER_BIND_HOST" do
      System.put_env(@env, "0.0.0.0")
      assert {0, 0, 0, 0} = LauncherSupervisor.launcher_bind_ip()
    end

    test "accepts an IPv6 literal from LAUNCHER_BIND_HOST" do
      System.put_env(@env, "::1")

      assert {0, 0, 0, 0, 0, 0, 0, 1} = LauncherSupervisor.launcher_bind_ip()
    end

    test "env var takes precedence over Application config" do
      Application.put_env(:symphony_elixir, @app_key, "10.0.0.1")
      System.put_env(@env, "192.168.1.1")

      assert {192, 168, 1, 1} = LauncherSupervisor.launcher_bind_ip()
    end

    test "falls back to Application config when env var is unset" do
      Application.put_env(:symphony_elixir, @app_key, "10.0.0.1")

      assert {10, 0, 0, 1} = LauncherSupervisor.launcher_bind_ip()
    end

    test "returns loopback when the override is unparseable" do
      System.put_env(@env, "not an ip")

      assert {127, 0, 0, 1} = LauncherSupervisor.launcher_bind_ip()
    end

    test "returns loopback when the override is empty" do
      System.put_env(@env, "")

      assert {127, 0, 0, 1} = LauncherSupervisor.launcher_bind_ip()
    end

    test "accepts a valid IPv4 tuple from Application config" do
      Application.put_env(:symphony_elixir, @app_key, {10, 0, 0, 1})

      assert {10, 0, 0, 1} = LauncherSupervisor.launcher_bind_ip()
    end

    test "returns loopback when IPv4 tuple has out-of-range octets" do
      Application.put_env(:symphony_elixir, @app_key, {999, 0, 0, 1})

      assert {127, 0, 0, 1} = LauncherSupervisor.launcher_bind_ip()
    end

    test "returns loopback when IPv4 tuple has non-integer elements" do
      Application.put_env(:symphony_elixir, @app_key, {"127", 0, 0, 1})

      assert {127, 0, 0, 1} = LauncherSupervisor.launcher_bind_ip()
    end

    test "returns loopback when IPv4 tuple has a negative octet" do
      Application.put_env(:symphony_elixir, @app_key, {-1, 0, 0, 1})

      assert {127, 0, 0, 1} = LauncherSupervisor.launcher_bind_ip()
    end

    test "returns loopback when IPv6 tuple has an out-of-range segment" do
      Application.put_env(:symphony_elixir, @app_key, {0, 0, 0, 0, 0, 0, 0, 70_000})

      assert {127, 0, 0, 1} = LauncherSupervisor.launcher_bind_ip()
    end

    test "returns loopback when the override is an arbitrary non-ip term" do
      Application.put_env(:symphony_elixir, @app_key, %{not: :an_ip})

      assert {127, 0, 0, 1} = LauncherSupervisor.launcher_bind_ip()
    end
  end

  defp restore_env(name, nil), do: System.delete_env(name)
  defp restore_env(name, value), do: System.put_env(name, value)

  defp restore_app(key, nil), do: Application.delete_env(:symphony_elixir, key)
  defp restore_app(key, value), do: Application.put_env(:symphony_elixir, key, value)
end
