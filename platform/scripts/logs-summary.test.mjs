import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = resolve("scripts/logs-summary.mjs");

test("logs summary groups JSON API failures and web errors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "logs-summary-"));

  try {
    await mkdir(join(cwd, ".run-logs"));
    await writeFile(
      join(cwd, ".run-logs", "api.log"),
      [
        JSON.stringify({
          level: "error",
          timestamp: "2026-05-11T12:01:00.000Z",
          event: "request_failed",
          service: "symphony-express-server",
          trace_id: "trc_1",
          request_id: "req_1",
          agent_id: "agent-1",
          workspace_id: "workspace-1",
          method: "GET",
          route_pattern: "/api/foo",
          status_code: 500,
          error_code: "boom",
          message: "Supabase query failed",
        }),
        "{malformed",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, ".run-logs", "web.log"),
      "2026-05-11T12:02:00.000Z [vite] Internal server error\n",
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [scriptPath, "--since", "365d", "--agent-id", "agent-1", "--json"],
      { cwd },
    );
    const output = JSON.parse(stdout);

    assert.equal(output.status, "warn");
    assert.equal(output.summary.warningOrErrorRecords, 2);
    assert.equal(output.highlights.lastRequestFailure.statusCode, 500);
    assert.equal(output.highlights.lastSupabaseFailure.agentId, "agent-1");
    assert.equal(output.highlights.lastBrowserError.category, "browser");
    assert.match(output.warnings[0], /Malformed JSON/);
    assert.equal("raw" in output.recentRecords[0], false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("logs summary warns instead of crashing when logs are missing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "logs-summary-missing-"));

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [scriptPath, "--json"],
      { cwd },
    );
    const output = JSON.parse(stdout);

    assert.equal(output.status, "warn");
    assert.equal(output.summary.totalRecords, 0);
    assert.deepEqual(
      output.warnings.sort(),
      [
        "api log missing: .run-logs/api.log",
        "web log missing: .run-logs/web.log",
      ].sort(),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("logs summary parses pretty API request failures", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "logs-summary-pretty-"));

  try {
    await mkdir(join(cwd, ".run-logs"));
    await writeFile(
      join(cwd, ".run-logs", "api.log"),
      "2026-05-11T12:03:00.000Z WARN  request_failed POST /api/work-items status=401 duration_ms=12 error_code=auth_required request_id=req-pretty\n",
    );
    await writeFile(join(cwd, ".run-logs", "web.log"), "");

    const { stdout } = await execFileAsync(
      process.execPath,
      [scriptPath, "--since", "365d", "--json"],
      { cwd },
    );
    const output = JSON.parse(stdout);

    assert.equal(output.summary.warningOrErrorRecords, 1);
    assert.equal(output.highlights.lastRequestFailure.event, "request_failed");
    assert.equal(output.highlights.lastRequestFailure.method, "POST");
    assert.equal(output.highlights.lastRequestFailure.route, "/api/work-items");
    assert.equal(output.highlights.lastRequestFailure.statusCode, 401);
    assert.equal(
      output.highlights.lastRequestFailure.errorCode,
      "auth_required",
    );
    assert.equal(output.groups[0].group.requestId, "req-pretty");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
