import path from "node:path";
import { requireArgValue } from "./utils.mjs";

export function buildDefaultArgs(scriptDir) {
  return {
    batteryPath: path.join(scriptDir, "manager-tool-call-battery.json"),
    suiteSlug: null,
    agentId: process.env.MANAGER_AGENT_ID ?? process.env.OPENMACAW_MANAGER_AGENT_ID ?? process.env.OPENMACAW_AGENT_ID ?? null,
    workspaceId:
      process.env.MANAGER_WORKSPACE_ID ?? process.env.OPENMACAW_MANAGER_WORKSPACE_ID ?? process.env.OPENMACAW_WORKSPACE_ID ?? null,
    apiBaseUrl: process.env.PLATFORM_API_BASE_URL ?? process.env.OPENMACAW_API_BASE_URL ?? null,
    token: process.env.PLATFORM_API_TOKEN ?? process.env.OPENMACAW_ACCESS_TOKEN ?? null,
    caseIds: [],
    includeDisabled: false,
    run: false,
    json: false,
    help: false,
  };
}

export function parseArgs(argv, scriptDir) {
  const parsed = buildDefaultArgs(scriptDir);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    else if (arg === "--suite-slug") parsed.suiteSlug = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--suite-slug=")) parsed.suiteSlug = arg.slice("--suite-slug=".length);
    else if (arg === "--battery") parsed.batteryPath = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--battery=")) parsed.batteryPath = arg.slice("--battery=".length);
    else if (arg === "--agent-id") parsed.agentId = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--agent-id=")) parsed.agentId = arg.slice("--agent-id=".length);
    else if (arg === "--workspace-id") parsed.workspaceId = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--workspace-id=")) parsed.workspaceId = arg.slice("--workspace-id=".length);
    else if (arg === "--api-base-url") parsed.apiBaseUrl = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--api-base-url=")) parsed.apiBaseUrl = arg.slice("--api-base-url=".length);
    else if (arg === "--api-token") parsed.token = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--api-token=")) parsed.token = arg.slice("--api-token=".length);
    else if (arg === "--case") parsed.caseIds.push(requireArgValue(arg, argv[++index]));
    else if (arg.startsWith("--case=")) parsed.caseIds.push(arg.slice("--case=".length));
    else if (arg === "--include-disabled") parsed.includeDisabled = true;
    else if (arg === "--run") parsed.run = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

export function printHelp() {
  console.log(`Usage:
  pnpm run smoke:manager-tool-battery
  pnpm run eval:local-tool-calling
  pnpm run eval:local-tool-calling -- --run --case repo-read-file-readme
  pnpm run smoke:manager-tool-battery -- --run --case git-run-gh-repo-view
  pnpm run smoke:manager-tool-battery -- --run --include-disabled --case scheduled-task-create

Options:
  --run                 Actually send prompts. Omit for dry-run discovery.
  --suite-slug <slug>   Load cases from agent_eval_* tables instead of a JSON battery.
  --case <id>           Run/list one case. May be repeated.
  --include-disabled    Include disabled cases when --case is not provided.
  --agent-id <id>       Agent to message. Defaults to MANAGER_AGENT_ID or OPENMACAW_AGENT_ID.
  --workspace-id <id>   Workspace context. Defaults to MANAGER_WORKSPACE_ID or OPENMACAW_WORKSPACE_ID.
  --api-base-url <url>  Platform API URL. Default comes from the suite metadata or battery file.
  --api-token <token>   Bearer token. Otherwise the script signs in using local env login values.
  --json                Print JSON only.
`);
}
