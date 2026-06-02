import {
  API_PATHS,
  asRecord,
  parseJsonResponse,
  resolveBrokerBase,
  safeParseJsonResponse,
} from "./broker";
import { ROUTES } from "./routes";
import { getSupabaseAccessToken } from "./supabase";
import { isValidUuid } from "./ws-types";
import type {
  AgentId,
  PrepareError,
  PrepareErrorAction,
  PrepareRuntimeResponse,
} from "./ws-types";

export async function prepareRuntime(
  _agentId?: AgentId,
): Promise<PrepareRuntimeResponse> {
  if (!_agentId || !isValidUuid(_agentId)) {
    return {
      readyToConnect: false,
      reasons: ["missing_usable_agent"],
      onboardingNextAction: "select_agent",
    };
  }

  let accessToken = "";
  try {
    accessToken = await getSupabaseAccessToken();
  } catch {
    accessToken = "";
  }

  const res = await safeParseJsonResponse<unknown>(
    `${resolveBrokerBase()}${ROUTES.agentStart(_agentId)}`,
    {
      method: "POST",
      credentials: "include",
      headers: accessToken
        ? { authorization: `Bearer ${accessToken}` }
        : undefined,
    },
  );

  if (res.ok) {
    return {
      readyToConnect: true,
      reasons: [],
      onboardingNextAction: undefined,
    };
  }

  const body = asRecord(res.body);
  const prepareError = parsePrepareError(res.status, body);
  const reason =
    prepareError?.launcherErrorCode ??
    prepareError?.code ??
    (typeof body?.error === "string"
      ? body.error
      : typeof body?.message === "string"
        ? body.message
        : res.status === 404
          ? "agent_not_found"
          : res.status === 0
            ? "launcher_unreachable"
            : "runtime_start_failed");

  return {
    readyToConnect: false,
    reasons: [reason],
    onboardingNextAction: res.status === 404 ? "select_agent" : undefined,
    prepareError: prepareError ?? undefined,
  };
}

function parsePrepareError(
  status: number,
  body: Record<string, unknown> | null,
): PrepareError | null {
  const errorRecord = asRecord(body?.error);
  if (!errorRecord && status >= 500) return null;
  if (!errorRecord && status === 0) {
    return {
      code: "launcher_unreachable",
      message: "Could not reach launcher",
      raw: body,
    };
  }
  if (!errorRecord) return null;

  const code =
    typeof errorRecord.code === "string"
      ? errorRecord.code
      : "runtime_start_failed";
  const message =
    typeof errorRecord.message === "string"
      ? errorRecord.message
      : "Runtime preparation failed";
  const details = asRecord(errorRecord.details);
  const launcherError = asRecord(details?.launcher_error);
  const launcherErrorCode =
    typeof launcherError?.error_code === "string"
      ? launcherError.error_code
      : undefined;
  const resolutionHint =
    typeof launcherError?.resolution_hint === "string"
      ? launcherError.resolution_hint
      : undefined;
  const requiredConfig = Array.isArray(launcherError?.required_config)
    ? (launcherError.required_config as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      )
    : undefined;

  return {
    code,
    message,
    launcherErrorCode,
    resolutionHint,
    requiredConfig,
    suggestedAction: deriveSuggestedAction(code, launcherErrorCode),
    raw: body,
  };
}

function deriveSuggestedAction(
  code: string,
  launcherErrorCode: string | undefined,
): PrepareErrorAction | undefined {
  if (launcherErrorCode === "missing_tracker_kind") return "configure_tracker";
  if (
    launcherErrorCode === "missing_database_endpoint" ||
    launcherErrorCode === "missing_database_api_key" ||
    launcherErrorCode === "missing_database_table" ||
    launcherErrorCode === "missing_github_repository" ||
    launcherErrorCode === "missing_github_api_key"
  ) {
    return "configure_tracker";
  }
  if (
    code === "agent_runtime_unconfigured" ||
    code === "manager_credential_missing"
  ) {
    return "configure_credential";
  }
  return undefined;
}

export async function fetchGatewayReady(): Promise<boolean | null> {
  try {
    const res = await parseJsonResponse<unknown>(
      `${resolveBrokerBase()}${API_PATHS.health}`,
      {
        method: "GET",
        credentials: "include",
      },
    );
    if (res.status === 200) return true;
    if (res.status === 503 || res.status === 502) return false;
  } catch {
    return null;
  }
  return null;
}
