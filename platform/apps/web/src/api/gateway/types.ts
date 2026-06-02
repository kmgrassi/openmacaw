import type { GatewayHelloOk } from "../ws-types";
import type { GatewayEventFrame } from "../ws-types";

export type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

export type GatewayClientOptions = {
  url: string;
  protocols?: string[];
  token?: string;
  onOpen?: () => void;
  onSendFrame?: (frameType: string) => void;
  onReceiveFrame?: (frameType: string) => void;
  onHello?: (hello: GatewayHelloOk) => void;
  onEvent?: (evt: GatewayEventFrame) => void;
  onClose?: (info: { code: number; reason: string }) => void;
};
