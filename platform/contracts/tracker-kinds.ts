import { z } from "zod";

/**
 * Valid tracker_kind values for workspace_settings.tracker_kind.
 *
 * This list must stay aligned with the harper-server
 * workspace_settings.tracker_kind CHECK constraint and the runtime tracker
 * adapter allowlist. scripts/check-cross-repo-enums.mjs enforces that drift
 * check.
 */
export const TRACKER_KINDS = [
  "memory",
  "database",
  "github",
  "api",
  "linear",
] as const;

export type TrackerKind = (typeof TRACKER_KINDS)[number];
export const TrackerKindSchema = z.enum(TRACKER_KINDS);

export const TRACKER_KIND_DESCRIPTIONS = {
  memory: "In-memory, for development",
  database: "Supabase-backed canonical store",
  github: "Repository issues",
  api: "External push",
  linear: "Linear workspace",
} as const satisfies Record<TrackerKind, string>;

export function trackerKindRequiresCredential(kind: TrackerKind) {
  return kind === "linear" || kind === "github";
}

export function trackerCredentialProvider(kind: TrackerKind) {
  return trackerKindRequiresCredential(kind) ? kind : null;
}
