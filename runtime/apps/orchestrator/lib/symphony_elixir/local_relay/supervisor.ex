defmodule SymphonyElixir.LocalRelay.Supervisor do
  @moduledoc """
  Isolated supervision subtree for the local-relay components: the registry,
  the presence tracker, and the optional relay socket endpoint.

  Why a dedicated supervisor rather than adding these directly to
  `Launcher.Supervisor`: the relay runs inside the launcher (the always-on
  control plane) so the manager shares a BEAM node with the helper sockets it
  dispatches to. But a crash-looping relay endpoint must NOT exhaust the
  launcher's restart budget and take down orchestrator launching / Codex
  dispatch. Isolating the relay here — with its own restart intensity — keeps a
  relay failure contained.

  `Registry` and `Presence` start unconditionally: the manager dispatches via
  `LocalRelay.Registry.lookup/2` and must never hit a missing process, even
  when no relay socket is exposed. The relay socket endpoint is gated on
  `RELAY_SOCKET_PORT` — production sets it; dev and `mix test` do not, so they
  don't bind a port.
  """

  use Supervisor

  @spec start_link(keyword()) :: Supervisor.on_start()
  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      [
        SymphonyElixir.LocalRelay.Registry,
        SymphonyElixir.LocalRelay.Presence
      ] ++ maybe_relay_endpoint()

    # A more generous budget than the launcher's default (3/5s) so transient
    # endpoint flapping is absorbed locally instead of bubbling a restart up to
    # the launcher's top-level supervisor on every flap.
    Supervisor.init(children, strategy: :one_for_one, max_restarts: 10, max_seconds: 10)
  end

  @doc """
  The relay socket endpoint wrapper child spec when `RELAY_SOCKET_PORT` is
  configured, otherwise an empty list. The wrapper keeps endpoint bind failures
  local and retries internally so the launcher never sees a supervisor crash
  loop from the relay socket port. The endpoint
  (`SymphonyElixirWeb.Endpoint`, serving `/local-relay/ws`) binds `0.0.0.0` on
  its own dedicated port — distinct from the launcher control API and from the
  orchestrator port band.
  """
  @spec maybe_relay_endpoint() :: [Supervisor.child_spec() | {module(), keyword()}]
  def maybe_relay_endpoint do
    case SymphonyElixirWeb.Endpoint.relay_socket_port_from_env() do
      port when is_integer(port) and port > 0 ->
        [{SymphonyElixir.LocalRelay.EndpointServer, port: port, host: "0.0.0.0"}]

      _ ->
        []
    end
  end
end
