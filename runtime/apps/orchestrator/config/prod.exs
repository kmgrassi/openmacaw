import Config

relay_socket_port =
  case System.get_env("RELAY_SOCKET_PORT") do
    nil ->
      4000

    "" ->
      4000

    value ->
      case Integer.parse(value) do
        {port, ""} when port >= 0 ->
          port

        _ ->
          raise ArgumentError, "RELAY_SOCKET_PORT must be a non-negative integer"
      end
  end

config :symphony_elixir, SymphonyElixirWeb.Endpoint,
  server: true,
  http: [ip: {0, 0, 0, 0}, port: relay_socket_port]

config :symphony_elixir, relay_socket_default_port: relay_socket_port

# ---------------------------------------------------------------------------
# Production token validator + presence recorder for the local runtime helper.
# Both query `local_runtime_token` / `local_runtime_machine` in `harper-server`
# through `PostgRESTClient` (service-role key), not Ecto — the relay socket
# runs in launcher escript mode, which never starts `SymphonyElixir.Repo`.
# Dev and test continue to use the env-based `TokenValidator.Config` /
# `MachineHeartbeatRecorder.Noop` defaults.
# ---------------------------------------------------------------------------
config :symphony_elixir,
  local_relay_token_validator: SymphonyElixir.LocalRelay.TokenValidator.PostgREST,
  local_relay_machine_heartbeat_recorder: SymphonyElixir.LocalRelay.MachineHeartbeatRecorder.PostgREST,
  local_relay_require_tls: true
