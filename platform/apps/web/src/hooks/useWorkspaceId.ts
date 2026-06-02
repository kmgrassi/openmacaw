import { useAuthStore } from "../stores/auth";

/**
 * Returns the current workspace ID or throws if not available.
 * Use in components that make workspace-scoped API calls.
 */
export function useRequiredWorkspaceId(): string {
  const workspaceId = useAuthStore((s) => s.workspaceId);
  if (!workspaceId) throw new Error("No workspace ID available");
  return workspaceId;
}
