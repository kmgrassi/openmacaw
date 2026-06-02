#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const parsed = {
    agentId: null,
    workspaceId: null,
    appUrl: process.env.PLATFORM_WEB_BASE_URL ?? "http://127.0.0.1:5173",
    message: null,
    artifactsDir: path.join(rootDir, ".run-artifacts", "browser-agent"),
    timeoutMs: Number(process.env.AGENT_BROWSER_SMOKE_TIMEOUT_MS ?? 60_000),
    headful: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      continue;
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
    } else if (arg === "--app-url") {
      parsed.appUrl = argv[index + 1] ?? parsed.appUrl;
      index += 1;
    } else if (arg.startsWith("--app-url=")) {
      parsed.appUrl = arg.slice("--app-url=".length);
    } else if (arg === "--message") {
      parsed.message = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--message=")) {
      parsed.message = arg.slice("--message=".length);
    } else if (arg === "--artifacts-dir") {
      parsed.artifactsDir = argv[index + 1] ?? parsed.artifactsDir;
      index += 1;
    } else if (arg.startsWith("--artifacts-dir=")) {
      parsed.artifactsDir = arg.slice("--artifacts-dir=".length);
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(argv[index + 1] ?? parsed.timeoutMs);
      index += 1;
    } else if (arg.startsWith("--timeout-ms=")) {
      parsed.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    } else if (arg === "--headful") {
      parsed.headful = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  parsed.agentId = parsed.agentId?.trim() || null;
  parsed.workspaceId = parsed.workspaceId?.trim() || null;
  parsed.appUrl = parsed.appUrl.replace(/\/$/, "");
  parsed.message =
    parsed.message?.trim() || `Browser smoke ping ${new Date().toISOString()}`;

  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }

  return parsed;
}

function usage() {
  return `Usage: pnpm run smoke:agent-browser -- --agent-id <id> --workspace-id <id> [options]

Options:
  --app-url <url>        Web app URL (default: http://127.0.0.1:5173)
  --message <text>       Message to send through the UI
  --artifacts-dir <dir>  Parent artifacts directory (default: .run-artifacts/browser-agent)
  --timeout-ms <ms>      Per-step timeout (default: 60000)
  --headful              Show the browser instead of running headless
  --json                 Print machine-readable output
`;
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function summarizeRequest(request) {
  return {
    method: request.method(),
    url: request.url(),
    resourceType: request.resourceType(),
  };
}

function summarizeResponse(response) {
  const request = response.request();
  return {
    method: request.method(),
    url: response.url(),
    status: response.status(),
    resourceType: request.resourceType(),
  };
}

function visibleText(text) {
  return text.replace(/\s+/g, " ").trim();
}

async function writeJson(filePath, value) {
  await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function captureScreenshot(page, artifactDir, name) {
  const filePath = path.join(artifactDir, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

async function ensureAuthenticated(page, options, steps) {
  const targetUrl = `${options.appUrl}/dashboard/${encodeURIComponent(options.agentId)}`;
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  steps.push({ step: "openDashboard", url: page.url() });

  if (!new URL(page.url()).pathname.startsWith("/login")) {
    return;
  }

  const devLoginButton = page.getByRole("button", {
    name: /use dev credentials/i,
  });

  try {
    await devLoginButton.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    throw new Error(
      "Login page did not expose the dev credentials button. Set VITE_DEV_LOGIN_EMAIL and VITE_DEV_LOGIN_PASSWORD in apps/web/.env and restart pnpm run dev.",
    );
  }

  await devLoginButton.click();
  steps.push({ step: "devLoginClicked" });
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: options.timeoutMs,
  });
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  steps.push({ step: "reopenedDashboard", url: page.url() });

  if (new URL(page.url()).pathname.startsWith("/login")) {
    throw new Error("Authentication returned to /login after dev login");
  }
}

async function waitForDashboard(page, options) {
  const expectedPath = `/dashboard/${options.agentId}`;
  await page.waitForURL((url) => url.pathname === expectedPath, {
    timeout: options.timeoutMs,
  });

  await page
    .getByRole("heading", { name: "Harper Parallel Agent" })
    .waitFor({ state: "visible", timeout: options.timeoutMs });

  const errorBoundary = page.getByText(/something went wrong|error boundary/i);
  if (await errorBoundary.isVisible().catch(() => false)) {
    throw new Error(
      `Visible error boundary: ${visibleText(await errorBoundary.textContent())}`,
    );
  }
}

async function sendMessage(page, options, steps) {
  const composer = page.getByPlaceholder("Type a message...");
  await composer.waitFor({ state: "visible", timeout: options.timeoutMs });
  await composer.fill(options.message);
  await page.getByRole("button", { name: "Send" }).click();
  steps.push({ step: "messageSubmitted", message: options.message });

  await page
    .getByRole("region", { name: "Chat messages" })
    .getByText(options.message, { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: options.timeoutMs });

  const statusLocator = page
    .getByText(
      /runtime|queued|started|completed|connecting|provider|credential|approval|error/i,
    )
    .first();
  const statusEvidence = await Promise.race([
    statusLocator
      .waitFor({ state: "visible", timeout: options.timeoutMs })
      .then(async () => visibleText((await statusLocator.textContent()) ?? "")),
    page.waitForTimeout(options.timeoutMs).then(() => null),
  ]);

  if (!statusEvidence) {
    throw new Error(
      "Message rendered, but no runtime status or deterministic blocker became visible",
    );
  }

  steps.push({ step: "runtimeStatusObserved", text: statusEvidence });
}

async function runSmoke(options) {
  const artifactDir = path.join(options.artifactsDir, timestampForPath());
  await fs.promises.mkdir(artifactDir, { recursive: true });

  const consoleEntries = [];
  const networkEntries = [];
  const steps = [];
  const failures = [];
  let browser = null;
  let context = null;
  let page = null;
  let status = "failed";
  let finalScreenshot = null;

  try {
    browser = await chromium.launch({ headless: !options.headful });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    page = await context.newPage();
    page.setDefaultTimeout(options.timeoutMs);

    page.on("console", (message) => {
      consoleEntries.push({
        type: message.type(),
        text: message.text(),
        location: message.location(),
      });
      if (message.type() === "error") {
        failures.push(`console error: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      failures.push(`page error: ${error.message}`);
    });
    page.on("requestfailed", (request) => {
      networkEntries.push({
        ...summarizeRequest(request),
        failed: true,
        failure: request.failure()?.errorText ?? null,
      });
    });
    page.on("response", (response) => {
      const summary = summarizeResponse(response);
      networkEntries.push(summary);
      const isAppRequest = summary.url.startsWith(options.appUrl);
      const isApiLike =
        summary.resourceType === "fetch" || summary.resourceType === "xhr";
      if (isAppRequest && isApiLike && summary.status >= 500) {
        failures.push(
          `${summary.method} ${summary.url} returned ${summary.status}`,
        );
      }
    });

    await ensureAuthenticated(page, options, steps);
    await captureScreenshot(page, artifactDir, "01-dashboard");
    await waitForDashboard(page, options);
    await sendMessage(page, options, steps);
    finalScreenshot = await captureScreenshot(
      page,
      artifactDir,
      "02-after-send",
    );

    if (failures.length > 0) {
      throw new Error(failures[0]);
    }

    status = "passed";
  } catch (error) {
    failures.push(error.message);
    if (page) {
      finalScreenshot = await captureScreenshot(
        page,
        artifactDir,
        "failure",
      ).catch(() => null);
    }
  } finally {
    await writeJson(path.join(artifactDir, "console.json"), consoleEntries);
    await writeJson(path.join(artifactDir, "network.json"), networkEntries);
    await context?.close();
    await browser?.close();
  }

  const result = {
    status,
    agentId: options.agentId,
    workspaceId: options.workspaceId,
    appUrl: options.appUrl,
    message: options.message,
    artifactDir,
    finalScreenshot,
    steps,
    failures,
    consoleErrorCount: consoleEntries.filter((entry) => entry.type === "error")
      .length,
    failedNetworkCount: networkEntries.filter((entry) => entry.failed).length,
  };
  await writeJson(path.join(artifactDir, "result.json"), result);
  return result;
}

function printHumanResult(result) {
  const icon = result.status === "passed" ? "pass" : "fail";
  process.stdout.write(`${icon} browser agent smoke ${result.status}\n`);
  process.stdout.write(`agent: ${result.agentId}\n`);
  process.stdout.write(`workspace: ${result.workspaceId}\n`);
  process.stdout.write(
    `artifacts: ${path.relative(rootDir, result.artifactDir)}\n`,
  );

  if (result.failures.length > 0) {
    process.stdout.write("\nFailures:\n");
    for (const failure of result.failures) {
      process.stdout.write(`- ${failure}\n`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  if (!options.agentId) {
    throw new Error("--agent-id is required");
  }
  if (!options.workspaceId) {
    throw new Error("--workspace-id is required");
  }

  const result = await runSmoke(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printHumanResult(result);
  }

  if (result.status !== "passed") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
