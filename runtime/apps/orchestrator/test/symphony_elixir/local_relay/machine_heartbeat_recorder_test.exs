defmodule SymphonyElixir.LocalRelay.MachineHeartbeatRecorderTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.LocalRelay.MachineHeartbeatRecorder

  defmodule CaptureRecorder do
    @behaviour SymphonyElixir.LocalRelay.MachineHeartbeatRecorder

    @impl true
    def record_register(machine_id, fields) do
      send(self(), {:record_register, machine_id, fields})
      :ok
    end

    @impl true
    def record_heartbeat(machine_id, fields) do
      send(self(), {:record_heartbeat, machine_id, fields})
      :ok
    end

    @impl true
    def record_disconnect(machine_id) do
      send(self(), {:record_disconnect, machine_id})
      :ok
    end
  end

  setup do
    original =
      Application.get_env(:symphony_elixir, :local_relay_machine_heartbeat_recorder)

    Application.put_env(:symphony_elixir, :local_relay_machine_heartbeat_recorder, CaptureRecorder)

    on_exit(fn ->
      if original do
        Application.put_env(:symphony_elixir, :local_relay_machine_heartbeat_recorder, original)
      else
        Application.delete_env(:symphony_elixir, :local_relay_machine_heartbeat_recorder)
      end
    end)

    :ok
  end

  test "record_register forwards machine_id and fields to the configured adapter" do
    assert :ok =
             MachineHeartbeatRecorder.record_register("machine-1", %{
               helper_version: "0.1.0",
               advertised_runner_kinds: ["openai_compatible"]
             })

    assert_received {:record_register, "machine-1",
                     %{helper_version: "0.1.0", advertised_runner_kinds: ["openai_compatible"]}}
  end

  test "record_heartbeat forwards machine_id and fields to the configured adapter" do
    assert :ok =
             MachineHeartbeatRecorder.record_heartbeat("machine-1", %{
               helper_version: "0.1.0",
               advertised_runner_kinds: ["openai_compatible"]
             })

    assert_received {:record_heartbeat, "machine-1",
                     %{helper_version: "0.1.0", advertised_runner_kinds: ["openai_compatible"]}}
  end

  test "record_disconnect forwards only the machine_id" do
    assert :ok = MachineHeartbeatRecorder.record_disconnect("machine-1")
    assert_received {:record_disconnect, "machine-1"}
  end

  test "Noop adapter is the default and silently drops calls" do
    Application.delete_env(:symphony_elixir, :local_relay_machine_heartbeat_recorder)

    assert :ok = MachineHeartbeatRecorder.record_register("machine-1", %{})
    assert :ok = MachineHeartbeatRecorder.record_heartbeat("machine-1", %{})
    assert :ok = MachineHeartbeatRecorder.record_disconnect("machine-1")

    refute_received {:record_register, _, _}
    refute_received {:record_heartbeat, _, _}
    refute_received {:record_disconnect, _}
  end
end
