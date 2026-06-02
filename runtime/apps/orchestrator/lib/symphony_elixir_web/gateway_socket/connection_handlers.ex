defmodule SymphonyElixirWeb.GatewaySocket.ConnectionHandlers do
  @moduledoc false

  alias SymphonyElixir.Gateway.SessionStore
  alias SymphonyElixirWeb.Gateway.{Frame, Middleware}
  alias SymphonyElixirWeb.GatewaySocket.{Logging, MessageLogger}

  @spec handle(String.t(), term(), map() | nil, map(), map()) :: {:handled, {[Frame.text_frame()], map()}} | :not_handled
  def handle("connect", id, _params, state, context) do
    case state.scope do
      nil ->
        Logging.log(:warning, :gateway_ws_upstream_failed, state, %{
          request_id: id,
          frame_method: "connect",
          error_code: "runtime_scope_required",
          reason: "runtime_scope_required",
          retryable: false
        })

        {:handled, {[Frame.response(id, false, nil, Middleware.normalize_error(:runtime_scope_required))], state}}

      scope ->
        agent = Middleware.agent_or_placeholder(scope.agent_id)

        SessionStore.ensure_session(scope,
          label: agent.name || scope.session_key,
          display_name: agent.name,
          model: model_name(agent)
        )

        session_thread_id = MessageLogger.upsert_session_thread(state, agent)

        hello = %{
          type: "hello-ok",
          protocol: context.protocol_version,
          server: %{version: "0.1.0", connId: Ecto.UUID.generate()},
          features: %{methods: context.supported_methods, events: context.supported_events},
          snapshot: %{},
          auth: %{
            role: "operator",
            scopes: ["operator.admin", "operator.approvals", "operator.pairing"]
          },
          policy: %{tickIntervalMs: 30_000}
        }

        Logging.log(:info, :request_completed, state, %{
          request_id: id,
          frame_method: "connect",
          protocol_version: context.protocol_version
        })

        {:handled, {[Frame.text(hello)], %{state | connected?: true, session_thread_id: session_thread_id}}}
    end
  end

  def handle("models.list", id, _params, %{scope: scope} = state, _context) do
    models =
      case scope && Middleware.agent_or_placeholder(scope.agent_id) do
        %{model_settings: %{"model" => model, "provider" => provider}}
        when is_binary(model) and is_binary(provider) ->
          [%{id: model, name: model, provider: provider}]

        %{model_settings: %{model: model, provider: provider}}
        when is_binary(model) and is_binary(provider) ->
          [%{id: model, name: model, provider: provider}]

        _ ->
          [%{id: "codex-default", name: "Codex Default", provider: "openai"}]
      end

    {:handled, {[Frame.response(id, true, %{models: models}, nil)], state}}
  end

  def handle(_method, _id, _params, _state, _context), do: :not_handled

  defp model_name(agent) do
    model_settings = Map.get(agent, :model_settings) || Map.get(agent, "model_settings") || %{}
    Map.get(model_settings, "model") || Map.get(model_settings, :model)
  end
end
