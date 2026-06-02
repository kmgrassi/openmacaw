import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLauncherClient } from "../services/launcher.js";
import type { UpstreamResponse } from "../services/upstream.js";
import { registerSetupRoutes } from "./setup.js";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("setup routes", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.header("authorization") === "Bearer test-token") {
        req.userId = "11111111-1111-4111-8111-111111111111";
      }
      next();
    });
    registerSetupRoutes(
      app,
      createLauncherClient({
        baseUrl: "http://127.0.0.1:1",
        timeoutMs: 1,
        logger: () => undefined,
        maxAttempts: 1,
      }),
      async (): Promise<UpstreamResponse> => ({
        status: 503,
        headers: {},
        body: { error: "launcher_unavailable" },
      }),
    );

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("requires bearer auth before setup state is loaded", async () => {
    const response = await fetch(`${baseUrl}/api/auth/state`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "auth_required",
        message: "Supabase access token is required",
      },
    });
  });

  it("returns a normalized body validation response for create setup", async () => {
    const response = await fetch(`${baseUrl}/api/setup`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId: "" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toBe("Setup request is invalid");
    expect(body.error.details).toHaveProperty("fieldErrors");
  });

  it("requires bearer auth before validating create setup payloads", async () => {
    const response = await fetch(`${baseUrl}/api/setup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId: "" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "auth_required",
        message: "Supabase access token is required",
      },
    });
  });

  it("returns a normalized query validation response for get setup", async () => {
    const response = await fetch(`${baseUrl}/api/setup`, {
      headers: {
        authorization: "Bearer test-token",
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "agentId is required",
      },
    });
  });
});
