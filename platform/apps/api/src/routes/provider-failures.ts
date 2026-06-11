import type { Express } from "express";
import { z } from "zod";

import {
  ProviderFailureRecentResponseSchema,
  ProviderFailureSummaryResponseSchema,
} from "../../../../contracts/provider-failures.js";
import { ApiRouteError, apiRoute, requireRouteParam } from "../http.js";
import { listRecentProviderFailures, summarizeProviderFailures } from "../repositories/provider-failures.js";
import { assertWorkspaceMembership } from "../services/work-item-ingest.js";

const RecentQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  cursor: z.string().optional(),
});

const SummaryQuerySchema = z.object({
  since: z.string().datetime(),
});

function parseRecentQuery(query: Record<string, unknown>) {
  const parsed = RecentQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ApiRouteError(400, "invalid_request", "limit and cursor are invalid", parsed.error.flatten());
  }
  return parsed.data;
}

function parseSummaryQuery(query: Record<string, unknown>) {
  const parsed = SummaryQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ApiRouteError(400, "invalid_request", "since must be an ISO timestamp", parsed.error.flatten());
  }
  return parsed.data;
}

export function registerProviderFailureRoutes(app: Express) {
  app.get(
    "/api/workspaces/:workspaceId/provider-failures/recent",
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = requireRouteParam(req, "workspaceId");
        await assertWorkspaceMembership(userId, workspaceId);
        const query = parseRecentQuery(req.query);
        const response = await listRecentProviderFailures({
          workspaceId,
          limit: query.limit,
          cursor: query.cursor,
        });

        return res.status(200).json(ProviderFailureRecentResponseSchema.parse(response));
      },
    }),
  );

  app.get(
    "/api/workspaces/:workspaceId/provider-failures/summary",
    apiRoute({
      requireAuth: true,
      async handler({ req, res, userId }) {
        const workspaceId = requireRouteParam(req, "workspaceId");
        await assertWorkspaceMembership(userId, workspaceId);
        const query = parseSummaryQuery(req.query);
        const items = await summarizeProviderFailures({
          workspaceId,
          since: query.since,
        });

        return res.status(200).json(ProviderFailureSummaryResponseSchema.parse({ since: query.since, items }));
      },
    }),
  );
}
