import { useCallback } from "react";
import { useManagerStatusQuery } from "../../../api/query-hooks";

type UseManagerRuntimeStatusArgs = {
  workspaceId: string | null;
};

export function useManagerRuntimeStatus({
  workspaceId,
}: UseManagerRuntimeStatusArgs) {
  const statusQuery = useManagerStatusQuery(workspaceId);
  const loadStatus = useCallback(async () => {
    await statusQuery.refetch();
  }, [statusQuery]);

  return {
    status: statusQuery.data ?? null,
    statusError: statusQuery.error
      ? (statusQuery.error as Error).message
      : null,
    loadStatus,
  };
}
