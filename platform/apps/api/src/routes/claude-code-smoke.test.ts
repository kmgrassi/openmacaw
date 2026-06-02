import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClaudeCodeSmokeResponseSchema } from "../../../../contracts/claude-code-smoke.js";
import { registerClaudeCodeSmokeRoutes } from "./claude-code-smoke.js";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("Claude Code dispatch smoke route", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    const app = express();
    registerClaudeCodeSmokeRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("returns browser-visible evidence for planning to Claude Code coding dispatch", async () => {
    const response = await fetch(`${baseUrl}/api/smoke/claude-code-dispatch`);

    expect(response.status).toBe(200);
    const body = ClaudeCodeSmokeResponseSchema.parse(await response.json());

    expect(body.liveProviderCalls).toBe(false);
    expect(body.profiles.planning.agentRole).toBe("planning");
    expect(body.profiles.coding.agentRole).toBe("coding");
    expect(body.profiles.coding.runnerKind).toBe("claude_code");
    expect(body.profiles.coding.provider).toBe("anthropic");
    expect(body.workItem.status).toBe("completed");
    expect(body.dispatch.workItemId).toBe(body.workItem.id);
    expect(body.dispatch.runtimeProfile).toEqual({
      role: "coding",
      runner_kind: "claude_code",
      provider: "anthropic",
      model: "sonnet",
      credential_ref: "credential_alias:anthropic/default",
      tool_profile: "coding",
    });
    expect(body.normalizedEvents.map((event) => event.kind)).toEqual([
      "assistant_delta",
      "tool_started",
      "tool_completed",
      "turn_completed",
      "usage_reported",
    ]);
    expect(body.normalizedEvents.every((event) => event.visibleInDashboard)).toBe(true);
    expect(body.workspaceEvidence.logLines.join("\n")).toContain("run_status=completed");
    expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|token|secret|(^|[^a-z])sk-[a-z0-9-]{6,}/i);
  });

  it("allows browser tests to override the visible Claude model without accepting secrets", async () => {
    const response = await fetch(`${baseUrl}/api/smoke/claude-code-dispatch?model=sk-should-not-appear`);

    expect(response.status).toBe(200);
    const body = ClaudeCodeSmokeResponseSchema.parse(await response.json());

    expect(body.profiles.coding.model).toBe("sonnet");
    expect(body.dispatch.runtimeProfile.model).toBe("sonnet");
    expect(JSON.stringify(body)).not.toContain("sk-should-not-appear");
  });
});
