import { describe, it, expect, vi } from "vitest";

// Mock brokerFetch so we can inspect the URL it receives.
vi.mock("./broker-fetch", () => ({
  brokerFetch: vi.fn(async () => new Response()),
}));

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { brokerFetch } from "./broker-fetch";
const mockBrokerFetch = vi.mocked(brokerFetch);

import { workspaceScopedFetch } from "./workspace-scoped-fetch";

describe("workspaceScopedFetch", () => {
  it("appends workspaceId as a query param to a plain path", async () => {
    await workspaceScopedFetch("ws_123", "/api/things");

    expect(mockBrokerFetch).toHaveBeenCalledWith(
      "/api/things?workspaceId=ws_123",
      undefined,
    );
  });

  it("uses & when the path already contains a query string", async () => {
    await workspaceScopedFetch("ws_456", "/api/things?foo=bar");

    expect(mockBrokerFetch).toHaveBeenCalledWith(
      "/api/things?foo=bar&workspaceId=ws_456",
      undefined,
    );
  });

  it("encodes special characters in workspaceId", async () => {
    await workspaceScopedFetch("has spaces&more", "/api/x");

    expect(mockBrokerFetch).toHaveBeenCalledWith(
      "/api/x?workspaceId=has%20spaces%26more",
      undefined,
    );
  });

  it("forwards RequestInit to brokerFetch", async () => {
    const init: RequestInit = { method: "POST", body: "{}" };
    await workspaceScopedFetch("ws_789", "/api/y", init);

    expect(mockBrokerFetch).toHaveBeenCalledWith(
      "/api/y?workspaceId=ws_789",
      init,
    );
  });
});
