import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PlannerLocalModelSmokeResponseSchema } from "../../../../contracts/planner-local-model-smoke.js";
import { registerPlannerLocalModelSmokeRoutes } from "./planner-local-model-smoke.js";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("planner local-model smoke route", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    const app = express();
    registerPlannerLocalModelSmokeRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("returns a fixture for planner local-model routing through work item creation", async () => {
    const response = await fetch(`${baseUrl}/api/smoke/planner-local-model`);

    expect(response.status).toBe(200);
    const body = PlannerLocalModelSmokeResponseSchema.parse(await response.json());

    expect(body.profile).toMatchObject({
      role: "planning",
      runnerKind: "local_relay",
      provider: "local",
      model: "qwen2.5-coder:7b",
      credentialRef: null,
      toolProfile: "planning",
    });
    expect(body.diagnostic).toMatchObject({
      resolved: true,
      localRuntime: { isLocal: true, expectedRunnerKind: "local_relay" },
    });
    expect(body.plannerOutput.workItem).toMatchObject({
      source: "planner",
      state: "ready",
    });
    expect(body.toolCalls.map((call) => call.toolSlug)).toEqual(["plan.create", "task.create"]);
    expect(body.events.map((event) => event.phase)).toEqual([
      "demo_planner_profile_seeded",
      "diagnostic_verified_local_route",
      "runtime_dispatch_accepted",
      "planner_tool_bundle_loaded",
      "plan_created",
      "tasks_created",
      "work_item_created",
      "latency_recorded",
    ]);
    expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|token|secret|(^|[^a-z])sk-[a-z0-9-]{6,}/i);
  });

  it("allows visible model and latency overrides without accepting secrets", async () => {
    const response = await fetch(`${baseUrl}/api/smoke/planner-local-model?model=sk-hidden&observedMs=24000`);

    expect(response.status).toBe(200);
    const body = PlannerLocalModelSmokeResponseSchema.parse(await response.json());

    expect(body.profile.model).toBe("qwen2.5-coder:7b");
    expect(body.latency.observedMs).toBe(24_000);
    expect(JSON.stringify(body)).not.toContain("sk-hidden");
  });
});
