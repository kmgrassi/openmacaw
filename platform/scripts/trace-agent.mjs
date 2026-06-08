#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasAnyIdentifier,
  identifierMap,
  parseArgs,
  printHelp,
} from "./lib/trace-agent/args.mjs";
import {
  summarizeBrowserArtifacts,
  summarizeDashboard,
  summarizeDiagnostic,
} from "./lib/trace-agent/checks.mjs";
import { printTrace } from "./lib/trace-agent/format.mjs";
import {
  platformLogFiles,
  readLogFiles,
  runtimeLogFiles,
  summarizeLogLayer,
  summarizeRuntimeBoundary,
  summarizeRuntimeLogs,
} from "./lib/trace-agent/logs.mjs";

const SCRIPT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(
    `trace:agent failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

async function main() {
  if (args.help) {
    printHelp();
    return;
  }

  if (!hasAnyIdentifier(args)) {
    throw new Error(
      "Provide at least one of --agent-id, --request-id, --message-id, --tool-call-id, or --run-id",
    );
  }

  const sinceDate = new Date(Date.now() - args.sinceMs);
  const identifiers = identifierMap(args);
  const platformLogs = await readLogFiles(
    platformLogFiles(args.rootDir),
    sinceDate,
    identifiers,
    SCRIPT_ROOT,
  );
  const runtimeLogs = await readLogFiles(
    runtimeLogFiles(args),
    sinceDate,
    identifiers,
    SCRIPT_ROOT,
  );
  const apiTrace = summarizeLogLayer(
    "api",
    platformLogs.filter((record) => record.layer === "api"),
    identifiers,
  );
  const runtimeBoundaryTrace = summarizeRuntimeBoundary(
    platformLogs,
    identifiers,
  );
  const runtimeTrace = summarizeRuntimeLogs(
    runtimeLogs,
    identifiers,
    args.runId,
  );
  const diagnosticTrace = await summarizeDiagnostic(args);
  const dashboardTrace = await summarizeDashboard(args);
  const artifactTrace = await summarizeBrowserArtifacts(args, identifiers);

  const checks = [
    apiTrace,
    runtimeBoundaryTrace,
    runtimeTrace,
    diagnosticTrace,
    dashboardTrace,
    artifactTrace,
  ];
  const result = {
    status: checks.some((check) => check.status === "fail")
      ? "fail"
      : checks.some((check) => check.status === "warn")
        ? "warn"
        : "ok",
    since: sinceDate.toISOString(),
    identifiers,
    checks,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTrace(result);
  }

  if (result.status === "fail") {
    process.exitCode = 1;
  }
}
