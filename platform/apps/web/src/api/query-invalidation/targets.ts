import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { QueryFamilyKey, QueryInvalidationTarget } from "./types";

export const family = (key: QueryKey): QueryInvalidationTarget => ({ key });

export const exact = (key: QueryKey): QueryInvalidationTarget => ({
  key,
  exact: true,
});

export function uniqueInvalidationTargets(
  targets: readonly QueryInvalidationTarget[],
): QueryInvalidationTarget[] {
  const seen = new Set<string>();
  const deduped: QueryInvalidationTarget[] = [];
  for (const target of targets) {
    const signature = JSON.stringify([target.key, target.exact ?? false]);
    if (seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(target);
  }
  return deduped;
}

export async function invalidateQueryTargets(
  queryClient: QueryClient,
  targets: readonly QueryInvalidationTarget[],
) {
  await Promise.all(
    uniqueInvalidationTargets(targets).map((target) =>
      queryClient.invalidateQueries({
        queryKey: target.key,
        exact: target.exact,
      }),
    ),
  );
}

export function invalidateQueryFamily(
  queryClient: QueryClient,
  queryKey: QueryFamilyKey,
): Promise<void> {
  return queryClient.invalidateQueries({ queryKey });
}
