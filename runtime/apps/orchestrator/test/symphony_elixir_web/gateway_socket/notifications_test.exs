defmodule SymphonyElixirWeb.GatewaySocket.NotificationsTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixirWeb.GatewaySocket.Notifications

  describe "chat_delta_event/3" do
    test "translates canonical runner delta notifications into chat events" do
      message = %{
        event: :notification,
        payload: %{
          "method" => "item/agentMessage/delta",
          "params" => %{"msg" => %{"payload" => %{"delta" => "hello"}}}
        }
      }

      assert {:ok,
              %{
                runId: "run-1",
                sessionKey: "session-1",
                state: "delta",
                message: "hello"
              }} = Notifications.chat_delta_event("session-1", "run-1", message)
    end

    test "keeps legacy method-less delta payloads supported" do
      message = %{event: :notification, payload: %{"params" => %{"textDelta" => "legacy"}}}

      assert {:ok, %{message: "legacy"}} =
               Notifications.chat_delta_event("session-1", "run-1", message)
    end

    test "ignores duplicate codex notification aliases" do
      message = %{
        event: :notification,
        payload: %{
          "method" => "codex/event/agent_message_delta",
          "params" => %{"textDelta" => "duplicate"}
        }
      }

      assert :ignore = Notifications.chat_delta_event("session-1", "run-1", message)
    end

    test "ignores non-notification messages and empty deltas" do
      assert :ignore = Notifications.chat_delta_event("session-1", "run-1", %{event: :turn_started})

      assert :ignore =
               Notifications.chat_delta_event("session-1", "run-1", %{
                 event: :notification,
                 payload: %{"method" => "item/agentMessage/delta", "params" => %{"textDelta" => ""}}
               })
    end
  end
end
