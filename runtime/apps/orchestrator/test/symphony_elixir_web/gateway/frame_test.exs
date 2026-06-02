defmodule SymphonyElixirWeb.Gateway.FrameTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.Schema.GatewayFrame
  alias SymphonyElixir.Schema.GatewayFrame.{Ping, Request}
  alias SymphonyElixirWeb.Gateway.Frame

  test "decodes request frames" do
    frame = Jason.encode!(%{type: "req", id: "req-1", method: "chat.send", params: %{"message" => "hi"}})

    assert {:ok, %Request{id: "req-1", method: "chat.send", params: %{"message" => "hi"}}} =
             Frame.decode(frame)
  end

  test "decodes ping frames" do
    assert {:ok, %Ping{type: :ping, ts: 123}} =
             Frame.decode(Jason.encode!(%{type: "ping", ts: 123}))
  end

  test "returns explicit errors for malformed frames" do
    assert {:error, {:invalid_json, _message}} = Frame.decode("not json")
    assert {:error, {:unsupported_type, "event"}} = Frame.decode(Jason.encode!(%{type: "event", event: "chat"}))

    assert {:error, {:invalid_field, "method", :expected_string}} =
             Frame.decode(Jason.encode!(%{type: "req", id: "req-1", method: 42}))
  end

  test "validates request params as an object when present" do
    assert {:ok, %Request{params: nil}} =
             Frame.decode(Jason.encode!(%{type: "req", id: "req-1", method: "connect"}))

    assert {:error, {:invalid_field, "params", :expected_object}} =
             Frame.decode(Jason.encode!(%{type: "req", id: "req-1", method: "connect", params: []}))
  end

  test "formats validation errors for logging" do
    assert GatewayFrame.error_detail({:missing_field, "id"}) == "missing required field id"
  end

  test "encodes response and event text frames" do
    assert {:text, response_json} = Frame.response("req-1", true, %{ok: true}, nil)
    assert Jason.decode!(response_json) == %{"type" => "res", "id" => "req-1", "ok" => true, "payload" => %{"ok" => true}, "error" => nil}

    assert {:text, event_json} = Frame.event("chat", %{state: "delta"})
    assert Jason.decode!(event_json) == %{"type" => "event", "event" => "chat", "payload" => %{"state" => "delta"}}
  end
end
