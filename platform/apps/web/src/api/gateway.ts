export { GatewayClient } from "./gateway/client";
export type { GatewayClientOptions } from "./gateway/types";
export { gatewayAuthProtocols, resolveGatewayWsUrl, withGatewayRuntimeScope } from "./gateway/url";

export type {
  GatewayEventFrame,
  GatewayHelloOk,
  GatewayResponseFrame,
} from "./ws-types";
