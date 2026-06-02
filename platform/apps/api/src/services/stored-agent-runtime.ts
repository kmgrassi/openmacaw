import { ApiRouteError } from "../http.js";
import type { resolveExecutionProfile } from "./execution-profile-resolver.js";

export function blockingProfileMissing(missing: string[]) {
  return missing.filter((requirement) => requirement !== "credential");
}

export function requireCodexProfile(resolution: Awaited<ReturnType<typeof resolveExecutionProfile>>) {
  const blockingMissing = blockingProfileMissing(resolution.missing);
  if (!resolution.profile || blockingMissing.length > 0) {
    throw new ApiRouteError(422, "agent_runtime_unconfigured", "Agent runtime is not fully configured", {
      missing: resolution.missing,
      execution_profile: resolution,
    });
  }
  if (resolution.profile.runnerKind !== "codex") {
    throw new ApiRouteError(422, "runner_unsupported", "Stored agent launch currently supports only Codex runners", {
      runner_kind: resolution.profile.runnerKind,
      execution_profile: resolution,
    });
  }
  return resolution.profile;
}
