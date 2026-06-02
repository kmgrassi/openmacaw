defmodule SymphonyElixir.LocalRelay.SupervisorTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.LocalRelay.EndpointServer
  alias SymphonyElixir.LocalRelay.Supervisor, as: RelaySupervisor

  @relay_env "RELAY_SOCKET_PORT"

  setup do
    prior = System.get_env(@relay_env)

    on_exit(fn ->
      case prior do
        nil -> System.delete_env(@relay_env)
        value -> System.put_env(@relay_env, value)
      end
    end)

    :ok
  end

  describe "init/1 children" do
    test "always includes Registry and Presence, even with no relay port" do
      # The manager dispatches via LocalRelay.Registry.lookup and must never hit
      # a missing process, so these start regardless of RELAY_SOCKET_PORT.
      System.delete_env(@relay_env)

      assert {:ok, {_flags, children}} = RelaySupervisor.init([])
      child_ids = Enum.map(children, & &1.id)

      assert SymphonyElixir.LocalRelay.Registry in child_ids
      assert SymphonyElixir.LocalRelay.Presence in child_ids
    end

    test "has its own restart budget (not the launcher default of 3/5s)" do
      assert {:ok, {flags, _children}} = RelaySupervisor.init([])
      assert flags.intensity == 10
      assert flags.period == 10
    end
  end

  describe "maybe_relay_endpoint/0" do
    test "returns no endpoint child when RELAY_SOCKET_PORT is unset" do
      System.delete_env(@relay_env)
      assert RelaySupervisor.maybe_relay_endpoint() == []
    end

    test "returns the endpoint wrapper child when RELAY_SOCKET_PORT is set" do
      System.put_env(@relay_env, "4200")

      assert [{EndpointServer, opts}] = RelaySupervisor.maybe_relay_endpoint()
      assert Keyword.get(opts, :port) == 4200
      assert Keyword.get(opts, :host) == "0.0.0.0"
    end
  end
end
