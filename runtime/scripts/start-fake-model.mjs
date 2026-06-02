#!/usr/bin/env node

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCENARIO_DIR = join(__dirname, "fixtures", "fake-model");
const DEFAULT_PORT = 7999;
const DEFAULT_HOST = "127.0.0.1";
const REDACTED = "[REDACTED]";

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

if (options.listScenarios) {
  for (const scenario of listScenarios(options.scenarioDir)) {
    console.log(`${scenario.id}\t${scenario.description || ""}`);
  }
  process.exit(0);
}

const scenario = loadScenario(options.scenario, options.scenarioDir);
const transcript = [];

if (options.transcript) {
  mkdirSync(dirname(options.transcript), { recursive: true });
}

const server = createServer(async (req, res) => {
  try {
    await routeRequest(req, res);
  } catch (error) {
    const record = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      method: req.method,
      path: requestPath(req),
      error: error.message,
    };
    recordTranscript(record);
    sendJson(res, 500, { error: { message: "fake model internal error", detail: error.message } });
  }
});

server.listen(options.port, options.host, () => {
  const baseUrl = `http://${options.host}:${options.port}/v1`;
  console.error(`[fake-model] listening on ${baseUrl}`);
  console.error(`[fake-model] scenario ${scenario.id}`);
  console.error(`[fake-model] debug requests http://${options.host}:${options.port}/debug/requests`);
});

async function routeRequest(req, res) {
  const path = requestPath(req);

  if (req.method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true, scenario: scenario.id, requests: transcript.length });
    return;
  }

  if (req.method === "GET" && path === "/debug/requests") {
    sendJson(res, 200, { scenario: scenario.id, requests: transcript });
    return;
  }

  if (req.method === "GET" && path === "/debug/requests.jsonl") {
    sendText(res, 200, transcript.map((record) => JSON.stringify(record)).join("\n") + (transcript.length > 0 ? "\n" : ""), "application/jsonl");
    return;
  }

  if (req.method === "POST" && path === "/debug/reset") {
    transcript.length = 0;
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
    await handleChatCompletions(req, res);
    return;
  }

  sendJson(res, 404, { error: { message: `unsupported fake model route: ${req.method} ${path}` } });
}

async function handleChatCompletions(req, res) {
  const rawBody = await readBody(req);
  const decodedBody = decodeJson(rawBody);
  const record = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    method: req.method,
    path: requestPath(req),
    scenario: scenario.id,
    headers: sanitizeHeaders(req.headers),
    body: sanitizeRequestBody(decodedBody),
  };
  recordTranscript(record);

  const delayMs = numberValue(scenario.delay_ms, 0);
  if (delayMs > 0) {
    await delay(delayMs);
  }

  const status = numberValue(scenario.status, 200);

  if (decodedBody && decodedBody.stream === true && scenario.stream?.chunks) {
    sendStream(res, status, scenario.stream.chunks, numberValue(scenario.stream.delay_ms, 0));
    return;
  }

  sendJson(res, status, scenario.response || {});
}

function sendStream(res, status, chunks, delayMs) {
  res.writeHead(status, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const writeChunks = async () => {
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      if (delayMs > 0) {
        await delay(delayMs);
      }
    }
    res.write("data: [DONE]\n\n");
    res.end();
  };

  writeChunks().catch((error) => {
    res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
    res.end();
  });
}

function recordTranscript(record) {
  transcript.push(record);

  if (options.transcript) {
    appendFileSync(options.transcript, `${JSON.stringify(record)}\n`);
  }
}

function loadScenario(name, scenarioDir) {
  const scenarioPath = resolve(scenarioDir, `${name}.json`);
  let decoded;

  try {
    decoded = JSON.parse(readFileSync(scenarioPath, "utf8"));
  } catch (error) {
    throw new Error(`failed to load fake model scenario ${scenarioPath}: ${error.message}`);
  }

  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error(`fake model scenario ${scenarioPath} must be a JSON object`);
  }

  if (!decoded.id || decoded.id !== name) {
    throw new Error(`fake model scenario ${scenarioPath} must set id to ${JSON.stringify(name)}`);
  }

  if (!decoded.response && !decoded.stream) {
    throw new Error(`fake model scenario ${scenarioPath} must define response or stream`);
  }

  return decoded;
}

function listScenarios(scenarioDir) {
  return readdirSync(scenarioDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const decoded = JSON.parse(readFileSync(join(scenarioDir, file), "utf8"));
      return { id: decoded.id || file.replace(/\.json$/, ""), description: decoded.description || "" };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function sanitizeHeaders(headers) {
  const sanitized = {};

  for (const [key, value] of Object.entries(headers)) {
    if (["authorization", "x-api-key", "api-key", "apikey"].includes(key.toLowerCase())) {
      sanitized[key] = REDACTED;
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

function sanitizeRequestBody(body) {
  if (!body || typeof body !== "object") {
    return body;
  }

  const sanitized = structuredClone(body);

  for (const key of ["api_key", "apikey", "bearer_token", "authorization"]) {
    if (Object.hasOwn(sanitized, key)) {
      sanitized[key] = REDACTED;
    }
  }

  return sanitized;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function decodeJson(rawBody) {
  if (!rawBody) {
    return null;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return { _raw: rawBody };
  }
}

function sendJson(res, status, body) {
  sendText(res, status, JSON.stringify(body, null, 2), "application/json");
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, { "content-type": `${contentType}; charset=utf-8` });
  res.end(body);
}

function requestPath(req) {
  return new URL(req.url, "http://fake-model.local").pathname;
}

function numberValue(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const parsed = {
    host: process.env.FAKE_MODEL_HOST || DEFAULT_HOST,
    port: Number.parseInt(process.env.FAKE_MODEL_PORT || `${DEFAULT_PORT}`, 10),
    scenario: process.env.FAKE_MODEL_SCENARIO || "plain-message",
    scenarioDir: process.env.FAKE_MODEL_SCENARIO_DIR || DEFAULT_SCENARIO_DIR,
    transcript: process.env.FAKE_MODEL_TRANSCRIPT || null,
    listScenarios: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--":
        break;
      case "--host":
        parsed.host = argv[++index];
        break;
      case "--port":
        parsed.port = Number.parseInt(argv[++index], 10);
        break;
      case "--scenario":
        parsed.scenario = argv[++index];
        break;
      case "--scenario-dir":
        parsed.scenarioDir = argv[++index];
        break;
      case "--transcript":
        parsed.transcript = argv[++index];
        break;
      case "--list-scenarios":
        parsed.listScenarios = true;
        break;
      case "--help":
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(parsed.port) || parsed.port <= 0) {
    throw new Error(`Invalid --port: ${parsed.port}`);
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage: pnpm run start:fake-model -- [options]

Starts a local OpenAI-compatible fake model endpoint.

Options:
  --scenario <id>          Scenario fixture id. Default: plain-message
  --scenario-dir <path>    Scenario fixture directory.
  --host <host>            Listen host. Default: 127.0.0.1
  --port <port>            Listen port. Default: 7999
  --transcript <path>      Append sanitized request transcript JSONL.
  --list-scenarios         Print available scenarios and exit.
  --help                   Show this help.

Provider profile values for the runtime:
  provider=openai_compatible
  model=fake-openai-compatible
  base_url=http://127.0.0.1:7999/v1
  api_key=fake-token
`);
}
