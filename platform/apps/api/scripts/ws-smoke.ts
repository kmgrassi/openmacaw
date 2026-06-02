import { WebSocket } from "ws";

type Args = {
  agentId: string;
  workspaceId: string;
  baseUrl: string;
  sessionKey: string;
  message: string;
};

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value && !value.startsWith("--")) {
      values.set(key, value);
      i += 1;
    } else {
      values.set(key, "true");
    }
  }

  const agentId = values.get("agent-id") ?? process.env.AGENT_ID ?? "";
  const workspaceId = values.get("workspace-id") ?? process.env.WORKSPACE_ID ?? "";
  if (!agentId || !workspaceId) {
    throw new Error("agent-id and workspace-id are required");
  }

  const baseUrl = values.get("base-url") ?? process.env.BASE_URL ?? "http://127.0.0.1:3100";
  const sessionKey = values.get("session-key") ?? process.env.SESSION_KEY ?? `agent:${agentId}:main`;
  const message = values.get("message") ?? process.env.MESSAGE ?? "say exactly runtime front door ok";

  return { agentId, workspaceId, baseUrl, sessionKey, message };
}

async function startAgent(baseUrl: string, agentId: string) {
  const response = await fetch(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/start`, {
    method: "POST",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`start failed (${response.status}): ${text}`);
  }

  console.log("[ws-smoke] start ok");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await startAgent(args.baseUrl, args.agentId);

  const wsUrl = new URL(args.baseUrl.replace(/^http/i, "ws"));
  wsUrl.pathname = "/ws";
  wsUrl.searchParams.set("agent_id", args.agentId);
  wsUrl.searchParams.set("workspace_id", args.workspaceId);
  wsUrl.searchParams.set("session_key", args.sessionKey);

  const ws = new WebSocket(String(wsUrl));
  const timer = setTimeout(() => {
    console.error("[ws-smoke] timeout");
    process.exit(1);
  }, 20_000);

  ws.on("open", () => {
    console.log("[ws-smoke] socket open");
  });

  ws.on("message", (raw) => {
    const text = raw.toString();
    console.log(text);

    let frame: Record<string, unknown> | null = null;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    if (frame.type === "hello-ok") {
      ws.send(JSON.stringify({
        type: "req",
        id: "chat-1",
        method: "chat.send",
        params: {
          agent_id: args.agentId,
          workspace_id: args.workspaceId,
          sessionKey: args.sessionKey,
          message: args.message,
          deliver: false,
          idempotencyKey: "chat-1",
        },
      }));
      return;
    }

    if (frame.type === "event" && frame.event === "chat") {
      const payload = frame.payload as { errorMessage?: string; message?: unknown; state?: string } | undefined;
      if (payload?.state === "error") {
        clearTimeout(timer);
        ws.close();
        console.error("[ws-smoke] chat error", payload.errorMessage ?? "unknown chat error");
        process.exit(1);
      }
      if (payload?.state === "final") {
        const content = extractText(payload.message);
        if (!content.trim()) {
          clearTimeout(timer);
          ws.close();
          console.error("[ws-smoke] empty final assistant message");
          process.exit(1);
        }
        clearTimeout(timer);
        ws.close();
        process.exit(0);
      }
    }
  });

  ws.on("error", (error) => {
    clearTimeout(timer);
    console.error("[ws-smoke] error", error);
    process.exit(1);
  });

  ws.on("close", (code, reason) => {
    console.log("[ws-smoke] close", { code, reason: reason.toString() });
  });

  ws.once("open", () => {
    ws.send(JSON.stringify({
      type: "req",
      id: "connect-1",
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: { id: "ws-smoke", version: "0.1", platform: "node", mode: "debug" },
        role: "operator",
        scopes: ["operator.admin"],
        caps: [],
        userAgent: "ws-smoke",
        locale: "en-US",
      },
    }));
  });
}

function extractText(message: unknown): string {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.map(extractText).filter(Boolean).join("\n");
  if (message && typeof message === "object" && "content" in message) {
    return extractText((message as { content?: unknown }).content);
  }
  return "";
}

void main().catch((error) => {
  console.error("[ws-smoke] fatal", error);
  process.exit(1);
});
