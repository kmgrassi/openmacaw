import fs from "node:fs";
import { execFileSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const SECRET_KEY_PATTERN =
  /(key|token|secret|password|credential|authorization|auth|private)/i;

export function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, path: filePath, values: {}, keys: [] };
  }

  const values = {};
  const contents = fs.readFileSync(filePath, "utf8");

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match =
      line.match(/^export\s+([^=]+)=(.*)$/) ?? line.match(/^([^=]+)=(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1].trim();
    let value = match[2].trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return {
    exists: true,
    path: filePath,
    values,
    keys: Object.keys(values).sort(),
  };
}

export function redactEnvValue(key, value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  if (!SECRET_KEY_PATTERN.test(key)) {
    return value;
  }

  return "[redacted]";
}

export function loadRedactedEnv(filePath) {
  const env = loadEnvFile(filePath);
  return {
    ...env,
    values: Object.fromEntries(
      Object.entries(env.values).map(([key, value]) => [
        key,
        redactEnvValue(key, value),
      ]),
    ),
  };
}

export function findLocalEnvFile(rootDir) {
  const directPath = path.join(rootDir, ".env");
  if (fs.existsSync(directPath)) {
    return directPath;
  }

  let worktreeList = "";
  try {
    worktreeList = execFileSync(
      "git",
      ["-C", rootDir, "worktree", "list", "--porcelain"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return null;
  }

  for (const line of worktreeList.split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) {
      continue;
    }

    const worktreePath = line.slice("worktree ".length);
    const candidatePath = path.join(worktreePath, ".env");
    if (worktreePath !== rootDir && fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

export function hasEnvValue(env, key) {
  return (
    typeof env.values[key] === "string" && env.values[key].trim().length > 0
  );
}

export function probePort(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () =>
      finish({ ok: true, host, port, reachable: true, error: null }),
    );
    socket.once("timeout", () =>
      finish({ ok: false, host, port, reachable: false, error: "timeout" }),
    );
    socket.once("error", (error) =>
      finish({
        ok: false,
        host,
        port,
        reachable: false,
        error: error.code ?? error.message,
      }),
    );
    socket.connect(port, host);
  });
}

export async function probeHttpJson(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    accept: "application/json,text/plain,*/*",
    ...(options.headers ?? {}),
  };

  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      signal: controller.signal,
      headers,
      body: options.body,
    });
    const text = await response.text();
    let json = null;

    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    return {
      ok: response.ok,
      url,
      status: response.status,
      statusText: response.statusText,
      json,
      text: json ? undefined : text.slice(0, 500),
    };
  } catch (error) {
    return {
      ok: false,
      url,
      status: null,
      statusText: null,
      json: null,
      error:
        error.name === "AbortError" ? "timeout" : (error.code ?? error.message),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function readRecentLogInfo(filePath, now = new Date()) {
  if (!fs.existsSync(filePath)) {
    return {
      exists: false,
      path: filePath,
      size: 0,
      modifiedAt: null,
      ageSeconds: null,
    };
  }

  const stat = fs.statSync(filePath);
  const ageSeconds = Math.max(
    0,
    Math.round((now.getTime() - stat.mtimeMs) / 1000),
  );

  return {
    exists: true,
    path: filePath,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    ageSeconds,
  };
}

export function workspaceDependencyStatus(rootDir) {
  const nodeModulesPath = path.join(rootDir, "node_modules");
  const lockfilePath = path.join(rootDir, "pnpm-lock.yaml");
  const result = {
    nodeModulesPath,
    lockfilePath,
    nodeModulesExists: fs.existsSync(nodeModulesPath),
    lockfileExists: fs.existsSync(lockfilePath),
    resolvedPackages: [],
    missingPackages: [],
  };

  for (const packageName of ["zod"]) {
    try {
      result.resolvedPackages.push({
        name: packageName,
        path: require.resolve(packageName, { paths: [rootDir] }),
      });
    } catch {
      result.missingPackages.push(packageName);
    }
  }

  result.ok =
    result.nodeModulesExists &&
    result.lockfileExists &&
    result.missingPackages.length === 0;

  return result;
}

export function printCheckTable(checks) {
  const maxNameLength = Math.max(
    ...checks.map((check) => check.name.length),
    4,
  );

  for (const check of checks) {
    const status = check.status.padEnd(5);
    const name = check.name.padEnd(maxNameLength);
    console.log(`${status} ${name} ${check.summary}`);
  }
}

export function classifyPlatformFailure(checks) {
  const failed = checks.filter((check) => check.status === "fail");

  if (failed.length === 0) {
    return "local platform checks passed";
  }

  if (failed.some((check) => check.name.includes("env"))) {
    return "fix missing env files or keys, then rerun pnpm run doctor";
  }

  if (failed.some((check) => check.name === "deps")) {
    return "run pnpm install from the repo root, then rerun pnpm run doctor";
  }

  if (failed.some((check) => check.name === "api" || check.name === "web")) {
    return "start the platform with pnpm run dev, then rerun pnpm run doctor";
  }

  if (
    failed.some(
      (check) => check.name === "launcher" || check.name === "orchestrator",
    )
  ) {
    return "start parallel-agent-runtime with pnpm run start:local, then rerun pnpm run doctor";
  }

  if (failed.some((check) => check.name === "logs")) {
    return "start the platform with pnpm run dev and wait for logs, then rerun pnpm run doctor";
  }

  return "inspect the failing checks above, fix the first blocker, then rerun pnpm run doctor";
}
