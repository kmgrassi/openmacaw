defmodule SymphonyElixir.LocalRelay.PresenceTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.LocalRelay.Presence

  @workspace_id "22222222-2222-4222-8222-222222222222"
  @machine_id "machine-local-1"

  setup do
    original_max_connections = Application.get_env(:symphony_elixir, :local_relay_max_connections_per_workspace)
    ensure_presence!()

    on_exit(fn ->
      if original_max_connections,
        do: Application.put_env(:symphony_elixir, :local_relay_max_connections_per_workspace, original_max_connections),
        else: Application.delete_env(:symphony_elixir, :local_relay_max_connections_per_workspace)
    end)

    :ok
  end

  test "scoped offline does not remove a newer connection for the same helper" do
    old_pid = spawn(fn -> Process.sleep(:infinity) end)
    new_pid = spawn(fn -> Process.sleep(:infinity) end)

    on_exit(fn ->
      Process.exit(old_pid, :kill)
      Process.exit(new_pid, :kill)
    end)

    assert :ok =
             Presence.register(%{
               workspace_id: @workspace_id,
               machine_id: @machine_id,
               connection_pid: old_pid
             })

    assert :ok =
             Presence.register(%{
               workspace_id: @workspace_id,
               machine_id: @machine_id,
               connection_pid: new_pid
             })

    assert :stale = Presence.offline(@workspace_id, @machine_id, old_pid)
    assert {:ok, %{connection_pid: ^new_pid}} = Presence.get(@workspace_id, @machine_id)

    assert :ok = Presence.offline(@workspace_id, @machine_id, new_pid)
    assert {:error, :not_found} = Presence.get(@workspace_id, @machine_id)
  end

  test "register evicts an existing connection with the same token hash" do
    test_pid = self()
    old_pid = spawn(fn -> relay_messages(test_pid) end)
    new_pid = spawn(fn -> Process.sleep(:infinity) end)

    on_exit(fn ->
      Process.exit(old_pid, :kill)
      Process.exit(new_pid, :kill)
    end)

    assert :ok =
             Presence.register(%{
               workspace_id: @workspace_id,
               machine_id: @machine_id,
               token_hash: "token-hash-1",
               connection_pid: old_pid
             })

    assert :ok =
             Presence.register(%{
               workspace_id: @workspace_id,
               machine_id: "machine-local-2",
               token_hash: "token-hash-1",
               connection_pid: new_pid
             })

    assert_receive {:presence_test_message, ^old_pid, {:local_relay_evicted, :duplicate_token}}
    assert {:error, :not_found} = Presence.get(@workspace_id, @machine_id)
    assert {:ok, %{connection_pid: ^new_pid}} = Presence.get(@workspace_id, "machine-local-2")
  end

  test "register enforces max connections per workspace" do
    Application.put_env(:symphony_elixir, :local_relay_max_connections_per_workspace, 1)

    first_pid = spawn(fn -> Process.sleep(:infinity) end)
    second_pid = spawn(fn -> Process.sleep(:infinity) end)

    on_exit(fn ->
      Process.exit(first_pid, :kill)
      Process.exit(second_pid, :kill)
    end)

    assert :ok =
             Presence.register(%{
               workspace_id: @workspace_id,
               machine_id: @machine_id,
               token_hash: "token-hash-1",
               connection_pid: first_pid
             })

    assert {:error, :workspace_connection_limit_exceeded} =
             Presence.register(%{
               workspace_id: @workspace_id,
               machine_id: "machine-local-2",
               token_hash: "token-hash-2",
               connection_pid: second_pid
             })

    assert {:ok, %{connection_pid: ^first_pid}} = Presence.get(@workspace_id, @machine_id)
    assert {:error, :not_found} = Presence.get(@workspace_id, "machine-local-2")
  end

  defp relay_messages(test_pid) do
    receive do
      message ->
        send(test_pid, {:presence_test_message, self(), message})
        relay_messages(test_pid)
    end
  end

  defp ensure_presence! do
    case Process.whereis(Presence) do
      nil ->
        start_supervised!(Presence)

      pid when is_pid(pid) ->
        Enum.each(Presence.list(), fn presence ->
          Presence.offline(presence.workspace_id, presence.machine_id)
        end)
    end
  end
end
