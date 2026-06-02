import { z } from "zod";

const IsoDateTimeSchema = z.string().datetime({ offset: true });

const JsonLiteralSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
type JsonLiteral = z.infer<typeof JsonLiteralSchema>;
type JsonValue =
  | JsonLiteral
  | { [key: string]: JsonValue | undefined }
  | JsonValue[];
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    JsonLiteralSchema,
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const MEMORY_SCOPES = [
  "long_term",
  "daily",
  "project",
  "run_summary",
  "scratch",
] as const;

export const MemoryScopeSchema = z.enum(MEMORY_SCOPES);
export const MemoryRetrievalScopeSchema = z.enum(["workspace", "agent"]);

export const MemoryItemSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid().nullable(),
  scope: MemoryScopeSchema,
  content: z.string(),
  tags: JsonValueSchema,
  importance: z.number().int().min(1).max(10),
  eventTime: IsoDateTimeSchema,
  sourceRunId: z.string().nullable(),
  sourceTaskId: z.string().nullable(),
  sourcePath: z.string().nullable(),
  canonicalId: z.string().uuid().nullable(),
  supersedesId: z.string().uuid().nullable(),
  isDeleted: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const MemoryWriteRequestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    agentId: z.string().uuid().nullable().optional(),
    scope: MemoryScopeSchema.default("run_summary"),
    content: z.string().trim().min(1).max(4096),
    tags: JsonValueSchema.default({}),
    importance: z.number().int().min(1).max(10).default(5),
    eventTime: IsoDateTimeSchema.optional(),
    sourceRunId: z.string().trim().min(1).nullable().optional(),
    sourceTaskId: z.string().trim().min(1).nullable().optional(),
    sourcePath: z.string().trim().min(1).nullable().optional(),
    canonicalId: z.string().uuid().nullable().optional(),
    supersedesId: z.string().uuid().nullable().optional(),
    embedding: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

export const MemoryHybridSearchRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid().nullable().optional(),
  scope: MemoryScopeSchema.optional(),
  queryText: z.string().trim().min(1),
  queryEmbedding: z.string().trim().min(1).nullable().optional(),
  limit: z.number().int().positive().max(50).default(10),
});

export const MemoryHybridSearchResultSchema = MemoryItemSchema.pick({
  id: true,
  workspaceId: true,
  agentId: true,
  scope: true,
  content: true,
  tags: true,
  importance: true,
  eventTime: true,
  sourceRunId: true,
  sourceTaskId: true,
}).extend({
  score: z.number(),
});

export const MemoryHybridSearchResponseSchema = z.object({
  results: z.array(MemoryHybridSearchResultSchema),
});

export const MemoryItemListQuerySchema = z.object({
  agentId: z.string().uuid().nullable().optional(),
  scope: MemoryScopeSchema.optional(),
  importanceMin: z.coerce.number().int().min(1).max(10).optional(),
  sourceRunId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const MemoryItemListResponseSchema = z.object({
  memoryItems: z.array(MemoryItemSchema),
});

export const MemoryWriteResponseSchema = z.object({
  memoryItem: MemoryItemSchema,
});

export type MemoryScope = z.infer<typeof MemoryScopeSchema>;
export type MemoryRetrievalScope = z.infer<typeof MemoryRetrievalScopeSchema>;
export type MemoryItem = z.infer<typeof MemoryItemSchema>;
export type MemoryWriteRequest = z.input<typeof MemoryWriteRequestSchema>;
export type MemoryWriteResponse = z.infer<typeof MemoryWriteResponseSchema>;
export type MemoryHybridSearchRequest = z.input<
  typeof MemoryHybridSearchRequestSchema
>;
export type MemoryHybridSearchResult = z.infer<
  typeof MemoryHybridSearchResultSchema
>;
export type MemoryHybridSearchResponse = z.infer<
  typeof MemoryHybridSearchResponseSchema
>;
export type MemoryItemListQuery = z.infer<typeof MemoryItemListQuerySchema>;
export type MemoryItemListResponse = z.infer<
  typeof MemoryItemListResponseSchema
>;
