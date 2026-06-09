import { parsePositiveInt } from "./helpers.js";
import {
  RuntimeExecutionTargetKindSchema,
  type RuntimeExecutionTargetKind,
} from "../../../contracts/execution-profile.js";

export type ContainerExecutionRoutingMode = "local_helper_default" | "allowlist" | "percentage" | "container_default";

export type ApiConfig = {
  port: number;
  host: string;
  orchestratorBaseUrl: string;
  orchestratorWsUrl: string;
  launcherBaseUrl: string;
  orchestratorRequestTimeoutMs: number;
  launcherRequestTimeoutMs: number;
  corsOrigins: string;
  wsUpgradePath: string;
  wsConnectTimeoutMs: number;
  workItemDefaultWorkspaceId: string | null;
  githubApiToken?: string | null;
  githubWebhookSecret: string | null;
  githubRepoWorkspaceMap: Record<string, string>;
  linearWebhookSecret: string | null;
  linearApiKey: string | null;
  linearProjectWorkspaceMap: Record<string, string>;
  linearTeamWorkspaceMap: Record<string, string>;
};

export type ToolExecutionConfig = {
  legacyLocalChatToolHelperBaseUrl: string;
  toolExecutionTimeoutMs: number;
  localCodingExecutionTargetKind: RuntimeExecutionTargetKind;
  containerExecutionRouting: {
    mode: ContainerExecutionRoutingMode;
    allowlistWorkspaceIds: readonly string[];
    percentage: number;
  };
};

function parseStringMap(value: string | undefined): Record<string, string> {
  const trimmed = value?.trim();
  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, entryValue]) => {
        if (typeof entryValue !== "string" || !entryValue.trim()) return [];
        return [[key.trim(), entryValue.trim()]];
      }),
    );
  } catch {
    return {};
  }
}

function parseRuntimeExecutionTargetKind(value: string | undefined): RuntimeExecutionTargetKind {
  const parsed = RuntimeExecutionTargetKindSchema.safeParse((value ?? "").trim());
  return parsed.success ? parsed.data : "local_helper";
}

function parseContainerExecutionRoutingMode(value: string | undefined): ContainerExecutionRoutingMode {
  const trimmed = (value ?? "").trim();
  if (
    trimmed === "allowlist" ||
    trimmed === "percentage" ||
    trimmed === "container_default" ||
    trimmed === "local_helper_default"
  ) {
    return trimmed;
  }
  return "local_helper_default";
}

function parseUuidList(value: string | undefined): readonly string[] {
  const trimmed = value?.trim();
  if (!trimmed) return [];

  return Array.from(
    new Set(
      trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function parsePercentage(value: string | undefined): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(100, Math.max(0, parsed));
}

export function deriveWsUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    const scheme = parsed.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${parsed.host}`;
  } catch {
    return "ws://127.0.0.1:4000";
  }
}

export function loadApiConfig(): ApiConfig {
  const orchestratorBaseUrl = (process.env.ORCHESTRATOR_BASE_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");

  return {
    port: parsePositiveInt(process.env.PORT, 3100),
    host: (process.env.HOST ?? "").trim() || "::",
    orchestratorBaseUrl,
    orchestratorWsUrl: (process.env.ORCHESTRATOR_WS_URL || deriveWsUrl(orchestratorBaseUrl)).trim(),
    launcherBaseUrl: (process.env.LAUNCHER_BASE_URL ?? "http://127.0.0.1:4100").replace(/\/$/, ""),
    orchestratorRequestTimeoutMs: parsePositiveInt(process.env.ORCHESTRATOR_REQUEST_TIMEOUT_MS, 15000),
    launcherRequestTimeoutMs: parsePositiveInt(process.env.LAUNCHER_REQUEST_TIMEOUT_MS, 15000),
    corsOrigins: (process.env.CORS_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173").trim(),
    wsUpgradePath: process.env.WS_UPGRADE_PATH || "/ws",
    wsConnectTimeoutMs: parsePositiveInt(process.env.WS_CONNECT_TIMEOUT_MS, 10000),
    workItemDefaultWorkspaceId: (process.env.WORK_ITEM_DEFAULT_WORKSPACE_ID ?? "").trim() || null,
    githubApiToken: (process.env.GITHUB_API_TOKEN ?? process.env.GITHUB_TOKEN ?? "").trim() || null,
    githubWebhookSecret: (process.env.GITHUB_WEBHOOK_SECRET ?? "").trim() || null,
    githubRepoWorkspaceMap: parseStringMap(process.env.GITHUB_REPO_WORKSPACE_MAP),
    linearWebhookSecret: (process.env.LINEAR_WEBHOOK_SECRET ?? "").trim() || null,
    linearApiKey: (process.env.LINEAR_API_KEY ?? "").trim() || null,
    linearProjectWorkspaceMap: parseStringMap(process.env.LINEAR_PROJECT_WORKSPACE_MAP),
    linearTeamWorkspaceMap: parseStringMap(process.env.LINEAR_TEAM_WORKSPACE_MAP),
  };
}

export function loadToolExecutionConfig(): ToolExecutionConfig {
  // Legacy direct `/local-chat` development compatibility only. This is not
  // the Go local-runtime-helper relay endpoint.
  const legacyLocalChatToolHelperBaseUrl = (
    process.env.LOCAL_TOOL_HELPER_URL ??
    process.env.HELPER_DAEMON_URL ??
    "http://localhost:17654"
  ).replace(/\/+$/, "");

  return {
    legacyLocalChatToolHelperBaseUrl,
    toolExecutionTimeoutMs: parsePositiveInt(process.env.TOOL_EXECUTION_TIMEOUT_MS, 30_000),
    localCodingExecutionTargetKind: parseRuntimeExecutionTargetKind(process.env.LOCAL_CODING_EXECUTION_TARGET_KIND),
    containerExecutionRouting: {
      mode: parseContainerExecutionRoutingMode(process.env.CONTAINER_EXECUTION_ROUTING_MODE),
      allowlistWorkspaceIds: parseUuidList(process.env.CONTAINER_EXECUTION_ALLOWLIST_WORKSPACE_IDS),
      percentage: parsePercentage(process.env.CONTAINER_EXECUTION_ROLLOUT_PERCENTAGE),
    },
  };
}
