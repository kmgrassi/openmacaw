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
    delete process.env.CONTAINER_EXECUTION_ROUTING_MODE;
    delete process.env.CONTAINER_EXECUTION_ALLOWLIST_WORKSPACE_IDS;
    delete process.env.CONTAINER_EXECUTION_ROLLOUT_PERCENTAGE;

    const config = loadToolExecutionConfig();

    expect(config.legacyLocalChatToolHelperBaseUrl).toBe("http://localhost:17654");
    expect(config.toolExecutionTimeoutMs).toBe(30_000);
    expect(config.localCodingExecutionTargetKind).toBe("local_helper");
    expect(config.containerExecutionRouting).toEqual({
      mode: "local_helper_default",
      allowlistWorkspaceIds: [],
      percentage: 0,
    });
  });

  it("loads legacy local-chat HTTP helper overrides", () => {
    process.env.LOCAL_TOOL_HELPER_URL = "http://legacy-local-chat-helper.internal/";
    process.env.TOOL_EXECUTION_TIMEOUT_MS = "45000";
    process.env.LOCAL_CODING_EXECUTION_TARGET_KIND = "container";
    process.env.CONTAINER_EXECUTION_ROUTING_MODE = "percentage";
    process.env.CONTAINER_EXECUTION_ALLOWLIST_WORKSPACE_IDS =
      "22222222-2222-4222-8222-222222222222, 33333333-3333-4333-8333-333333333333";
    process.env.CONTAINER_EXECUTION_ROLLOUT_PERCENTAGE = "25";

    const config = loadToolExecutionConfig();

    expect(config.legacyLocalChatToolHelperBaseUrl).toBe("http://legacy-local-chat-helper.internal");
    expect(config.toolExecutionTimeoutMs).toBe(45_000);
    expect(config.localCodingExecutionTargetKind).toBe("container");
    expect(config.containerExecutionRouting).toEqual({
      mode: "percentage",
      allowlistWorkspaceIds: ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"],
      percentage: 25,
    });
  });

  it("fails closed for invalid container routing config", () => {
    process.env.CONTAINER_EXECUTION_ROUTING_MODE = "unknown";
    process.env.CONTAINER_EXECUTION_ROLLOUT_PERCENTAGE = "250";

    const config = loadToolExecutionConfig();

    expect(config.containerExecutionRouting).toEqual({
      mode: "local_helper_default",
      allowlistWorkspaceIds: [],
      percentage: 100,
    });
  });
});
