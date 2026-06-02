import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ModelAgnosticSmokeResponseSchema } from "../../../../contracts/model-agnostic-smoke.js";
import { registerModelAgnosticSmokeRoutes } from "./model-agnostic-smoke.js";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("model-agnostic smoke route", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    const app = express();
    registerModelAgnosticSmokeRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("returns a fixture handoff with different planning and coding providers", async () => {
    const response = await fetch(`${baseUrl}/api/smoke/model-agnostic-handoff`);

    expect(response.status).toBe(200);
    const body = ModelAgnosticSmokeResponseSchema.parse(await response.json());

    expect(body.liveProviderCalls).toBe(false);
    expect(body.profiles.planning.agentRole).toBe("planning");
    expect(body.profiles.coding.agentRole).toBe("coding");
    expect(body.profiles.planning.provider).not.toBe(body.profiles.coding.provider);
    expect(body.handoff.planId).toBe(body.planDraft.id);
    expect(body.handoff.taskIds).toEqual(["task-api-fixture", "task-browser-fixture"]);
    expect(body.handoff.env).toEqual({
      PLANNER_HANDOFF_APPROVED: "1",
      PLANNER_APPROVED_PLAN_ID: body.planDraft.id,
      PLANNER_APPROVED_TASK_IDS: "task-api-fixture,task-browser-fixture",
    });
    expect(body.logs.join("\n")).toContain("provider_adapter=anthropic_messages_adapter");
    expect(body.logs.join("\n")).toContain("provider_adapter=codex_app_server_adapter");
    expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|token|secret|(^|[^a-z])sk-[a-z0-9-]{6,}/i);
  });

  it("allows browser tests to override visible provider and model settings without accepting secrets", async () => {
    const response = await fetch(
      `${baseUrl}/api/smoke/model-agnostic-handoff?planningProvider=openrouter&planningModel=openrouter/planner&codingProvider=openclaw&codingModel=sk-should-not-appear`,
    );

    expect(response.status).toBe(200);
    const body = ModelAgnosticSmokeResponseSchema.parse(await response.json());

    expect(body.profiles.planning.provider).toBe("openrouter");
    expect(body.profiles.planning.model).toBe("openrouter/planner");
    expect(body.profiles.coding.provider).toBe("openclaw");
    expect(body.profiles.coding.model).toBe("gpt-5.2-smoke");
    expect(JSON.stringify(body)).not.toContain("sk-should-not-appear");
  });
});
