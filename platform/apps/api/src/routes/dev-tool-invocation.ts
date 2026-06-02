import type { Express, Request } from "express";

import {
  DevToolInvocationRequestSchema,
  DevToolInvocationResponseSchema,
} from "../../../../contracts/dev-tool-invocation.js";
import { ApiRouteError, apiRoute, handleApiRouteError, requireRouteParam } from "../http.js";
import { invokeDevTool } from "../services/dev-tool-invocation.js";

function isLocalRequest(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function assertDevOnly(req: Request) {
  if (process.env.NODE_ENV !== "development") {
    throw new ApiRouteError(404, "not_found", "Endpoint is unavailable");
  }
  if (!isLocalRequest(req)) {
    throw new ApiRouteError(403, "forbidden", "Local-only endpoint is unavailable from this address");
  }
}

function handleDevToolError(res: Parameters<typeof handleApiRouteError>[0], error: unknown) {
  return handleApiRouteError(res, error, {
    status: 502,
    code: "dev_tool_invocation_failed",
    message: "Dev tool invocation failed",
  });
}

export function registerDevToolInvocationRoutes(app: Express) {
  app.post(
    "/api/dev/tools/:toolSlug/invoke",
    apiRoute({
      requireAuth: true,
      bodySchema: DevToolInvocationRequestSchema,
      invalidBodyMessage: "dev tool invocation request is invalid",
      onError: handleDevToolError,
      async handler({ req, res, body, accessToken, userId }) {
        assertDevOnly(req);
        const result = await invokeDevTool({
          accessToken: accessToken ?? "",
          userId: userId ?? "",
          toolSlug: requireRouteParam(req, "toolSlug"),
          request: body,
        });
        return res.status(200).json(DevToolInvocationResponseSchema.parse(result));
      },
    }),
  );
}
