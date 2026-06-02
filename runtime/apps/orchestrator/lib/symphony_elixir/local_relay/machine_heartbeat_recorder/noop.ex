defmodule SymphonyElixir.LocalRelay.MachineHeartbeatRecorder.Noop do
  @moduledoc """
  Default heartbeat recorder used in dev and test. Drops every call.

  Production overrides `:local_relay_machine_heartbeat_recorder` to
  `SymphonyElixir.LocalRelay.MachineHeartbeatRecorder.PostgREST`.
  """

  @behaviour SymphonyElixir.LocalRelay.MachineHeartbeatRecorder

  @impl true
  def record_register(_machine_id, _fields), do: :ok

  @impl true
  def record_heartbeat(_machine_id, _fields), do: :ok

  @impl true
  def record_disconnect(_machine_id), do: :ok
end
