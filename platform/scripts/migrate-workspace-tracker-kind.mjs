#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_TRACKER_KINDS = [
  "memory",
  "database",
  "github",
  "api",
  "linear",
];

const DEFAULT_PAGE_SIZE = 1_000;
const PREFERRED_AGENT_TYPES = ["planning", "coding", "manager"];

function usage() {
  return `Usage: node scripts/migrate-workspace-tracker-kind.mjs [options]

Derive workspace_settings.tracker_kind from legacy
gateway_config.config_json.tracker.kind values on agent rows.

Options:
  --dry-run                 Print intended writes without changing data (default)
  --apply                   Write workspace_settings.tracker_kind
  --clear-agent-tracker     Also set gateway_config.config_json.tracker to null
                            after writing workspace_settings
  --workspace-id <uuid>     Limit the migration to one workspace
  --page-size <n>           Supabase REST page size (default ${DEFAULT_PAGE_SIZE})
  --json                    Emit the final summary as JSON
  -h, --help                Show this help

Environment:
  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for live Supabase
  access. A repo-root .env file is loaded when present.`;
}

export function parseArgs(argv) {
  const options = {
    dryRun: true,
    clearAgentTracker: false,
    workspaceId: null,
    pageSize: DEFAULT_PAGE_SIZE,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--apply") {
      options.dryRun = false;
    } else if (arg === "--clear-agent-tracker") {
      options.clearAgentTracker = true;
    } else if (arg === "--workspace-id") {
      const value = argv[index + 1]?.trim();
      if (!value) throw new Error("--workspace-id requires a value");
      options.workspaceId = value;
      index += 1;
    } else if (arg === "--page-size") {
      const value = Number.parseInt(argv[index + 1] ?? "", 10);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--page-size requires a positive integer");
      }
      options.pageSize = value;
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.clearAgentTracker && options.dryRun) {
    // Dry-run still reports which rows would be cleared; it never writes.
    options.clearAgentTracker = true;
  }

  return options;
}

export function extractTrackerKind(configJson) {
  if (
    !configJson ||
    typeof configJson !== "object" ||
    Array.isArray(configJson)
  ) {
    return null;
  }
  const tracker = configJson.tracker;
  if (!tracker || typeof tracker !== "object" || Array.isArray(tracker)) {
    return null;
  }
  const kind = typeof tracker.kind === "string" ? tracker.kind.trim() : "";
  return SUPPORTED_TRACKER_KINDS.includes(kind) ? kind : null;
}

export function clearTrackerConfig(configJson) {
  const config =
    configJson && typeof configJson === "object" && !Array.isArray(configJson)
      ? { ...configJson }
      : {};
  return { ...config, tracker: null };
}

function agentPreference(agentType) {
  const normalized = typeof agentType === "string" ? agentType : "";
  const index = PREFERRED_AGENT_TYPES.indexOf(normalized);
  return index === -1 ? PREFERRED_AGENT_TYPES.length : index;
}

function sortCandidates(left, right) {
  const preferred =
    agentPreference(left.agentType) - agentPreference(right.agentType);
  if (preferred !== 0) return preferred;
  return left.agentId.localeCompare(right.agentId);
}

export function deriveWorkspaceTrackerDecisions(input) {
  const workspaceById = new Map(
    input.workspaces.map((workspace) => [workspace.id, workspace]),
  );
  const agentsById = new Map(
    input.agents
      .filter((agent) => agent.is_active !== false)
      .map((agent) => [agent.id, agent]),
  );
  const candidatesByWorkspace = new Map();
  const ignoredGatewayConfigRows = [];

  for (const gatewayConfig of input.gatewayConfigs) {
    if (gatewayConfig.scope_type !== "agent") continue;
    const agent = agentsById.get(gatewayConfig.scope_id);
    if (!agent) {
      ignoredGatewayConfigRows.push({
        gatewayConfigId: gatewayConfig.id,
        scopeId: gatewayConfig.scope_id,
        reason: "agent_missing_or_inactive",
      });
      continue;
    }

    const trackerKind = extractTrackerKind(gatewayConfig.config_json);
    if (!trackerKind) continue;

    const candidate = {
      workspaceId: agent.workspace_id,
      workspaceName: workspaceById.get(agent.workspace_id)?.name ?? null,
      agentId: agent.id,
      agentType: agent.type ?? null,
      gatewayConfigId: gatewayConfig.id,
      trackerKind,
    };
    const existing = candidatesByWorkspace.get(agent.workspace_id) ?? [];
    existing.push(candidate);
    candidatesByWorkspace.set(agent.workspace_id, existing);
  }

  const decisions = input.workspaces.map((workspace) => {
    const candidates = candidatesByWorkspace.get(workspace.id) ?? [];
    if (candidates.length === 0) {
      return {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        trackerKind: null,
        action: "skip",
        reason: "no_agent_tracker_kind",
        warning: null,
        candidates,
      };
    }

    const kinds = [
      ...new Set(candidates.map((candidate) => candidate.trackerKind)),
    ];
    if (kinds.length === 1) {
      return {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        trackerKind: kinds[0],
        action: "upsert",
        reason: "all_agents_agree",
        warning: null,
        candidates,
      };
    }

    const chosen = [...candidates].sort(sortCandidates)[0];
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      trackerKind: chosen.trackerKind,
      action: "upsert",
      reason: "agents_disagree",
      warning: {
        code: "tracker_kind_disagreement",
        message:
          "Multiple legacy agent tracker kinds found; choosing the planning/coding default agent value.",
        chosenAgentId: chosen.agentId,
        chosenAgentType: chosen.agentType,
        observedKinds: kinds.sort(),
      },
      candidates,
    };
  });

  return { decisions, ignoredGatewayConfigRows };
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }
  return value;
}

function hashConfig(config) {
  return createHash("sha256").update(stableJson(config)).digest("hex");
}

function loadDotEnv() {
  const envPath = resolve(".env");
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
    process.env[key] = value;
  }
}

class SupabaseRestClient {
  constructor({ url, serviceRoleKey }) {
    this.baseUrl = url.replace(/\/$/, "");
    this.serviceRoleKey = serviceRoleKey;
  }

  async request(path, { method = "GET", query = {}, body, prefer } = {}) {
    const url = new URL(`${this.baseUrl}/rest/v1/${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message =
        data && typeof data === "object" && "message" in data
          ? data.message
          : response.statusText;
      throw new Error(
        `Supabase ${method} ${path} failed (${response.status}): ${message}`,
      );
    }
    return data;
  }
}

async function fetchPaged(client, table, { select, filter = {}, pageSize }) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await client.request(table, {
      query: {
        select,
        limit: pageSize,
        offset,
        ...filter,
      },
    });
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function fetchMigrationInputs(client, options) {
  const workspaceFilter = options.workspaceId
    ? { id: `eq.${options.workspaceId}` }
    : {};
  const agentFilter = options.workspaceId
    ? { workspace_id: `eq.${options.workspaceId}` }
    : {};

  const [workspaces, agents, gatewayConfigs] = await Promise.all([
    fetchPaged(client, "workspaces", {
      select: "id,name",
      filter: workspaceFilter,
      pageSize: options.pageSize,
    }),
    fetchPaged(client, "agent", {
      select: "id,workspace_id,type,is_active",
      filter: agentFilter,
      pageSize: options.pageSize,
    }),
    fetchPaged(client, "gateway_config", {
      select:
        "id,scope_id,scope_type,config_json,version,config_hash,updated_by",
      filter: { scope_type: "eq.agent" },
      pageSize: options.pageSize,
    }),
  ]);

  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  return {
    workspaces,
    agents,
    gatewayConfigs: options.workspaceId
      ? gatewayConfigs.filter((row) =>
          workspaceIds.has(
            agents.find((agent) => agent.id === row.scope_id)?.workspace_id,
          ),
        )
      : gatewayConfigs,
  };
}

async function upsertWorkspaceTrackerKind(client, decision) {
  await client.request("workspace_settings", {
    method: "POST",
    query: { on_conflict: "workspace_id" },
    prefer: "resolution=merge-duplicates,return=minimal",
    body: [
      {
        workspace_id: decision.workspaceId,
        tracker_kind: decision.trackerKind,
      },
    ],
  });
}

async function clearAgentTrackerRows(client, decision, gatewayConfigById) {
  const rows = [];
  for (const candidate of decision.candidates) {
    const row = gatewayConfigById.get(candidate.gatewayConfigId);
    if (!row) continue;
    const nextConfig = clearTrackerConfig(row.config_json);
    const nextVersion = Number(row.version ?? 0) + 1;
    const nextHash = hashConfig(nextConfig);

    const updatedRows = await client.request("gateway_config", {
      method: "PATCH",
      query: { id: `eq.${row.id}` },
      prefer: "return=representation",
      body: {
        config_json: nextConfig,
        config_hash: nextHash,
        version: nextVersion,
        updated_by: row.updated_by,
      },
    });

    await client.request("gateway_config_versions", {
      method: "POST",
      prefer: "return=minimal",
      body: [
        {
          gateway_config_id: row.id,
          version: nextVersion,
          config_hash: nextHash,
          config_json: nextConfig,
          created_by: row.updated_by,
          change_summary: {
            migrated_workspace_tracker_kind: decision.trackerKind,
            cleared_legacy_agent_tracker: true,
          },
        },
      ],
    });

    rows.push(...updatedRows);
  }
  return rows;
}

function printableDecision(decision) {
  const name = decision.workspaceName ? ` (${decision.workspaceName})` : "";
  if (decision.action === "skip") {
    return `${decision.workspaceId}${name}: skip (${decision.reason})`;
  }
  return `${decision.workspaceId}${name}: write tracker_kind=${decision.trackerKind} (${decision.reason})`;
}

async function run(options) {
  loadDotEnv();
  const url = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. Add them to the environment or repo-root .env.",
    );
  }

  const client = new SupabaseRestClient({ url, serviceRoleKey });
  const inputs = await fetchMigrationInputs(client, options);
  const result = deriveWorkspaceTrackerDecisions(inputs);
  const gatewayConfigById = new Map(
    inputs.gatewayConfigs.map((gatewayConfig) => [
      gatewayConfig.id,
      gatewayConfig,
    ]),
  );
  const summary = {
    mode: options.dryRun ? "dry_run" : "apply",
    clearAgentTracker: options.clearAgentTracker,
    workspacesSeen: result.decisions.length,
    workspacesToWrite: result.decisions.filter(
      (decision) => decision.action === "upsert",
    ).length,
    workspacesSkipped: result.decisions.filter(
      (decision) => decision.action === "skip",
    ).length,
    warnings: result.decisions
      .filter((decision) => decision.warning)
      .map((decision) => ({
        workspaceId: decision.workspaceId,
        ...decision.warning,
      })),
    ignoredGatewayConfigRows: result.ignoredGatewayConfigRows.length,
    clearedGatewayConfigRows: 0,
  };

  if (!options.json) {
    console.log(
      `[workspace-tracker-kind-migration] ${options.dryRun ? "dry-run" : "apply"} mode`,
    );
    for (const decision of result.decisions) {
      console.log(printableDecision(decision));
      if (decision.warning) {
        console.warn(
          `  warning: ${decision.warning.message} chosen=${decision.warning.chosenAgentType ?? "unknown"}/${decision.warning.chosenAgentId} observed=${decision.warning.observedKinds.join(",")}`,
        );
      }
      if (options.clearAgentTracker && decision.action === "upsert") {
        console.log(
          `  ${options.dryRun ? "would clear" : "clear"} legacy tracker on ${decision.candidates.length} gateway_config row(s)`,
        );
      }
    }
  }

  if (!options.dryRun) {
    for (const decision of result.decisions) {
      if (decision.action !== "upsert") continue;
      await upsertWorkspaceTrackerKind(client, decision);
      if (options.clearAgentTracker) {
        const clearedRows = await clearAgentTrackerRows(
          client,
          decision,
          gatewayConfigById,
        );
        summary.clearedGatewayConfigRows += clearedRows.length;
      }
    }
  }

  if (options.json) {
    console.log(
      JSON.stringify({ summary, decisions: result.decisions }, null, 2),
    );
  } else {
    console.log(
      `[workspace-tracker-kind-migration] summary: ${JSON.stringify(summary)}`,
    );
  }

  return { summary, decisions: result.decisions };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    await run(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
