import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { probeHttpJson } from "../platform-probes.mjs";
import { check } from "./format.mjs";

const MAX_EVIDENCE = 5;

export async function summarizeDiagnostic(input) {
  if (!input.agentId) {
    return check("agent diagnostic", "skip", "no --agent-id supplied");
  }

  const query = new URLSearchParams();
  if (input.workspaceId) query.set("workspaceId", input.workspaceId);
  const result = await probeHttpJson(
    `${input.apiBaseUrl}/api/diagnostic/agents/${encodeURIComponent(input.agentId)}${query.size ? `?${query}` : ""}`,
    {
      timeoutMs: 2000,
    },
  );

  if (!result.ok) {
    return check(
      "agent diagnostic",
      "fail",
      result.error ?? `request failed (${result.status ?? "no status"})`,
      {
        url: result.url,
        next: "start the platform with pnpm run dev and rerun this command",
      },
    );
  }

  const blockers = Array.isArray(result.json?.blockers)
    ? result.json.blockers
    : [];
  return check(
    "agent diagnostic",
    result.json?.canChat === false ? "fail" : "pass",
    result.json?.canChat === false
      ? `canChat=false (${blockers.length} blocker${blockers.length === 1 ? "" : "s"})`
      : "diagnostic reachable",
    {
      canChat: result.json?.canChat ?? null,
      blockers,
    },
  );
}

export async function summarizeDashboard(input) {
  if (!input.agentId) {
    return check("dashboard rows", "skip", "no --agent-id supplied");
  }
  if (!input.token) {
    return check(
      "dashboard rows",
      "skip",
      "no --api-token or PLATFORM_API_TOKEN supplied",
    );
  }

  const headers = {
    authorization: `Bearer ${input.token}`,
    "content-type": "application/json",
  };
  const messageEvidence = input.messageId
    ? await fetchMessageEvidence(input, headers)
    : null;
  if (messageEvidence?.status === "fail") {
    return messageEvidence;
  }

  const latestRun = await probeHttpJson(
    `${input.apiBaseUrl}/api/agent-dashboard/${encodeURIComponent(input.agentId)}/latest-run`,
    {
      headers,
      timeoutMs: 3000,
    },
  );
  if (!latestRun.ok) {
    return check(
      "dashboard rows",
      "fail",
      latestRun.error ??
        `latest-run failed (${latestRun.status ?? "no status"})`,
      {
        next: "provide a valid Supabase access token with --api-token",
      },
    );
  }

  const run = latestRun.json?.run ?? null;
  const runMatches = !input.runId || run?.runId === input.runId;
  const details = {
    message: messageEvidence?.message ?? null,
    latestRun: run
      ? { runId: run.runId, status: run.status, updatedAt: run.updatedAt }
      : null,
  };
  if (messageEvidence && !input.runId && !input.toolCallId) {
    return check("dashboard rows", "pass", "message row found", details);
  }
  if (!run || !runMatches) {
    return check(
      "dashboard rows",
      "fail",
      input.runId
        ? `latest run did not match runId=${input.runId}`
        : "no latest run row found",
      details,
    );
  }

  if (!input.toolCallId) {
    return check("dashboard rows", "pass", "latest run row found", details);
  }

  const tasks = await probeHttpJson(
    `${input.apiBaseUrl}/api/agent-dashboard/${encodeURIComponent(input.agentId)}/tasks`,
    {
      method: "POST",
      headers,
      timeoutMs: 3000,
      body: JSON.stringify({ runIds: [run.runId] }),
    },
  );
  if (!tasks.ok) {
    return check(
      "dashboard rows",
      "fail",
      tasks.error ?? `task lookup failed (${tasks.status ?? "no status"})`,
      details,
    );
  }
  const toolEvents = Array.isArray(tasks.json?.tasks)
    ? tasks.json.tasks.flatMap((task) => task.toolEvents ?? [])
    : [];
  const matchingToolEvents = toolEvents.filter(
    (event) => event.toolCallId === input.toolCallId,
  );
  if (matchingToolEvents.length === 0) {
    return check(
      "dashboard rows",
      "fail",
      `no tool event row matched toolCallId=${input.toolCallId}`,
      details,
    );
  }
  return check(
    "dashboard rows",
    "pass",
    `${matchingToolEvents.length} matching tool event row${matchingToolEvents.length === 1 ? "" : "s"}`,
    {
      ...details,
      evidence: matchingToolEvents.slice(-MAX_EVIDENCE).map((event) => ({
        toolCallId: event.toolCallId,
        runId: event.runId,
        status: event.status,
        eventType: event.eventType,
        updatedAt: event.updatedAt,
      })),
    },
  );
}

export async function summarizeBrowserArtifacts(input, identifiers) {
  if (!existsSync(input.artifactsDir)) {
    return check(
      "browser artifacts",
      "skip",
      `${relative(input.rootDir, input.artifactsDir)} does not exist`,
    );
  }

  const files = listFiles(input.artifactsDir).filter((file) => {
    try {
      return statSync(file).mtimeMs >= Date.now() - input.sinceMs;
    } catch {
      return false;
    }
  });
  const matches = [];
  const values = Object.values(identifiers);
  for (const file of files.slice(-200)) {
    const haystack = `${file}\n${await readArtifactSample(file)}`;
    if (values.some((value) => haystack.includes(value))) {
      matches.push(file);
    }
  }

  if (matches.length === 0) {
    return check(
      "browser artifacts",
      "skip",
      "no matching recent browser artifact found",
    );
  }
  return check(
    "browser artifacts",
    "pass",
    `${matches.length} matching artifact${matches.length === 1 ? "" : "s"}`,
    {
      evidence: matches
        .slice(-MAX_EVIDENCE)
        .map((file) => relative(input.rootDir, file)),
    },
  );
}

async function fetchMessageEvidence(input, headers) {
  const messages = await probeHttpJson(
    `${input.apiBaseUrl}/api/agents/${encodeURIComponent(input.agentId)}/messages?limit=200`,
    {
      headers,
      timeoutMs: 3000,
    },
  );
  if (!messages.ok) {
    return check(
      "dashboard rows",
      "fail",
      messages.error ??
        `message lookup failed (${messages.status ?? "no status"})`,
      {
        next: "provide a valid Supabase access token with --api-token",
      },
    );
  }

  const matchingMessage = Array.isArray(messages.json?.messages)
    ? messages.json.messages.find((message) => message.id === input.messageId)
    : null;
  if (!matchingMessage) {
    return check(
      "dashboard rows",
      "fail",
      `no message row matched messageId=${input.messageId}`,
    );
  }

  return {
    status: "pass",
    message: {
      id: matchingMessage.id,
      role: matchingMessage.role ?? null,
      runId: matchingMessage.run_id ?? matchingMessage.runId ?? null,
      createdAt:
        matchingMessage.createdAt ?? matchingMessage.created_at ?? null,
    },
  };
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    if (entry.isFile()) out.push(path);
  }
  return out;
}

async function readArtifactSample(file) {
  if (!/\.(json|txt|log|html|md)$/i.test(file)) return "";
  try {
    return (await readFile(file, "utf8")).slice(0, 20_000);
  } catch {
    return "";
  }
}
