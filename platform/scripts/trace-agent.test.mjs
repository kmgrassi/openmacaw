import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = resolve("scripts/trace-agent.mjs");

test("trace agent reports log evidence across platform and runtime layers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "trace-agent-"));

  try {
    await mkdir(join(cwd, ".run-logs"));
    await writeFile(
      join(cwd, ".run-logs", "api.log"),
      [
        JSON.stringify({
          timestamp: "2026-05-11T12:01:00.000Z",
          level: "info",
          event: "request_finished",
          request_id: "req-1",
          agent_id: "agent-1",
          workspace_id: "workspace-1",
          route_pattern: "/api/agents/:id/messages",
          status_code: 200,
        }),
        JSON.stringify({
          timestamp: "2026-05-11T12:01:01.000Z",
          level: "info",
          event: "launcher_proxy_dispatch",
          request_id: "req-1",
          agent_id: "agent-1",
          run_id: "run-1",
          message: "runtime dispatch started",
        }),
      ].join("\n"),
    );
    await writeFile(join(cwd, ".run-logs", "web.log"), "");
    await writeFile(
      join(cwd, ".run-logs", "runtime.log"),
      JSON.stringify({
        timestamp: "2026-05-11T12:01:02.000Z",
        event: "run_started",
        request_id: "req-1",
        run_id: "run-1",
      }),
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        scriptPath,
        "--root-dir",
        cwd,
        "--since",
        "365d",
        "--request-id",
        "req-1",
        "--run-id",
        "run-1",
        "--json",
      ],
      { cwd },
    );
    const output = JSON.parse(stdout);

    assert.equal(
      output.checks.find((check) => check.layer === "api").status,
      "pass",
    );
    assert.equal(
      output.checks.find((check) => check.layer === "launcher/runtime proxy")
        .status,
      "pass",
    );
    assert.equal(
      output.checks.find((check) => check.layer === "runtime logs").status,
      "pass",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("trace agent exits non-zero when required API log evidence is missing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "trace-agent-missing-"));

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          scriptPath,
          "--root-dir",
          cwd,
          "--request-id",
          "req-missing",
          "--json",
        ],
        { cwd },
      ),
      (error) => {
        const output = JSON.parse(error.stdout);
        assert.equal(output.status, "fail");
        assert.equal(
          output.checks.find((check) => check.layer === "api").status,
          "fail",
        );
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
