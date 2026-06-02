import type {
  ChatAbortParams,
  ChatAbortResult,
  ChatEventPayload,
  ChatSendParams,
  ChatSendResult,
} from "./chat";
import type { GatewayError } from "./errors";
import type { RuntimeEventPayload, RuntimeGatewayEventName } from "./runtime";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type GatewayMethodParams = {
  connect: ConnectParams;
  "chat.send": ChatSendParams;
  "chat.abort": ChatAbortParams;
};

export type GatewayMethodResult = {
  connect: GatewayHelloOk;
  "chat.send": ChatSendResult;
  "chat.abort": ChatAbortResult;
};

export type GatewayMethod = keyof GatewayMethodParams;

type KnownGatewayRequestFrame = {
  [Method in GatewayMethod]: {
    type: "req";
    id: string;
    method: Method;
    params: GatewayMethodParams[Method];
  };
}[GatewayMethod];

export type UnknownGatewayRequestFrame = {
  type: "req";
  id: string;
  method: Exclude<string, GatewayMethod>;
  params?: JsonValue;
};

export type GatewayRequestFrame =
  | KnownGatewayRequestFrame
  | UnknownGatewayRequestFrame;

type GatewaySuccessPayload = GatewayMethodResult[GatewayMethod] | JsonValue;

export type GatewaySuccessResponseFrame = {
  type: "res";
  id: string;
  ok: true;
  payload?: GatewaySuccessPayload;
};

export type GatewayErrorResponseFrame = {
  type: "res";
  id: string;
  ok: false;
  error: GatewayError;
};

export type GatewayResponseFrame =
  | GatewaySuccessResponseFrame
  | GatewayErrorResponseFrame;

export type ConnectChallengePayload = {
  nonce: string;
};

export type ConnectChallengeEventFrame = {
  type: "event";
  event: "connect.challenge";
  payload: ConnectChallengePayload;
  seq?: number;
};

export type ChatEventFrame = {
  type: "event";
  event: "chat";
  payload: ChatEventPayload;
  seq?: number;
};

export type RuntimeGatewayEventFrame = {
  type: "event";
  event: RuntimeGatewayEventName;
  payload: RuntimeEventPayload;
  seq?: number;
};

export type UnknownGatewayEventFrame = {
  type: "event";
  event: Exclude<
    string,
    "connect.challenge" | "chat" | RuntimeGatewayEventName
  >;
  payload?: JsonValue;
  seq?: number;
};

export type GatewayEventFrame =
  | ConnectChallengeEventFrame
  | ChatEventFrame
  | RuntimeGatewayEventFrame;

export type GatewayHelloOk = {
  type: "hello-ok";
  protocol: number;
  server?: { version: string; connId: string };
  features?: { methods?: string[]; events?: string[] };
  snapshot?: unknown;
  auth?: { deviceToken?: string; role?: string; scopes?: string[] };
  policy?: { tickIntervalMs?: number };
};

export type GatewayFrame =
  | GatewayRequestFrame
  | GatewayResponseFrame
  | GatewayEventFrame
  | GatewayHelloOk;

export type ConnectParams = {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: string;
    version: string;
    platform: string;
    mode: string;
  };
  role: string;
  scopes: string[];
  device?: {
    id: string;
    publicKey: string;
    signature: string;
    signedAt: number;
    nonce: string | undefined;
  };
  caps: string[];
  auth?: { token?: string; password?: string };
  userAgent: string;
  locale: string;
};
