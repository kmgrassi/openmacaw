#!/usr/bin/env node

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const parsed = {
    mode: null,
    agentId: null,
    workspaceId: null,
    apiBaseUrl: process.env.PLATFORM_API_BASE_URL ?? "http://127.0.0.1:3100",
    token: process.env.PLATFORM_API_TOKEN ?? process.env.API_AUTH_TOKEN ?? null,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      parsed.mode = "dry-run";
    } else if (arg === "--live") {
      parsed.mode = "live";
    } else if (arg === "--agent-id") {
      parsed.agentId = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--agent-id=")) {
      parsed.agentId = arg.slice("--agent-id=".length);
    } else if (arg === "--workspace-id") {
      parsed.workspaceId = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--workspace-id=")) {
      parsed.workspaceId = arg.slice("--workspace-id=".length);
    } else if (arg === "--api-base-url") {
      parsed.apiBaseUrl = argv[index + 1] ?? parsed.apiBaseUrl;
      index += 1;
    } else if (arg.startsWith("--api-base-url=")) {
      parsed.apiBaseUrl = arg.slice("--api-base-url=".length);
    } else if (arg === "--api-token") {
      parsed.token = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--api-token=")) {
      parsed.token = arg.slice("--api-token=".length);
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    }
  }

  parsed.agentId = parsed.agentId?.trim() || null;
  parsed.workspaceId = parsed.workspaceId?.trim() || null;
  parsed.apiBaseUrl = parsed.apiBaseUrl.replace(/\/$/, "");
  return parsed;
}

function usage() {
  return `Usage:
  pnpm run agent:dispatch:dry-run -- --agent-id <agent-id> --workspace-id <workspace-id>
  pnpm run agent:dispatch:live -- --agent-id <agent-id> --workspace-id <workspace-id>

Options:
  --agent-id <id>       Agent to inspect or dispatch
  --workspace-id <id>   Workspace the agent belongs to
  --api-base-url <url>  Platform API base URL (default: http://127.0.0.1:3100)
  --api-token <token>   Bearer token (or PLATFORM_API_TOKEN / API_AUTH_TOKEN)
  --json                Print machine-readable output
`;
}

function requireInput() {
  const missing = [];
  if (!args.mode) missing.push("mode");
  if (!args.agentId) missing.push("--agent-id");
  if (!args.workspaceId) missing.push("--workspace-id");
  if (!args.token) missing.push("--api-token or PLATFORM_API_TOKEN");
  if (missing.length > 0) {
    throw new Error(`Missing required input: ${missing.join(", ")}`);
  }
}

async function postProbe() {
  const endpointMode = args.mode === "dry-run" ? "dry-run" : "live";
  const response = await fetch(
    `${args.apiBaseUrl}/api/dev/agents/${encodeURIComponent(args.agentId)}/dispatch/${endpointMode}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId: args.workspaceId }),
    },
  );
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { text };
  }
  return { ok: response.ok, status: response.status, body };
}

function toolSlugs(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "none";
  return tools
    .map((tool) => tool.slug)
    .sort()
    .join(", ");
}

function compactTarget(target) {
  if (!target) return "none";
  if (target.kind === "local_helper") {
    return `local_helper machine=${target.machineId} root=${target.workspaceRoot ?? target.workspaceRootRef}`;
  }
  if (target.kind === "container") {
    return `container session=${target.metadata?.sessionId ?? "unknown"}`;
  }
  return target.kind ?? "unknown";
}

function printDryRun(body) {
  const profile = body.platform.profile;
  console.log("agent dispatch dry-run: ready");
  console.log("");
  console.log(`agent: ${body.agentId}`);
  console.log(`workspace: ${body.workspaceId}`);
  console.log(`runner: ${profile.runnerKind}`);
  console.log(`provider: ${profile.provider}`);
  console.log(`model: ${profile.model}`);
  console.log(`tool profile: ${profile.toolProfile}`);
  console.log(
    `credential: ${profile.credential.resolved ? profile.credential.refType : "missing"}`,
  );
  console.log(
    `execution target: ${compactTarget(body.platform.executionTarget)}`,
  );
  console.log(
    `workspace policy: ${body.platform.workspacePolicy ? JSON.stringify(body.platform.workspacePolicy) : "none"}`,
  );
  console.log(`tools: ${toolSlugs(body.platform.toolDefinitions)}`);
}

function printLive(body) {
  const profile = body.platform.profile;
  console.log(`agent dispatch live-run: ${body.status}`);
  console.log("");
  console.log(`agent: ${body.agentId}`);
  console.log(`workspace: ${body.workspaceId}`);
  console.log(
    `runtime target: ${body.runtimeTarget.id} port=${body.runtimeTarget.port} status=${body.runtimeTarget.status}`,
  );
  console.log(
    `runner: platform=${profile.runnerKind} runtime=${body.runtimeReported.runnerKind ?? "missing"}`,
  );
  console.log(
    `provider: platform=${profile.provider} runtime=${body.runtimeReported.provider ?? "missing"}`,
  );
  console.log(
    `model: platform=${profile.model} runtime=${body.runtimeReported.model ?? "missing"}`,
  );
  console.log(
    `tool profile: platform=${profile.toolProfile} runtime=${body.runtimeReported.toolProfile ?? "missing"}`,
  );

  const mismatches = body.comparisons.filter(
    (comparison) => !comparison.matches,
  );
  if (mismatches.length > 0) {
    console.log("");
    console.log(
      `mismatches: ${mismatches.map((comparison) => comparison.field).join(", ")}`,
    );
  }
}

async function main() {
  if (args.help) {
    console.log(usage());
    return;
  }
  requireInput();
  const result = await postProbe();

  if (args.json) {
    console.log(JSON.stringify(result.body, null, 2));
  } else if (result.ok && args.mode === "dry-run") {
    printDryRun(result.body);
  } else if (result.ok && args.mode === "live") {
    printLive(result.body);
  } else {
    console.error(`agent dispatch ${args.mode}: failed (${result.status})`);
    console.error(JSON.stringify(result.body, null, 2));
  }

  process.exitCode = result.ok ? 0 : 1;
}

main().catch((error) => {
  if (args.json) {
    console.log(JSON.stringify({ error: { message: error.message } }, null, 2));
  } else {
    console.error(`agent dispatch ${args.mode ?? "probe"}: failed`);
    console.error(error.message);
    console.error("");
    console.error(usage());
  }
  process.exitCode = 1;
});
