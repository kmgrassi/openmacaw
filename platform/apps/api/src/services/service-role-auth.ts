import type { Request } from "express";

import { ApiRouteError, requestAccessToken } from "../http.js";

export function requireServiceRoleBearer(req: Request): string {
  const accessToken = requestAccessToken(req);
  if (!accessToken) {
    throw new ApiRouteError(401, "auth_required", "Service-role bearer token is required");
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!serviceRoleKey) {
    throw new ApiRouteError(503, "service_role_unconfigured", "Service-role authentication is not configured");
  }

  if (accessToken !== serviceRoleKey) {
    throw new ApiRouteError(403, "service_role_forbidden", "Service-role bearer token is required");
  }

  return accessToken;
}
