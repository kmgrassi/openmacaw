import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";

import type { LauncherRequest } from "../services/local-runtime-machines.js";
import { registerLocalRuntimeRoutes } from "./local-runtime.js";

export const workspaceId = "22222222-2222-4222-8222-222222222222";
export const userId = "11111111-1111-4111-8111-111111111111";

export function withOwnedWorkspace<
  T extends Record<string, unknown[] | undefined> & { workspaces?: Array<Record<string, unknown>> },
>(
  tables: T,
): T & {
  workspaces: Array<Record<string, unknown>>;
} {
  const existing = tables.workspaces ?? [];
  tables.workspaces = [
    {
      id: workspaceId,
      owner_user_id: userId,
    },
    ...existing,
  ];
  return tables as T & {
    workspaces: Array<Record<string, unknown>>;
  };
}

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function createLocalRuntimeTestServer(
  launcherRequest: LauncherRequest = () => Promise.reject(new Error("launcherRequest is not stubbed in this test")),
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.header("authorization") === "Bearer test-token") {
      req.userId = userId;
    }
    next();
  });
  registerLocalRuntimeRoutes(app, launcherRequest);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  return {
    server,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => closeServer(server),
  };
}
