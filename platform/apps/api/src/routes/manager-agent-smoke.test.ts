import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ManagerAgentSmokeResponseSchema } from "../../../../contracts/manager-agent-smoke.js";
import { registerManagerAgentSmokeRoutes } from "./manager-agent-smoke.js";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("manager agent smoke route", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    const app = express();
    registerManagerAgentSmokeRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("returns the documented end-to-end manager fixture without live provider calls", async () => {
    const response = await fetch(`${baseUrl}/api/smoke/manager-agent`);

    expect(response.status).toBe(200);
    const body = ManagerAgentSmokeResponseSchema.parse(await response.json());

    expect(body.liveProviderCalls).toBe(false);
    expect(body.workspace.bootstrappedAgents).toEqual(["planning", "coding", "manager"]);
    expect(body.manager.runnerKind).toBe("llm_tool_runner");
    expect(body.manager.credentialRef).toEqual({ type: "alias", value: "manager_provider_primary" });
    expect(body.workItem).toMatchObject({ state: "ready", due: true });
    expect(body.statusTimeline.map((entry) => entry.status)).toEqual([
      "idle_awaiting_credential",
      "not_running",
      "running",
    ]);
    expect(body.statusTimeline.at(-1)).toMatchObject({
      status: "running",
      lastDecisionCount: 1,
      missing: [],
      error: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|token|secret|(^|[^a-z])sk-[a-z0-9-]{6,}/i);
  });
});
