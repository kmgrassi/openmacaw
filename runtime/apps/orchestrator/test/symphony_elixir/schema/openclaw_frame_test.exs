defmodule SymphonyElixir.Schema.OpenClawFrameTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Schema.OpenClawFrame

  describe "validate/1" do
    test "validates gateway chat frames into typed structs" do
      assert {:ok, %OpenClawFrame.Chat{state: :streaming, payload: payload}} =
               OpenClawFrame.validate(%{
                 "type" => "event",
                 "event" => "chat",
                 "payload" => %{
                   "state" => "streaming",
                   "message" => %{"role" => "assistant", "content" => "hello"}
                 }
               })

      assert payload["message"]["content"] == "hello"
    end

    test "rejects malformed chat frame state with field-level reasons" do
      assert {:error, {:invalid_field, "payload.state", :expected_string}} =
               OpenClawFrame.validate(%{
                 "type" => "event",
                 "event" => "chat",
                 "payload" => %{"state" => 42}
               })
    end

    test "accepts chat error frames without requiring string error text" do
      assert {:ok, %OpenClawFrame.Chat{state: :error}} =
               OpenClawFrame.validate(%{
                 "type" => "event",
                 "event" => "chat",
                 "payload" => %{"state" => "error"}
               })

      assert {:ok, %OpenClawFrame.Chat{state: :error}} =
               OpenClawFrame.validate(%{
                 "type" => "event",
                 "event" => "chat",
                 "payload" => %{"state" => "error", "error" => %{"code" => "backend_failed"}}
               })
    end

    test "validates backend event frames into typed structs" do
      assert {:ok, %OpenClawFrame.BackendEvent{event: :message_delta, raw: raw}} =
               OpenClawFrame.validate(%{"type" => "message.delta", "text" => "part"})

      assert raw["text"] == "part"

      assert {:ok, %OpenClawFrame.BackendEvent{event: :run_completed}} =
               OpenClawFrame.validate(%{"event" => "run.completed", "output" => "done"})
    end

    test "rejects unsupported and malformed backend frames" do
      assert {:error, {:unsupported_event_type, "unknown.event"}} =
               OpenClawFrame.validate(%{"type" => "unknown.event"})

      assert {:error, {:invalid_field, "text", :expected_string}} =
               OpenClawFrame.validate(%{"type" => "message.delta", "text" => 12})
    end
  end
end
