import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAppUserByAuthId } from "../services/auth/app-user.js";

import { clearAuthJwtCacheForTests, requireAuth, verifyBearerToken } from "./authJwt.js";

vi.mock("../services/auth/app-user.js", () => ({
  getAppUserByAuthId: vi.fn(),
}));

const userId = "44444444-4444-4444-8444-444444444444";

type TestKey = ReturnType<typeof createTestKey>;
let keys: TestKey[] = [];

function createTestKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    publicJwk: {
      ...publicKey.export({ format: "jwk" }),
      kid,
      alg: "RS256",
      use: "sig",
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(payload);
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind to a TCP port");
  }
  return address.port;
}

function closeServer(server: ReturnType<typeof createServer> | undefined) {
  if (!server) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function signToken(key: TestKey, overrides: jwt.SignOptions = {}) {
  return jwt.sign(
    {
      email: "user@example.com",
      role: "authenticated",
    },
    key.privateKey,
    {
      algorithm: "RS256",
      keyid: key.kid,
      issuer: process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL}/auth/v1` : undefined,
      audience: "authenticated",
      subject: userId,
      expiresIn: "5m",
      ...overrides,
    },
  );
}

function currentTestKey(): TestKey {
  const key = keys[0];
  if (!key) {
    throw new Error("test key was not initialized");
  }
  return key;
}

function mockAuthResponse() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

describe("Supabase JWT verification", () => {
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    keys = [createTestKey("kid-1")];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/auth/v1/.well-known/jwks.json") {
        return json(res, 200, { keys: keys.map((key) => key.publicJwk) });
      }
      if (req.method === "GET" && url.pathname === "/auth/v1/user") {
        if (req.headers.authorization === "Bearer hs256-valid-token") {
          return json(res, 200, { id: userId, email: "user@example.com", role: "authenticated" });
        }
        return json(res, 401, { error: "invalid_token" });
      }
      return json(res, 404, { error: "not_found" });
    });
    const port = await listen(server);
    process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    clearAuthJwtCacheForTests();
  });

  afterEach(async () => {
    clearAuthJwtCacheForTests();
    vi.mocked(getAppUserByAuthId).mockReset();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await closeServer(server);
  });

  it("accepts a valid RS256 Supabase JWT", async () => {
    await expect(verifyBearerToken(signToken(currentTestKey()))).resolves.toMatchObject({
      userId,
      email: "user@example.com",
      role: "authenticated",
    });
  });

  it("rejects expired tokens", async () => {
    await expect(verifyBearerToken(signToken(currentTestKey(), { expiresIn: "-1s" }))).rejects.toThrow("jwt expired");
  });

  it("rejects the wrong audience", async () => {
    await expect(verifyBearerToken(signToken(currentTestKey(), { audience: "anon" }))).rejects.toThrow(
      "jwt audience invalid",
    );
  });

  it("rejects the wrong issuer", async () => {
    await expect(
      verifyBearerToken(signToken(currentTestKey(), { issuer: "https://example.test/auth/v1" })),
    ).rejects.toThrow("jwt issuer invalid");
  });

  it("loads a new JWKS key on kid miss", async () => {
    const nextKey = createTestKey("kid-2");
    keys = [nextKey];

    await expect(verifyBearerToken(signToken(nextKey))).resolves.toMatchObject({ userId });
  });

  it("accepts HS256 Supabase JWTs by delegating verification to Supabase Auth", async () => {
    const token = jwt.sign({ sub: userId }, "secret", {
      algorithm: "HS256",
      keyid: "kid-1",
      issuer: `${process.env.SUPABASE_URL}/auth/v1`,
      audience: "authenticated",
      expiresIn: "5m",
    });

    const originalFetch = global.fetch;
    global.fetch = (async (input, init) => {
      expect(String(input)).toBe(`${process.env.SUPABASE_URL}/auth/v1/user`);
      expect(init?.headers).toMatchObject({
        apikey: "service-role-key",
        authorization: `Bearer ${token}`,
      });
      return new Response(JSON.stringify({ id: userId, email: "user@example.com", role: "authenticated" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await expect(verifyBearerToken(token)).resolves.toMatchObject({
        userId,
        email: "user@example.com",
        role: "authenticated",
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("normalizes HS256 Supabase Auth failures", async () => {
    const token = jwt.sign({ sub: userId }, "secret", {
      algorithm: "HS256",
      keyid: "kid-1",
      issuer: `${process.env.SUPABASE_URL}/auth/v1`,
      audience: "authenticated",
      expiresIn: "5m",
    });

    const originalFetch = global.fetch;
    global.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    try {
      await expect(verifyBearerToken(token)).rejects.toMatchObject({
        name: "AuthJwtError",
        code: "invalid_token",
        message: "network down",
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("rejects unsupported JWT algorithms", async () => {
    const token = jwt.sign({ sub: userId }, "secret", {
      algorithm: "HS384",
      keyid: "kid-1",
      issuer: `${process.env.SUPABASE_URL}/auth/v1`,
      audience: "authenticated",
      expiresIn: "5m",
    });

    await expect(verifyBearerToken(token)).rejects.toThrow("JWT algorithm is not allowed");
  });

  it("returns 503 when app-user resolution fails after token verification", async () => {
    const token = signToken(currentTestKey());
    vi.mocked(getAppUserByAuthId).mockRejectedValue(new Error("Supabase user query failed (503)"));
    const req = {
      header: vi.fn((name: string) => (name === "authorization" ? `Bearer ${token}` : undefined)),
    } as unknown as Request;
    const res = mockAuthResponse();
    const next = vi.fn() as NextFunction;

    await requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: "app_user_lookup_failed",
        message: "Could not resolve authenticated app user",
      },
    });
  });

  it("sets request app user identity after token and app-user resolution", async () => {
    const token = signToken(currentTestKey());
    vi.mocked(getAppUserByAuthId).mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      auth_id: userId,
      email: "user@example.com",
    } as Awaited<ReturnType<typeof getAppUserByAuthId>>);
    const req = {
      header: vi.fn((name: string) => (name === "authorization" ? `Bearer ${token}` : undefined)),
    } as unknown as Request;
    const res = mockAuthResponse();
    const next = vi.fn() as NextFunction;

    await requireAuth(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect(req.authUserId).toBe(userId);
    expect(req.userId).toBe("55555555-5555-4555-8555-555555555555");
  });
});
