import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalModelCodingSmokeResponseSchema } from "../../../../contracts/local-model-coding-smoke.js";
import { registerLocalModelCodingSmokeRoutes } from "./local-model-coding-smoke.js";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("local model coding smoke route", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    const app = express();
    registerLocalModelCodingSmokeRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("returns a fixture for the platform to runtime to workspace mutation smoke path", async () => {
    const response = await fetch(`${baseUrl}/api/smoke/local-model-coding-runner`);

    expect(response.status).toBe(200);
    const body = LocalModelCodingSmokeResponseSchema.parse(await response.json());

    expect(body.liveProviderCalls).toBe(false);
    expect(body.profile.runnerKind).toBe("local_model_coding");
    expect(body.profile.provider).toBe("openai_compatible");
    expect(body.profile.workspacePolicy.sandbox).toBe("workspace-write");
    expect(body.runtimeDispatch.accepted).toBe(true);
    expect(body.toolCalls.map((call) => call.toolSlug)).toEqual(["shell.exec", "apply_patch", "shell.exec"]);
    expect(body.toolCalls[0]?.commandActions).toEqual(["read"]);
    expect(body.workspaceMutation.diff).toContain("+Local coding smoke passed.");
    expect(body.events.map((event) => event.phase)).toEqual([
      "platform_profile_resolved",
      "runtime_dispatch_accepted",
      "local_model_tool_call",
      "shell_exec_completed",
      "apply_patch_completed",
      "workspace_diff_surfaced",
      "ui_events_ready",
    ]);
    expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|token|secret|(^|[^a-z])sk-[a-z0-9-]{6,}/i);
  });

  it("allows visible model and approval policy overrides without accepting secrets", async () => {
    const response = await fetch(
      `${baseUrl}/api/smoke/local-model-coding-runner?model=sk-should-not-appear&approvalPolicy=never`,
    );

    expect(response.status).toBe(200);
    const body = LocalModelCodingSmokeResponseSchema.parse(await response.json());

    expect(body.profile.model).toBe("qwen2.5-coder:latest");
    expect(body.profile.workspacePolicy.approvalPolicy).toBe("never");
    expect(JSON.stringify(body)).not.toContain("sk-should-not-appear");
  });
});
