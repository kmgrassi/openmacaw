import { z } from "zod";

import { SavedCredentialSchema } from "./credentials.js";

export const StartOpenAICodexOAuthRequestSchema = z.object({
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
});

export const StartOpenAICodexOAuthResponseSchema = z.object({
  sessionId: z.string().min(1),
  verificationUrl: z.string().url(),
  userCode: z.string().min(1),
  expiresInMs: z.number().int().positive(),
  intervalMs: z.number().int().positive(),
});

export const PollOpenAICodexOAuthRequestSchema = z.object({
  sessionId: z.string().min(1),
});

export const PollOpenAICodexOAuthResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("pending") }),
    z.object({
      status: z.literal("complete"),
      credential: SavedCredentialSchema,
      email: z.string().nullable(),
      accountId: z.string().nullable(),
      planType: z.string().nullable(),
    }),
    z.object({
      status: z.literal("failed"),
      error: z.string(),
    }),
    z.object({ status: z.literal("expired") }),
  ],
);

export const ImportOpenAICodexOAuthRequestSchema = z.object({
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
  accessToken: z.string().trim().min(1),
});

export const ImportOpenAICodexOAuthResponseSchema = z.object({
  credential: SavedCredentialSchema,
  email: z.string().nullable(),
  accountId: z.string().nullable(),
  planType: z.string().nullable(),
});

export type StartOpenAICodexOAuthRequest = z.infer<
  typeof StartOpenAICodexOAuthRequestSchema
>;
export type StartOpenAICodexOAuthResponse = z.infer<
  typeof StartOpenAICodexOAuthResponseSchema
>;
export type PollOpenAICodexOAuthRequest = z.infer<
  typeof PollOpenAICodexOAuthRequestSchema
>;
export type PollOpenAICodexOAuthResponse = z.infer<
  typeof PollOpenAICodexOAuthResponseSchema
>;
export type ImportOpenAICodexOAuthRequest = z.infer<
  typeof ImportOpenAICodexOAuthRequestSchema
>;
export type ImportOpenAICodexOAuthResponse = z.infer<
  typeof ImportOpenAICodexOAuthResponseSchema
>;
