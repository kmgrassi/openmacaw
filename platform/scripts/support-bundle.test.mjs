import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = resolve("scripts/support-bundle.mjs");

test("support bundle writes a manifest and redacts raw log excerpts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "support-bundle-"));

  try {
    await mkdir(join(cwd, ".run-logs"));
    await writeFile(
      join(cwd, ".run-logs", "api.log"),
      "2026-05-11T12:01:00.000Z ERROR request_failed api_key=sk-test password=hunter2\n",
    );
    await writeFile(
      join(cwd, ".run-logs", "web.log"),
      "2026-05-11T12:02:00.000Z [vite] Authorization: Bearer abc.def.ghi\n",
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [scriptPath, "--raw-log-lines", "20"],
      { cwd },
    );

    const bundlePath = stdout.match(/^path: (.+)$/m)?.[1];
    assert.ok(bundlePath);

    const manifest = JSON.parse(
      await readFile(join(cwd, bundlePath, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.status, "warn");
    assert.ok(
      manifest.included.some((item) => item.name === "schema diagnostics"),
    );
    assert.ok(
      manifest.skipped.some((item) => item.name === "agent diagnostic"),
    );

    const apiLog = await readFile(
      join(cwd, bundlePath, "raw-logs", "api.log"),
      "utf8",
    );
    const webLog = await readFile(
      join(cwd, bundlePath, "raw-logs", "web.log"),
      "utf8",
    );
    assert.match(apiLog, /api_key=\[redacted\]/);
    assert.match(apiLog, /password=\[redacted\]/);
    assert.doesNotMatch(apiLog, /sk-test|hunter2/);
    assert.match(webLog, /Authorization=\[redacted\]/);
    assert.doesNotMatch(webLog, /abc\.def\.ghi/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
