import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import jwksRsa from "jwks-rsa";

import { errorPayload, requestAccessToken } from "../http.js";
import { errorMessage, logEvent } from "../logger.js";
import { getAppUserByAuthId, type AppUserRow } from "../services/auth/app-user.js";

export type VerifiedAuth = {
  accessToken: string;
  userId: string;
  email?: string;
  role?: string;
};

type SupabaseJwtPayload = jwt.JwtPayload & {
  sub?: string;
  email?: string;
  role?: string;
};

type SupabaseUserResponse = {
  id?: string;
  email?: string;
  role?: string;
};

const clients = new Map<string, jwksRsa.JwksClient>();

export class AuthJwtError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthJwtError";
  }
}

function supabaseUrl() {
  const value = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
  if (!value) {
    throw new AuthJwtError("auth_unconfigured", "SUPABASE_URL is required for JWT verification");
  }
  return value;
}

function jwksClientForIssuer(issuer: string) {
  let client = clients.get(issuer);
  if (!client) {
    client = jwksRsa({
      jwksUri: `${issuer}/.well-known/jwks.json`,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 10 * 60 * 1000,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    });
    clients.set(issuer, client);
  }
  return client;
}

function signingKeyForKid(issuer: string, kid: string) {
  const client = jwksClientForIssuer(issuer);
  return new Promise<string>((resolve, reject) => {
    client.getSigningKey(kid, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      const signingKey = key?.getPublicKey();
      if (!signingKey) {
        reject(new Error(`No public key found for kid ${kid}`));
        return;
      }
      resolve(signingKey);
    });
  });
}

function verifyJwt(token: string, key: string, issuer: string) {
  return new Promise<SupabaseJwtPayload>((resolve, reject) => {
    jwt.verify(
      token,
      key,
      {
        algorithms: ["RS256"],
        audience: "authenticated",
        issuer,
      },
      (error, decoded) => {
        if (error) {
          reject(error);
          return;
        }
        if (!decoded || typeof decoded === "string") {
          reject(new Error("JWT payload is not an object"));
          return;
        }
        resolve(decoded as SupabaseJwtPayload);
      },
    );
  });
}

function supabaseApiKey() {
  const value = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_ANON_KEY?.trim() || "";
  if (!value) {
    throw new AuthJwtError(
      "auth_unconfigured",
      "SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY is required for HS256 JWT verification",
    );
  }
  return value;
}

async function verifyWithSupabaseAuth(token: string): Promise<VerifiedAuth> {
  const response = await fetch(`${supabaseUrl()}/auth/v1/user`, {
    headers: {
      apikey: supabaseApiKey(),
      authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new AuthJwtError("invalid_token", `Supabase Auth rejected token with status ${response.status}`);
  }

  const user = (await response.json()) as SupabaseUserResponse;
  const userId = typeof user.id === "string" && user.id.trim().length > 0 ? user.id.trim() : "";
  if (!userId) {
    throw new AuthJwtError("invalid_token", "Supabase Auth user id is required");
  }

  return {
    accessToken: token,
    userId,
    email: typeof user.email === "string" ? user.email : undefined,
    role: typeof user.role === "string" ? user.role : undefined,
  };
}

export async function verifyBearerToken(token: string): Promise<VerifiedAuth> {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new AuthJwtError("auth_required", "Bearer token is required");
  }

  const decoded = jwt.decode(trimmed, { complete: true });
  const header = decoded && typeof decoded === "object" ? decoded.header : null;

  try {
    if (header?.alg === "HS256") {
      return await verifyWithSupabaseAuth(trimmed);
    }

    if (header?.alg !== "RS256") {
      throw new AuthJwtError("invalid_token", "JWT algorithm is not allowed");
    }

    const kid = typeof header?.kid === "string" ? header.kid : "";
    if (!kid) {
      throw new AuthJwtError("invalid_token", "JWT kid is required");
    }

    const issuer = `${supabaseUrl()}/auth/v1`;
    const key = await signingKeyForKid(issuer, kid);
    const payload = await verifyJwt(trimmed, key, issuer);
    const userId = typeof payload.sub === "string" && payload.sub.trim().length > 0 ? payload.sub.trim() : "";
    if (!userId) {
      throw new AuthJwtError("invalid_token", "JWT subject is required");
    }

    return {
      accessToken: trimmed,
      userId,
      email: typeof payload.email === "string" ? payload.email : undefined,
      role: typeof payload.role === "string" ? payload.role : undefined,
    };
  } catch (error) {
    if (error instanceof AuthJwtError) throw error;
    throw new AuthJwtError("invalid_token", error instanceof Error ? error.message : "JWT verification failed");
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const accessToken = requestAccessToken(req);
  if (!accessToken) {
    return res.status(401).json(errorPayload("auth_required", "Supabase access token is required"));
  }

  let auth: VerifiedAuth;
  try {
    auth = await verifyBearerToken(accessToken);
  } catch (error) {
    const code = error instanceof AuthJwtError ? error.code : "invalid_token";
    const message = code === "auth_unconfigured" ? "Authentication is not configured" : "Invalid Supabase access token";
    logEvent({
      event: "auth_token_rejected",
      level: "warn",
      error_code: code,
    });
    return res.status(401).json(errorPayload(code, message));
  }

  // The JWT's `sub` is `auth.users.id` — the SUPABASE-AUTH identity.
  // Every workspace/agent/credential FK in `public.*` references
  // `public.user.id`, NOT `auth.users.id`. Resolve once here so route
  // handlers see the APP user id on `req.userId` and never have to
  // think about the distinction. See services/auth/app-user.ts for
  // the model-level explanation.
  let appUser: AppUserRow | null;
  try {
    appUser = await getAppUserByAuthId(accessToken, auth.userId);
  } catch (error) {
    logEvent({
      event: "app_user_lookup_failed",
      level: "error",
      auth_user_id: auth.userId,
      error: errorMessage(error),
    });
    return res.status(503).json(errorPayload("app_user_lookup_failed", "Could not resolve authenticated app user"));
  }

  if (!appUser) {
    logEvent({
      event: "app_user_not_provisioned",
      level: "error",
      auth_user_id: auth.userId,
    });
    return res
      .status(401)
      .json(
        errorPayload(
          "app_user_not_provisioned",
          "Authenticated user has no public.user row. The auth → public.user provisioning trigger may not have fired for this account.",
        ),
      );
  }

  req.auth = auth;
  req.authUserId = auth.userId;
  req.userId = appUser.id;
  req.appUser = appUser;
  logEvent({
    event: "auth_token_validated",
    auth_user_id: auth.userId,
    app_user_id: appUser.id,
    role: auth.role,
  });
  return next();
}

export function clearAuthJwtCacheForTests() {
  clients.clear();
}
