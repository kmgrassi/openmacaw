import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";

import { registerLocalRuntimeRoutes } from "./local-runtime.js";

export const workspaceId = "22222222-2222-4222-8222-222222222222";
export const userId = "11111111-1111-4111-8111-111111111111";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function createLocalRuntimeTestServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.header("authorization") === "Bearer test-token") {
      req.userId = userId;
    }
    next();
  });
  registerLocalRuntimeRoutes(app);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  return {
    server,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => closeServer(server),
  };
}
