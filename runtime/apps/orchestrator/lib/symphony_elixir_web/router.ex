defmodule SymphonyElixirWeb.Router do
  @moduledoc """
  Router for Symphony's observability dashboard and API.
  """

  use Phoenix.Router
  import Phoenix.LiveView.Router

  pipeline :browser do
    plug(:fetch_session)
    plug(:fetch_live_flash)
    plug(:put_root_layout, html: {SymphonyElixirWeb.Layouts, :root})
    plug(:protect_from_forgery)
    plug(:put_secure_browser_headers)
  end

  pipeline :protected_api do
    plug(SymphonyElixirWeb.Plugs.RequireServiceRoleBearer)
  end

  scope "/", SymphonyElixirWeb do
    get("/dashboard.css", StaticAssetController, :dashboard_css)
    get("/vendor/phoenix_html/phoenix_html.js", StaticAssetController, :phoenix_html_js)
    get("/vendor/phoenix/phoenix.js", StaticAssetController, :phoenix_js)
    get("/vendor/phoenix_live_view/phoenix_live_view.js", StaticAssetController, :phoenix_live_view_js)
    get("/local-relay/ws", LocalRelayController, :upgrade)
    get("/ws", GatewayController, :upgrade)
  end

  scope "/", SymphonyElixirWeb do
    pipe_through(:browser)

    live("/", DashboardLive, :index)
  end

  scope "/", SymphonyElixirWeb do
    pipe_through(:protected_api)

    get("/api/v1/health", ObservabilityApiController, :health)
    get("/api/v1/state", ObservabilityApiController, :state)
    get("/api/v1/local-runtime/health", ObservabilityApiController, :local_runtime_health)
    get("/api/v1/local-runtime/capabilities", LocalRuntimeController, :capabilities)
    post("/api/v1/local-runtime/register", LocalRuntimeController, :register)
    post("/api/v1/local-runtime/probe", LocalRuntimeController, :probe)

    match(:*, "/", ObservabilityApiController, :method_not_allowed)
    match(:*, "/api/v1/health", ObservabilityApiController, :method_not_allowed)
    match(:*, "/api/v1/state", ObservabilityApiController, :method_not_allowed)
    match(:*, "/api/v1/local-runtime/health", ObservabilityApiController, :method_not_allowed)
    match(:*, "/api/v1/local-runtime/capabilities", ObservabilityApiController, :method_not_allowed)
    match(:*, "/api/v1/local-runtime/register", ObservabilityApiController, :method_not_allowed)
    match(:*, "/api/v1/local-runtime/probe", ObservabilityApiController, :method_not_allowed)
    post("/api/v1/refresh", ObservabilityApiController, :refresh)
    match(:*, "/api/v1/refresh", ObservabilityApiController, :method_not_allowed)
    post("/api/v1/items", ItemsController, :create)
    match(:*, "/api/v1/items", ObservabilityApiController, :method_not_allowed)
    get("/api/v1/:issue_identifier", ObservabilityApiController, :issue)
    match(:*, "/api/v1/:issue_identifier", ObservabilityApiController, :method_not_allowed)
    match(:*, "/*path", ObservabilityApiController, :not_found)
  end
end
