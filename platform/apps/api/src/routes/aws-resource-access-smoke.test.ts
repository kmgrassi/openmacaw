import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AwsResourceAccessSmokeResponseSchema } from "../../../../contracts/aws-resource-access-smoke.js";
import { registerAwsResourceAccessSmokeRoutes } from "./aws-resource-access-smoke.js";

function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("container execution E1 handoff smoke route", () => {
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    const app = express();
    registerAwsResourceAccessSmokeRoutes(app);

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("returns artifact, failure, and review handoff evidence without secrets", async () => {
    const response = await fetch(`${baseUrl}/api/smoke/container-execution-e1-handoff`);

    expect(response.status).toBe(200);
    const body = AwsResourceAccessSmokeResponseSchema.parse(await response.json());

    expect(body.scenario).toBe("container-execution-e1-handoff");
    expect(body.liveAwsCalls).toBe(false);
    expect(body.resources).toHaveLength(2);
    expect(body.artifacts.map((artifact) => artifact.kind)).toEqual(["summary", "command_log", "patch"]);
    expect(body.commandSummary.map((command) => command.command)).toEqual([
      "git diff --stat",
      "pnpm test -- --runInBand",
    ]);
    expect(body.filesChanged.map((file) => file.path)).toEqual([
      "platform/apps/api/src/services/runtime-dispatch-context.ts",
      "runtime/apps/orchestrator/lib/symphony_elixir/runner/artifacts.ex",
    ]);
    expect(body.failures[0]?.phase).toBe("clone");
    expect(body.reviewHandoff.patchArtifactUri).toBe(body.artifacts.find((artifact) => artifact.kind === "patch")?.uri);
    expect(body.smokeSteps.map((step) => step.name)).toEqual([
      "task_launch",
      "secret_resolution",
      "clone",
      "egress",
      "artifact_write",
      "cleanup",
      "review_handoff",
    ]);
    expect(JSON.stringify(body)).not.toMatch(
      /api[_-]?key\s*[:=]|token\s*[:=]|secret\s*[:=]|(^|[^a-z])sk-[a-z0-9-]{6,}/i,
    );
  });
});
