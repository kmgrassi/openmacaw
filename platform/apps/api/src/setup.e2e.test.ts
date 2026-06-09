import { generateKeyPairSync } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { WebSocket, WebSocketServer } from "ws";

import { DEFAULT_PLANNING_TOOL_SLUGS, SCHEDULED_TASK_TOOL_SLUGS } from "./services/tool-bundles.js";

type AgentRow = {
  id: string;
  workspace_id: string;
  created_by_user_id: string | null;
  name: string | null;
  model_settings: unknown;
  tool_policy: unknown;
  type: string | null;
  status: string;
  updated_at: string | null;
};

type EngineRow = {
  instance_id: string;
  agent_id: string;
  workspace_id: string;
  host: string;
  port: number;
  role: string;
  status: string;
  started_at: string;
  last_health_at: string | null;
  updated_at: string;
  ws_connection_id: string | null;
};

type SetupAgentPayload = {
  id: string;
  workspaceId: string;
  name: string | null;
  modelSettings: unknown;
  toolPolicy: unknown;
  type: string | null;
  status: string;
  updatedAt: string | null;
};

type SetupEnginePayload = {
  instanceId: string;
  agentId: string;
  workspaceId: string;
  host: string;
  port: number;
  role: string;
  status: string;
  startedAt: string;
  lastHealthAt: string | null;
  updatedAt: string;
  wsConnectionId: string | null;
};

const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";
const TEST_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
let TEST_TOKEN = "";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "setup-e2e-kid",
  alg: "RS256",
  use: "sig",
};

const db = {
  users: [
    {
      id: TEST_USER_ID,
      auth_id: null,
      email: "seeded@example.com",
      full_name: null,
      first_name: null,
      last_name: null,
      avatar_url: null,
      type: "human",
    },
  ],
  workspaces: [
    {
      id: TEST_WORKSPACE_ID,
      name: "Seeded Workspace",
      owner_user_id: TEST_USER_ID,
      created_at: new Date().toISOString(),
    },
  ],
  agents: [] as AgentRow[],
  credentials: [] as Array<Record<string, unknown>>,
  gatewayConfigs: [] as Array<Record<string, unknown>>,
  gatewayConfigVersions: [] as Array<Record<string, unknown>>,
  gatewayConfigStates: [] as Array<Record<string, unknown>>,
  engineInstances: [] as EngineRow[],
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function postgrestJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  const accept = req.headers.accept ?? "";
  const wantsObject = typeof accept === "string" && accept.includes("application/vnd.pgrst.object+json");
  json(res, status, wantsObject && Array.isArray(body) ? (body[0] ?? null) : body);
}

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve) => {
    let text = "";
    req.on("data", (chunk) => {
      text += String(chunk);
    });
    req.on("end", () => resolve(text));
  });
}

function authorize(req: IncomingMessage) {
  return req.headers.authorization === `Bearer ${TEST_TOKEN}`;
}

function findLatestEngine(agentId: string) {
  return (
    db.engineInstances
      .filter((row) => row.agent_id === agentId)
      .sort((left, right) => right.started_at.localeCompare(left.started_at))[0] ?? null
  );
}

function closeServer(server: ReturnType<typeof createHttpServer> | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("PL-3 setup flow", () => {
  let supabaseServer: ReturnType<typeof createHttpServer>;
  let launcherServer: ReturnType<typeof createHttpServer>;
  let launcherWsServer: WebSocketServer;
  let orchestratorServer: ReturnType<typeof createHttpServer>;
  let orchestratorWsServer: WebSocketServer;
  let appServer: ReturnType<typeof createHttpServer>;
  let apiBaseUrl = "";

  beforeAll(async () => {
    vi.resetModules();
    db.agents.length = 0;
    db.credentials.length = 0;
    db.gatewayConfigs.length = 0;
    db.gatewayConfigVersions.length = 0;
    db.gatewayConfigStates.length = 0;
    db.engineInstances.length = 0;

    supabaseServer = createHttpServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/auth/v1/.well-known/jwks.json") {
        json(res, 200, { keys: [publicJwk] });
        return;
      }

      if (!authorize(req)) {
        json(res, 401, { message: "unauthorized" });
        return;
      }

      if (url.pathname === "/auth/v1/user") {
        json(res, 200, { id: TEST_USER_ID, email: "seeded@example.com" });
        return;
      }

      if (url.pathname === "/rest/v1/user" && req.method === "GET") {
        const authId = url.searchParams.get("auth_id")?.replace(/^eq\./, "");
        const id = url.searchParams.get("id")?.replace(/^eq\./, "");
        const authIdIsNull = url.searchParams.get("auth_id") === "is.null";
        const rows = db.users.filter((user) => {
          if (id && authIdIsNull) return user.id === id && user.auth_id === null;
          if (authId) return user.auth_id === authId;
          if (id) return user.id === id;
          return true;
        });
        postgrestJson(req, res, 200, rows);
        return;
      }

      if (url.pathname === "/rest/v1/workspaces" && req.method === "GET") {
        postgrestJson(req, res, 200, db.workspaces);
        return;
      }

      if (url.pathname === "/rest/v1/agent" && req.method === "GET") {
        const id = url.searchParams.get("id")?.replace(/^eq\./, "");
        const rows = id ? db.agents.filter((agent) => agent.id === id) : db.agents;
        postgrestJson(req, res, 200, rows);
        return;
      }

      if (url.pathname === "/rest/v1/credential" && req.method === "GET") {
        const agentId = url.searchParams.get("agent_id")?.replace(/^eq\./, "");
        const rows = agentId ? db.credentials.filter((credential) => credential.agent_id === agentId) : db.credentials;
        postgrestJson(req, res, 200, rows);
        return;
      }

      if (url.pathname === "/rest/v1/agent" && req.method === "POST") {
        const payload = JSON.parse((await readBody(req)) || "{}");
        const now = new Date().toISOString();
        const row: AgentRow = {
          id: crypto.randomUUID(),
          workspace_id: payload.workspace_id,
          created_by_user_id: payload.created_by_user_id ?? null,
          name: payload.name ?? null,
          model_settings: payload.model_settings ?? {},
          tool_policy: payload.tool_policy ?? {},
          type: payload.type ?? null,
          status: payload.status ?? "active",
          updated_at: now,
        };
        db.agents.push(row);
        postgrestJson(req, res, 201, [row]);
        return;
      }

      if (url.pathname === "/rest/v1/agent" && req.method === "PATCH") {
        const id = url.searchParams.get("id")?.replace(/^eq\./, "");
        const payload = JSON.parse((await readBody(req)) || "{}");
        const row = db.agents.find((agent) => agent.id === id);
        if (!row) {
          json(res, 404, []);
          return;
        }
        Object.assign(row, payload, { updated_at: new Date().toISOString() });
        postgrestJson(req, res, 200, [row]);
        return;
      }

      if (url.pathname === "/rest/v1/credential" && req.method === "POST") {
        const payload = JSON.parse((await readBody(req)) || "{}");
        const row = {
          id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...payload,
        };
        db.credentials.push(row);
        postgrestJson(req, res, 201, [row]);
        return;
      }

      if (url.pathname === "/rest/v1/credential" && req.method === "DELETE") {
        const agentId = url.searchParams.get("agent_id")?.replace(/^eq\./, "");
        if (agentId) {
          for (let index = db.credentials.length - 1; index >= 0; index -= 1) {
            if (db.credentials[index]?.agent_id === agentId) {
              db.credentials.splice(index, 1);
            }
          }
        }
        postgrestJson(req, res, 200, []);
        return;
      }

      if (url.pathname === "/rest/v1/gateway_config" && req.method === "GET") {
        const scopeId = url.searchParams.get("scope_id")?.replace(/^eq\./, "");
        postgrestJson(
          req,
          res,
          200,
          scopeId ? db.gatewayConfigs.filter((row) => row.scope_id === scopeId) : db.gatewayConfigs,
        );
        return;
      }

      if (url.pathname === "/rest/v1/gateway_config" && req.method === "POST") {
        const payload = JSON.parse((await readBody(req)) || "{}");
        const row = {
          id: crypto.randomUUID(),
          updated_at: new Date().toISOString(),
          ...payload,
        };
        db.gatewayConfigs.push(row);
        postgrestJson(req, res, 201, [row]);
        return;
      }

      if (url.pathname === "/rest/v1/gateway_config" && req.method === "PATCH") {
        const id = url.searchParams.get("id")?.replace(/^eq\./, "");
        const payload = JSON.parse((await readBody(req)) || "{}");
        const row = db.gatewayConfigs.find((candidate) => candidate.id === id);
        if (!row) {
          json(res, 404, []);
          return;
        }
        Object.assign(row, payload, { updated_at: new Date().toISOString() });
        postgrestJson(req, res, 200, [row]);
        return;
      }

      if (url.pathname === "/rest/v1/gateway_config_versions" && req.method === "POST") {
        const payload = JSON.parse((await readBody(req)) || "{}");
        const row = {
          id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
          ...payload,
        };
        db.gatewayConfigVersions.push(row);
        postgrestJson(req, res, 201, [row]);
        return;
      }

      if (url.pathname === "/rest/v1/gateway_config_state" && req.method === "GET") {
        const scopeId = url.searchParams.get("scope_id")?.replace(/^eq\./, "");
        postgrestJson(
          req,
          res,
          200,
          scopeId ? db.gatewayConfigStates.filter((row) => row.scope_id === scopeId) : db.gatewayConfigStates,
        );
        return;
      }

      if (url.pathname === "/rest/v1/engine_instance" && req.method === "GET") {
        const agentId = url.searchParams.get("agent_id")?.replace(/^eq\./, "");
        const rows = agentId ? db.engineInstances.filter((row) => row.agent_id === agentId) : db.engineInstances;
        postgrestJson(
          req,
          res,
          200,
          rows.sort((left, right) => right.started_at.localeCompare(left.started_at)).slice(0, 1),
        );
        return;
      }

      if (url.pathname === "/rest/v1/engine_instance" && req.method === "POST") {
        const payload = JSON.parse((await readBody(req)) || "{}");
        const row: EngineRow = {
          instance_id: payload.instance_id,
          agent_id: payload.agent_id,
          workspace_id: payload.workspace_id,
          host: payload.host,
          port: payload.port,
          role: payload.role,
          status: payload.status,
          started_at: payload.started_at,
          last_health_at: payload.last_health_at ?? null,
          updated_at: new Date().toISOString(),
          ws_connection_id: payload.ws_connection_id ?? null,
        };
        db.engineInstances.push(row);
        postgrestJson(req, res, 201, [row]);
        return;
      }

      if (url.pathname === "/rest/v1/engine_instance" && req.method === "PATCH") {
        const instanceId = url.searchParams.get("instance_id")?.replace(/^eq\./, "");
        const payload = JSON.parse((await readBody(req)) || "{}");
        const row = db.engineInstances.find((candidate) => candidate.instance_id === instanceId);
        if (!row) {
          json(res, 404, []);
          return;
        }
        Object.assign(row, payload, { updated_at: new Date().toISOString() });
        postgrestJson(req, res, 200, [row]);
        return;
      }

      json(res, 404, { path: url.pathname });
    });

    await new Promise<void>((resolve) => supabaseServer.listen(0, resolve));
    const supabasePort = (supabaseServer.address() as AddressInfo).port;

    orchestratorServer = createHttpServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/v1/state") {
        json(res, 200, { agents: db.agents.map((agent) => ({ id: agent.id, name: agent.name })) });
        return;
      }
      const agentMatch = /^\/api\/v1\/([^/]+)$/.exec(url.pathname);
      if (agentMatch && req.method === "GET") {
        const agentId = decodeURIComponent(agentMatch[1] ?? "");
        const agent = db.agents.find((row) => row.id === agentId);
        if (!agent) {
          json(res, 404, { error: "not_found" });
          return;
        }
        json(res, 200, { id: agent.id, name: agent.name, workspace_id: agent.workspace_id });
        return;
      }
      json(res, 404, { error: "not_found" });
    });
    orchestratorWsServer = new WebSocketServer({ server: orchestratorServer });
    orchestratorWsServer.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "hello-ok",
          protocol: 3,
          server: { version: "test", connId: "conn-1" },
        }),
      );
    });
    await new Promise<void>((resolve) => orchestratorServer.listen(0, resolve));
    const orchestratorPort = (orchestratorServer.address() as AddressInfo).port;

    launcherServer = createHttpServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const startMatch = /^\/agents\/([^/]+)\/start$/.exec(url.pathname);
      const getAgentMatch = /^\/agents\/([^/]+)$/.exec(url.pathname);
      const stopMatch = /^\/worker-bridge\/sessions\/([^/]+)$/.exec(url.pathname);

      if (getAgentMatch && req.method === "GET") {
        const agentId = decodeURIComponent(getAgentMatch[1] ?? "");
        const agent = db.agents.find((row) => row.id === agentId);
        if (!agent) {
          json(res, 404, { error: "not_found" });
          return;
        }
        json(res, 200, {
          data: {
            id: agent.id,
            name: agent.name,
            workspace_id: agent.workspace_id,
            project_id: null,
            description: null,
            slug: null,
            status: agent.status,
            type: agent.type,
            session_id: null,
            context: null,
            is_active: true,
            model_settings: agent.model_settings,
            tool_policy: agent.tool_policy,
            has_credentials: db.credentials.some((credential) => credential.agent_id === agentId),
            created_at: null,
            updated_at: agent.updated_at,
          },
        });
        return;
      }

      if (startMatch && req.method === "POST") {
        const agentId = decodeURIComponent(startMatch[1] ?? "");
        const agent = db.agents.find((row) => row.id === agentId);
        const gatewayConfig = db.gatewayConfigs.find((row) => row.scope_id === agentId);
        if (!agent || !gatewayConfig) {
          json(res, 404, { error: "missing_agent" });
          return;
        }

        const now = new Date().toISOString();
        const instanceId = agentId;
        const existing = findLatestEngine(agentId);
        if (existing) {
          Object.assign(existing, {
            host: "127.0.0.1",
            port: orchestratorPort,
            status: "running",
            last_health_at: now,
            updated_at: now,
          });
        } else {
          db.engineInstances.push({
            instance_id: instanceId,
            agent_id: agentId,
            workspace_id: agent.workspace_id,
            host: "127.0.0.1",
            port: orchestratorPort,
            role: "orchestrator",
            status: "running",
            started_at: now,
            last_health_at: now,
            updated_at: now,
            ws_connection_id: null,
          });
        }

        db.gatewayConfigStates.splice(0, db.gatewayConfigStates.length, {
          scope_type: "agent",
          scope_id: agentId,
          sync_status: "synced",
          sync_error: null,
          synced_at: now,
          last_applied_hash: gatewayConfig.config_hash,
          last_applied_version: gatewayConfig.version,
          last_apply_status: "ok",
          last_apply_error: null,
          last_apply_at: now,
          broker_instance_id: instanceId,
        });
        json(res, 200, {
          data: {
            id: instanceId,
            port: orchestratorPort,
            config: gatewayConfig.config_json ?? {},
            started_at: now,
            status: "running",
            reused: Boolean(existing),
            agent_id: agentId,
            agent_name: agent.name ?? undefined,
            workspace_id: agent.workspace_id,
          },
        });
        return;
      }

      if (stopMatch && req.method === "DELETE") {
        const instanceId = decodeURIComponent(stopMatch[1] ?? "");
        const engine = db.engineInstances.find((row) => row.instance_id === instanceId);
        if (engine) {
          engine.status = "stopped";
          engine.updated_at = new Date().toISOString();
        }
        json(res, 200, {
          data: engine
            ? {
                id: instanceId,
                kind: "codex",
                command: "codex",
                cwd: "/tmp/workspace",
                status: engine.status,
                started_at: engine.started_at,
                stopped_at: engine.updated_at,
                exit_status: 0,
                env_keys: [],
                credential_keys: [],
                agent_id: engine.agent_id,
                workspace_id: engine.workspace_id,
                credential_id: null,
              }
            : null,
        });
        return;
      }

      json(res, 404, { error: "not_found" });
    });
    launcherWsServer = new WebSocketServer({ noServer: true });
    launcherWsServer.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "hello-ok",
          protocol: 3,
          server: { version: "launcher-test", connId: "launcher-conn-1" },
        }),
      );
    });
    launcherServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (/^\/agents\/[^/]+\/runtime\/ws$/.test(url.pathname)) {
        launcherWsServer.handleUpgrade(req, socket, head, (ws) => {
          launcherWsServer.emit("connection", ws, req);
        });
        return;
      }
      socket.destroy();
    });
    await new Promise<void>((resolve) => launcherServer.listen(0, resolve));
    const launcherPort = (launcherServer.address() as AddressInfo).port;
    process.env.LAUNCHER_BASE_URL = `http://127.0.0.1:${launcherPort}`;

    process.env.SUPABASE_URL = `http://127.0.0.1:${supabasePort}`;
    TEST_TOKEN = jwt.sign({ email: "seeded@example.com", role: "authenticated" }, privateKey, {
      algorithm: "RS256",
      keyid: "setup-e2e-kid",
      issuer: `${process.env.SUPABASE_URL}/auth/v1`,
      audience: "authenticated",
      subject: TEST_USER_ID,
      expiresIn: "5m",
    });
    process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_TOKEN;

    const { createApp } = await import("./app.js");
    const { attachOrchestratorWebSocketProxy } = await import("./ws/orchestrator-proxy.js");
    const { createUpstreamRequester } = await import("./services/upstream.js");
    const app = createApp({
      port: 0,
      host: "127.0.0.1",
      orchestratorBaseUrl: `http://127.0.0.1:${orchestratorPort}`,
      orchestratorWsUrl: `ws://127.0.0.1:${orchestratorPort}`,
      launcherBaseUrl: `http://127.0.0.1:${launcherPort}`,
      orchestratorRequestTimeoutMs: 5_000,
      launcherRequestTimeoutMs: 5_000,
      corsOrigins: "*",
      wsUpgradePath: "/ws",
      wsConnectTimeoutMs: 5_000,
      workItemDefaultWorkspaceId: null,
      githubWebhookSecret: null,
      githubRepoWorkspaceMap: {},
      linearWebhookSecret: null,
      linearApiKey: null,
      linearProjectWorkspaceMap: {},
      linearTeamWorkspaceMap: {},
    });
    appServer = createHttpServer(app);
    attachOrchestratorWebSocketProxy(
      appServer,
      {
        wsUpgradePath: "/ws",
        wsConnectTimeoutMs: 5_000,
      },
      createUpstreamRequester(`http://127.0.0.1:${launcherPort}`, 5_000),
    );
    await new Promise<void>((resolve) => appServer.listen(0, resolve));
    apiBaseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    launcherWsServer.clients.forEach((client) => client.terminate());
    orchestratorWsServer.clients.forEach((client) => client.terminate());
    await Promise.all([
      closeServer(appServer),
      closeServer(launcherServer),
      closeServer(orchestratorServer),
      closeServer(supabaseServer),
    ]);
    launcherWsServer.close();
    orchestratorWsServer.close();
  });

  it("creates setup, proxies agents/ws, and stops cleanly", async () => {
    const createResponse = await fetch(`${apiBaseUrl}/api/setup`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        agentName: "Launch Test Agent",
        model: "openai/gpt-5.2",
        toolPolicy: {},
        workflowTemplate: "default",
        repositoryUrl: "https://github.com/example/repo",
        tracker: {
          kind: "memory",
          config: {},
        },
        runners: [
          {
            kind: "codex",
            model: "openai/gpt-5.2",
            provider: "openai",
            config: {},
          },
        ],
        credentials: [
          {
            provider: "openai",
            keyName: "OPENAI_API_KEY",
            secret: "sk-test-1234",
          },
        ],
        maxConcurrentAgents: 1,
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { agent: SetupAgentPayload; engine: SetupEnginePayload };
    expect(created.agent.id).toBeTruthy();
    expect(created.agent.type).toBe("coding");
    expect(created.engine.status).toBe("running");

    const getResponse = await fetch(`${apiBaseUrl}/api/setup?agentId=${created.agent.id}`, {
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
      },
    });
    expect(getResponse.status).toBe(200);
    const setup = (await getResponse.json()) as { engine: SetupEnginePayload };
    expect(setup.engine.status).toBe("running");

    const agentsResponse = await fetch(`${apiBaseUrl}/api/agents/${created.agent.id}`, {
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
      },
    });
    expect(agentsResponse.status).toBe(200);

    let ws: WebSocket | null = null;
    const helloFrame = await new Promise<string>((resolve, reject) => {
      ws = new WebSocket(
        `${apiBaseUrl.replace("http", "ws")}/ws?agent_id=${created.agent.id}&workspace_id=${TEST_WORKSPACE_ID}&session_key=agent:${created.agent.id}:main`,
        ["platform.v1", `bearer.${TEST_TOKEN}`],
      );
      const timer = setTimeout(() => reject(new Error("websocket hello timed out")), 2_000);
      ws.once("message", (message) => {
        clearTimeout(timer);
        resolve(String(message));
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.once("unexpected-response", (_req, response) => {
        clearTimeout(timer);
        reject(new Error(`websocket upgrade rejected: ${response.statusCode}`));
      });
    });
    expect(helloFrame).toContain("hello-ok");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ws?.terminate();
        resolve();
      }, 2_000);
      ws?.once("close", () => resolve());
      ws?.once("close", () => clearTimeout(timer));
      ws?.close();
    });

    const stopResponse = await fetch(`${apiBaseUrl}/api/worker-bridge/sessions/${created.engine.instanceId}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
      },
    });
    expect(stopResponse.status).toBe(200);
    expect(findLatestEngine(created.agent.id)?.status).toBe("stopped");
  }, 30_000);

  it("persists planning defaults and custom targets through setup", async () => {
    const planningResponse = await fetch(`${apiBaseUrl}/api/setup`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        agentName: "Planning Agent",
        agentType: "planning",
        model: "openai/gpt-5.2",
        toolPolicy: {},
        workflowTemplate: "default",
        tracker: {
          kind: "database",
          config: {},
        },
        runners: [
          {
            kind: "codex",
            model: "openai/gpt-5.2",
            provider: "openai",
            config: {},
          },
        ],
        maxConcurrentAgents: 1,
      }),
    });

    expect(planningResponse.status).toBe(201);
    const planning = (await planningResponse.json()) as { agent: SetupAgentPayload };
    expect(planning.agent.type).toBe("planning");
    expect(planning.agent.toolPolicy).toMatchObject({
      planning: {
        destination: "database",
        tools: [...DEFAULT_PLANNING_TOOL_SLUGS, ...SCHEDULED_TASK_TOOL_SLUGS],
      },
    });

    const customResponse = await fetch(`${apiBaseUrl}/api/setup`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: TEST_WORKSPACE_ID,
        agentName: "Custom Agent",
        agentType: "custom",
        model: "openai/gpt-5.2",
        toolPolicy: {},
        customTarget: {
          backend: {
            type: "openclaw_ws",
            baseUrl: "ws://127.0.0.1:7788",
            agentId: "planner-local",
          },
        },
        workflowTemplate: "default",
        tracker: {
          kind: "memory",
          config: {},
        },
        runners: [
          {
            kind: "codex",
            model: "openai/gpt-5.2",
            provider: "openai",
            config: {},
          },
        ],
        maxConcurrentAgents: 1,
      }),
    });

    expect(customResponse.status).toBe(201);
    const custom = (await customResponse.json()) as {
      agent: { id: string; type: string; toolPolicy: unknown };
      gatewayConfig: { configJson: unknown };
    };
    expect(custom.agent.type).toBe("custom");
    expect(custom.agent.toolPolicy).toMatchObject({
      custom: {
        target_required: true,
      },
    });
    expect(custom.gatewayConfig.configJson).toMatchObject({
      backend: {
        type: "openclaw_ws",
        base_url: "ws://127.0.0.1:7788",
        agent_id: "planner-local",
      },
    });

    const updateResponse = await fetch(`${apiBaseUrl}/api/setup`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: custom.agent.id,
        workspaceId: TEST_WORKSPACE_ID,
        agentName: "Renamed Custom Agent",
        agentType: "custom",
        model: "openai/gpt-5.2",
        toolPolicy: {},
        workflowTemplate: "default",
        tracker: {
          kind: "memory",
          config: {},
        },
        runners: [
          {
            kind: "codex",
            model: "openai/gpt-5.2",
            provider: "openai",
            config: {},
          },
        ],
        maxConcurrentAgents: 1,
      }),
    });

    expect(updateResponse.status).toBe(200);
    const updated = (await updateResponse.json()) as { gatewayConfig: { configJson: unknown } };
    expect(updated.gatewayConfig.configJson).toMatchObject({
      backend: {
        type: "openclaw_ws",
        base_url: "ws://127.0.0.1:7788",
        agent_id: "planner-local",
      },
    });
  }, 30_000);

  it("starts the selected planning agent through the launcher path", async () => {
    const now = new Date().toISOString();
    const agent: AgentRow = {
      id: crypto.randomUUID(),
      workspace_id: TEST_WORKSPACE_ID,
      created_by_user_id: TEST_USER_ID,
      name: "Planning Agent",
      model_settings: { primary: "openai/gpt-5.2" },
      tool_policy: { planning: { destination: "database" } },
      type: "planning",
      status: "active",
      updated_at: now,
    };
    db.agents.push(agent);
    db.gatewayConfigs.push({
      id: crypto.randomUUID(),
      scope_type: "agent",
      scope_id: agent.id,
      version: 1,
      config_hash: "planning-hash",
      config_json: {
        tracker: { kind: "database" },
        runners: [{ kind: "codex", model: "openai/gpt-5.2", provider: "openai" }],
      },
      updated_at: now,
      updated_by: TEST_USER_ID,
    });
    db.credentials.push({
      id: crypto.randomUUID(),
      agent_id: agent.id,
      workspace_id: TEST_WORKSPACE_ID,
      user_id: TEST_USER_ID,
      key_value: { provider: "openai", OPENAI_API_KEY: "sk-test", key_last4: "test" },
      created_at: now,
      updated_at: now,
    });

    const startResponse = await fetch(`${apiBaseUrl}/api/agents/${agent.id}/start`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
      },
    });

    expect(startResponse.status).toBe(200);
    await expect(startResponse.json()).resolves.toMatchObject({
      data: {
        agent_id: agent.id,
        workspace_id: TEST_WORKSPACE_ID,
        status: "running",
      },
    });
    expect(findLatestEngine(agent.id)?.status).toBe("running");
  });

  it("starts a production local relay agent through the launcher path", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const now = new Date().toISOString();
    const agent: AgentRow = {
      id: crypto.randomUUID(),
      workspace_id: TEST_WORKSPACE_ID,
      created_by_user_id: TEST_USER_ID,
      name: "Local Relay Manager",
      model_settings: { primary: "qwen3-coder:30b" },
      tool_policy: {},
      type: "manager",
      status: "active",
      updated_at: now,
    };
    db.agents.push(agent);
    db.gatewayConfigs.push({
      id: crypto.randomUUID(),
      scope_type: "agent",
      scope_id: agent.id,
      version: 1,
      config_hash: "local-relay-hash",
      config_json: {
        runners: [{ kind: "local_relay", model: "qwen3-coder:30b", provider: "local" }],
      },
      updated_at: now,
      updated_by: TEST_USER_ID,
    });

    try {
      const startResponse = await fetch(`${apiBaseUrl}/api/agents/${agent.id}/start`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
        },
      });

      expect(startResponse.status).toBe(200);
      await expect(startResponse.json()).resolves.toMatchObject({
        data: {
          agent_id: agent.id,
          workspace_id: TEST_WORKSPACE_ID,
          status: "running",
        },
      });
      expect(findLatestEngine(agent.id)?.status).toBe("running");
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("returns a clear error for unsupported custom runtime backends", async () => {
    const now = new Date().toISOString();
    const agent: AgentRow = {
      id: crypto.randomUUID(),
      workspace_id: TEST_WORKSPACE_ID,
      created_by_user_id: TEST_USER_ID,
      name: "Custom Agent",
      model_settings: { primary: "openai/gpt-5.2" },
      tool_policy: {},
      type: "custom",
      status: "active",
      updated_at: now,
    };
    db.agents.push(agent);
    db.gatewayConfigs.push({
      id: crypto.randomUUID(),
      scope_type: "agent",
      scope_id: agent.id,
      version: 1,
      config_hash: "custom-hash",
      config_json: {
        backend: {
          type: "openclaw_ws",
          base_url: "ws://127.0.0.1:7788",
          agent_id: "planner-local",
        },
      },
      updated_at: now,
      updated_by: TEST_USER_ID,
    });

    const startResponse = await fetch(`${apiBaseUrl}/api/agents/${agent.id}/start`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
      },
    });

    expect(startResponse.status).toBe(422);
    await expect(startResponse.json()).resolves.toMatchObject({
      error: {
        code: "custom_runtime_unsupported",
        message: expect.any(String),
        details: {
          agent_id: agent.id,
          agent_type: "custom",
        },
      },
    });
    expect(findLatestEngine(agent.id)).toBeNull();
  });
});
