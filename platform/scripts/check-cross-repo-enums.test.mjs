import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = resolve("scripts/check-cross-repo-enums.mjs");

test("cross-repo enum drift self-test catches new runtime diagnostic errors", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    scriptPath,
    "--self-test",
  ]);

  assert.match(stdout, /platform missing \[new_runtime_probe_error\]/);
  assert.match(
    stdout,
    /Self-test passed: injected runtime diagnostic error was detected\./,
  );
});
