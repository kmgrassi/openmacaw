import { z } from "zod";

import { ToolDefinitionSchema } from "./tool-definition.js";

export const ToolPolicyTemplateSlugSchema = z.enum([
  "planner",
  "manager",
  "coding",
  "repo_read",
  "repo_write",
  "local_model_coding",
]);

export const ToolPolicyTemplateSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid().nullable(),
  slug: ToolPolicyTemplateSlugSchema.or(z.string().trim().min(1).max(128)),
  name: z.string().trim().min(1).max(256),
  description: z.string(),
  systemManaged: z.boolean(),
  enabled: z.boolean(),
});

export const ToolPolicyTemplateToolSchema = z.object({
  templateId: z.string().uuid(),
  toolId: z.string().uuid(),
});

export const AgentToolGrantModeSchema = z.enum(["include", "exclude"]);

export const AgentToolGrantSourceSchema = z.enum([
  "template",
  "manual",
  "system",
  "migration",
]);

export const AgentToolGrantSchema = z.object({
  agentId: z.string().uuid(),
  toolId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  mode: AgentToolGrantModeSchema,
  source: AgentToolGrantSourceSchema,
  sourceToolTemplateId: z.string().uuid().nullable(),
  reason: z.string().nullable(),
  createdByUserId: z.string().uuid().nullable(),
});

export const AgentToolGrantResolvedToolSchema = z.intersection(
  z.lazy(() => ToolDefinitionSchema),
  z.object({
    enabledForAgent: z.boolean(),
    grant: AgentToolGrantSchema.nullable(),
  }),
);

export const AgentToolSettingsResponseSchema = z.object({
  templates: z.array(ToolPolicyTemplateSchema),
  templateTools: z.array(ToolPolicyTemplateToolSchema),
  availableTools: z.array(ToolDefinitionSchema),
  grants: z.array(AgentToolGrantSchema),
  resolvedTools: z.array(AgentToolGrantResolvedToolSchema),
});

export const ApplyToolPolicyTemplateRequestSchema = z.object({
  workspaceId: z.string().uuid(),
});

export const UpsertAgentToolGrantRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  mode: AgentToolGrantModeSchema,
  reason: z.string().nullable().optional(),
});

export const DeleteAgentToolGrantRequestSchema = z.object({
  workspaceId: z.string().uuid(),
});

export type ToolPolicyTemplateSlug = z.infer<
  typeof ToolPolicyTemplateSlugSchema
>;
export type ToolPolicyTemplate = z.infer<typeof ToolPolicyTemplateSchema>;
export type ToolPolicyTemplateTool = z.infer<
  typeof ToolPolicyTemplateToolSchema
>;
export type AgentToolGrantMode = z.infer<typeof AgentToolGrantModeSchema>;
export type AgentToolGrantSource = z.infer<typeof AgentToolGrantSourceSchema>;
export type AgentToolGrant = z.infer<typeof AgentToolGrantSchema>;
export type AgentToolGrantResolvedTool = z.infer<
  typeof AgentToolGrantResolvedToolSchema
>;
export type AgentToolSettingsResponse = z.infer<
  typeof AgentToolSettingsResponseSchema
>;
export type ApplyToolPolicyTemplateRequest = z.infer<
  typeof ApplyToolPolicyTemplateRequestSchema
>;
export type UpsertAgentToolGrantRequest = z.infer<
  typeof UpsertAgentToolGrantRequestSchema
>;
export type DeleteAgentToolGrantRequest = z.infer<
  typeof DeleteAgentToolGrantRequestSchema
>;
