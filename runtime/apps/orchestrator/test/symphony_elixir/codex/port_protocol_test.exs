defmodule SymphonyElixir.Codex.PortProtocolTest do
  use ExUnit.Case
  import ExUnit.CaptureLog

  alias SymphonyElixir.Codex.PortProtocol

  test "await_response ignores unrelated stream lines and returns the matching result" do
    port = idle_port!()

    try do
      send(self(), {port, {:data, {:eol, "warning: side output"}}})
      send(self(), {port, {:data, {:eol, ~s({"method":"turn/progress"})}}})
      send(self(), {port, {:data, {:eol, ~s({"id":7,"result":{"ok":true}})}}})

      log =
        capture_log(fn ->
          assert {:ok, %{"ok" => true}} = PortProtocol.await_response(port, 7, 100)
        end)

      assert log =~ "Codex response stream output: warning: side output"
    after
      close_port(port)
    end
  end

  test "await_response buffers no-eol chunks before decoding" do
    port = idle_port!()

    try do
      send(self(), {port, {:data, {:noeol, ~s({"id":11,"result":)}}})
      send(self(), {port, {:data, {:eol, ~s({"thread":{"id":"thread-11"}}})}}})

      assert {:ok, %{"thread" => %{"id" => "thread-11"}}} =
               PortProtocol.await_response(port, 11, 100)
    after
      close_port(port)
    end
  end

  test "await_turn delegates complete lines and continues until a terminal result" do
    port = idle_port!()
    test_pid = self()

    try do
      send(self(), {port, {:data, {:eol, ~s({"method":"turn/progress"})}}})
      send(self(), {port, {:data, {:eol, ~s({"method":"turn/completed"})}}})

      dispatcher = fn line ->
        send(test_pid, {:dispatched, line})

        case Jason.decode!(line) do
          %{"method" => "turn/completed"} -> {:ok, :turn_completed}
          _ -> :continue
        end
      end

      assert {:ok, :turn_completed} = PortProtocol.await_turn(port, 100, dispatcher)
      assert_received {:dispatched, ~s({"method":"turn/progress"})}
      assert_received {:dispatched, ~s({"method":"turn/completed"})}
    after
      close_port(port)
    end
  end

  defp idle_port! do
    executable = System.find_executable("sleep") || raise "sleep executable not found"

    Port.open(
      {:spawn_executable, String.to_charlist(executable)},
      [:binary, :exit_status, args: [~c"5"]]
    )
  end

  defp close_port(port) do
    if :erlang.port_info(port) != :undefined do
      Port.close(port)
    end
  rescue
    ArgumentError -> :ok
  end
end
