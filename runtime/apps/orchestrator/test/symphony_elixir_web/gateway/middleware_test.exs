defmodule SymphonyElixirWeb.Gateway.MiddlewareTest do
  use ExUnit.Case, async: true

  alias SymphonyElixirWeb.Gateway.Middleware

  @scope %{
    agent_id: "agent-1",
    workspace_id: "workspace-1",
    user_id: "user-1",
    session_key: "session-1"
  }

  test "requires request scope to match connection scope" do
    params = %{"agent_id" => "agent-1", "workspace_id" => "workspace-1", "sessionKey" => "session-1"}

    assert {:ok, @scope} = Middleware.require_scope(@scope, params)
    assert {:ok, @scope} = Middleware.require_scope(%{scope: @scope}, Map.delete(params, "sessionKey"))
  end

  test "uses connection scope as the session partition when frame session key differs" do
    params = %{"agent_id" => "agent-1", "workspace_id" => "workspace-1", "sessionKey" => "client-echoed-key"}

    assert {:ok, @scope} = Middleware.require_scope(@scope, params)
  end

  test "rejects missing or mismatched scope" do
    assert {:error, :runtime_scope_required} = Middleware.require_scope(nil, %{})

    assert {:error, :scope_mismatch} =
             Middleware.require_scope(@scope, %{"agent_id" => "agent-2", "workspace_id" => "workspace-1"})
  end

  test "normalizes known and unknown errors" do
    assert Middleware.normalize_error(:agent_not_found) == %{code: "agent_not_found", message: "agent not found"}
    assert Middleware.normalize_error({:bad, :thing}) == %{code: "internal_error", message: "{:bad, :thing}"}
  end
end
