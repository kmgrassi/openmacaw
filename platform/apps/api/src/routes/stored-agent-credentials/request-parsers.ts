import type { Request } from "express";

import {
  SaveCredentialRequestSchema,
  UpsertAgentCredentialReferenceRequestSchema,
} from "../../../../../contracts/credentials.js";
import { ApiRouteError, requestWorkspaceId } from "../../http.js";

export function requireWorkspaceIdFromRequest(req: Request) {
  const workspaceId = requestWorkspaceId(req);
  if (!workspaceId) {
    throw new ApiRouteError(400, "invalid_request", "workspaceId is required");
  }
  return workspaceId;
}

export function requireWorkerCwd(req: Request) {
  const cwd = typeof req.body?.cwd === "string" ? req.body.cwd.trim() : "";
  if (!cwd) {
    throw new ApiRouteError(400, "invalid_request", "A worker cwd is required");
  }
  return cwd;
}

export function parseCredentialReferenceRequest(req: Request) {
  const parsed = UpsertAgentCredentialReferenceRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new ApiRouteError(400, "invalid_request", "Credential reference request is invalid");
  }
  return parsed.data;
}

export function parseSaveCredentialRequest(req: Request) {
  const parsed = SaveCredentialRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new ApiRouteError(400, "invalid_request", "workspaceId, provider, and apiKey are required");
  }
  return parsed.data;
}
