import type { Express } from "express";

import { MemoryWriteRequestSchema, MemoryWriteResponseSchema } from "../../../../contracts/memory-items.js";
import { apiRoute } from "../http.js";
import { logEvent } from "../logger.js";
import { insertMemoryItem } from "../repositories/memory-items.js";
import { requireServiceRoleBearer } from "../services/service-role-auth.js";

export function registerMemoryRoutes(app: Express) {
  app.post(
    "/api/memory/items",
    apiRoute({
      bodySchema: MemoryWriteRequestSchema,
      invalidBodyMessage: "Invalid memory write request",
      async handler({ req, res, body }) {
        requireServiceRoleBearer(req);
        const memoryItem = await insertMemoryItem(body);
        logEvent({
          event: "memory_item_written",
          workspace_id: memoryItem.workspaceId,
          agent_id: memoryItem.agentId,
          memory_id: memoryItem.id,
          scope: memoryItem.scope,
          importance: memoryItem.importance,
          source_run_id: memoryItem.sourceRunId,
          source_task_id: memoryItem.sourceTaskId,
          byte_count: Buffer.byteLength(memoryItem.content, "utf8"),
        });
        return res.status(201).json(MemoryWriteResponseSchema.parse({ memoryItem }));
      },
    }),
  );
}
