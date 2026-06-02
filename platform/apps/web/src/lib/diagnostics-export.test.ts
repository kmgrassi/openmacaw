import { describe, expect, it } from "vitest";
import {
  browserConsoleErrorInternalsForTest,
  getCapturedBrowserConsoleErrors,
  clearCapturedBrowserConsoleErrors,
} from "./browser-console-errors";
import { buildDiagnosticsExport } from "./diagnostics-export";

describe("browser console error capture", () => {
  it("redacts token-like values from captured console errors", () => {
    clearCapturedBrowserConsoleErrors();

    browserConsoleErrorInternalsForTest.capture("console.error", [
      "request failed",
      {
        accessToken: "secret-token",
        nested: { authorization: "Bearer abc.def.ghi" },
        message: "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
      },
    ]);

    expect(getCapturedBrowserConsoleErrors()).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("[redacted]"),
      }),
    ]);
    expect(getCapturedBrowserConsoleErrors()[0]?.message).not.toContain(
      "secret-token",
    );
    expect(getCapturedBrowserConsoleErrors()[0]?.message).not.toContain(
      "Bearer abc",
    );
  });

  it("redacts token-like values from Error messages", () => {
    clearCapturedBrowserConsoleErrors();

    browserConsoleErrorInternalsForTest.capture("unhandledrejection", [
      new Error(
        "request failed with Bearer abc.def.ghi and jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
      ),
    ]);

    const [captured] = getCapturedBrowserConsoleErrors();
    expect(captured?.message).toContain("Bearer [redacted]");
    expect(captured?.message).toContain("[redacted.jwt]");
    expect(captured?.message).not.toContain("Bearer abc");
    expect(captured?.message).not.toContain("eyJhbGci");
  });
});

describe("buildDiagnosticsExport", () => {
  it("omits gateway auth and snapshot data from hello payloads", () => {
    const payload = buildDiagnosticsExport({
      capturedAt: "2026-05-11T12:00:00.000Z",
      currentUrl: "http://127.0.0.1:5173/settings/runtime",
      selectedWorkspaceId: "11111111-1111-4111-8111-111111111111",
      selectedAgentId: "22222222-2222-4222-8222-222222222222",
      authState: {
        status: "authenticated",
        hasUser: true,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        resolvedAgentId: "22222222-2222-4222-8222-222222222222",
        onboarding: { required: false, blocking: false, reasons: [] },
        defaultAgents: {
          planning: { agentId: null, configured: false, missing: [] },
          coding: {
            agentId: "22222222-2222-4222-8222-222222222222",
            configured: true,
            missing: [],
          },
        },
        managerAgent: { agentId: null, configured: false, missing: [] },
        providerWarnings: [],
        agents: [],
        workspaces: [],
      },
      gateway: {
        connected: true,
        status: "connected",
        gatewayReady: true,
        scope: null,
        target: null,
        hello: {
          type: "hello-ok",
          protocol: 1,
          auth: { deviceToken: "secret-token", scopes: ["agent"] },
          snapshot: { token: "secret" },
        },
        diagnostics: {
          connectAttempts: 1,
          lastOpenAt: null,
          lastConnectSentAt: null,
          lastHelloAt: null,
          lastCloseCode: null,
          lastCloseReason: null,
          lastFrameType: null,
          lastFrameAt: null,
          lastAbnormalCloseAt: null,
        },
      },
      agentHealth: null,
      agentDiagnostic: null,
      browserConsoleErrors: [],
    });

    expect(payload.gateway.hello).toEqual({
      type: "hello-ok",
      protocol: 1,
      server: undefined,
      features: undefined,
      policy: undefined,
    });
    expect(JSON.stringify(payload)).not.toContain("secret-token");
  });
});
