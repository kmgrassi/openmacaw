import { afterEach, describe, expect, it } from "vitest";

import { deriveWsUrl, loadApiConfig, loadToolExecutionConfig } from "./config.js";

const ORIGINAL_ENV = { ...process.env };

describe("deriveWsUrl", () => {
  it("maps https to wss", () => {
    expect(deriveWsUrl("https://example.com")).toBe("wss://example.com");
  });

  it("falls back on invalid input", () => {
    expect(deriveWsUrl("not a url")).toBe("ws://127.0.0.1:4000");
  });
});

describe("loadApiConfig", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("loads launcher defaults", () => {
    delete process.env.HOST;
    delete process.env.LAUNCHER_BASE_URL;
    delete process.env.LAUNCHER_REQUEST_TIMEOUT_MS;

    const config = loadApiConfig();

    expect(config.host).toBe("::");
    expect(config.launcherBaseUrl).toBe("http://127.0.0.1:4100");
    expect(config.launcherRequestTimeoutMs).toBe(15000);
  });

  it("loads host override", () => {
    process.env.HOST = "127.0.0.1";

    const config = loadApiConfig();

    expect(config.host).toBe("127.0.0.1");
  });

  it("loads launcher overrides", () => {
    process.env.LAUNCHER_BASE_URL = "https://launcher.internal/";
    process.env.LAUNCHER_REQUEST_TIMEOUT_MS = "2500";

    const config = loadApiConfig();

    expect(config.launcherBaseUrl).toBe("https://launcher.internal");
    expect(config.launcherRequestTimeoutMs).toBe(2500);
  });

  it("loads legacy local-chat HTTP helper defaults for development compatibility", () => {
    delete process.env.LOCAL_TOOL_HELPER_URL;
    delete process.env.HELPER_DAEMON_URL;
    delete process.env.TOOL_EXECUTION_TIMEOUT_MS;
    delete process.env.LOCAL_CODING_EXECUTION_TARGET_KIND;

    const config = loadToolExecutionConfig();

    expect(config.legacyLocalChatToolHelperBaseUrl).toBe("http://localhost:17654");
    expect(config.toolExecutionTimeoutMs).toBe(30_000);
    expect(config.localCodingExecutionTargetKind).toBe("local_helper");
  });

  it("loads legacy local-chat HTTP helper overrides", () => {
    process.env.LOCAL_TOOL_HELPER_URL = "http://legacy-local-chat-helper.internal/";
    process.env.TOOL_EXECUTION_TIMEOUT_MS = "45000";
    process.env.LOCAL_CODING_EXECUTION_TARGET_KIND = "container";

    const config = loadToolExecutionConfig();

    expect(config.legacyLocalChatToolHelperBaseUrl).toBe("http://legacy-local-chat-helper.internal");
    expect(config.toolExecutionTimeoutMs).toBe(45_000);
    expect(config.localCodingExecutionTargetKind).toBe("container");
  });
});
