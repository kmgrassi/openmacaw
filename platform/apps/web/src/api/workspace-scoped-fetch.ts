import { brokerFetch } from "./broker-fetch";

/**
 * Fetch wrapper that requires a non-null workspaceId and appends it as
 * a query parameter. Use this for all API calls that need workspace scope.
 */
export function workspaceScopedFetch(
  workspaceId: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const separator = path.includes("?") ? "&" : "?";
  return brokerFetch(`${path}${separator}workspaceId=${encodeURIComponent(workspaceId)}`, init);
}
