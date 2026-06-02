import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  trace_id: string;
  request_id: string;
};

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();
