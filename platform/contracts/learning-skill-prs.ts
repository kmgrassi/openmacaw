import { z } from "zod";

const GitHubRepositorySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Expected owner/repository");

export const SkillCandidateSlugSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "Expected a kebab-case skill slug",
  );

export const SkillCandidatePrCreateRequestSchema = z.object({
  candidateMemoryId: z.string().uuid(),
  repository: GitHubRepositorySchema.optional(),
  slug: SkillCandidateSlugSchema.optional(),
  title: z.string().trim().min(1).max(120).optional(),
  baseBranch: z.string().trim().min(1).max(120).optional(),
});

export const SkillCandidatePrSchema = z.object({
  url: z.string().url(),
  number: z.number().int().positive(),
  repository: GitHubRepositorySchema,
  branch: z.string(),
  baseBranch: z.string(),
  skillPath: z.string(),
});

export const SkillCandidatePrCreateResponseSchema = z.object({
  candidateMemoryId: z.string().uuid(),
  sourceMemoryIds: z.array(z.string().uuid()),
  pullRequest: SkillCandidatePrSchema,
});

export type SkillCandidatePrCreateRequest = z.infer<
  typeof SkillCandidatePrCreateRequestSchema
>;
export type SkillCandidatePrCreateResponse = z.infer<
  typeof SkillCandidatePrCreateResponseSchema
>;
