import { useState } from "react";

import type { ProviderCutover } from "../../api/provider-cutovers";
import { useWorkItemCutoversQuery } from "../../api/query-hooks";
import { cn } from "../../lib/cn";
import { Badge } from "../ui/Badge";
import { Drawer } from "../ui/Dialog";
import { buildCutoverBadgeView } from "./fallback-badge-view";

type Props = {
  workItemId: string;
  cutovers: readonly ProviderCutover[];
  className?: string;
};

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function WorkItemFallbackBadge({
  workItemId,
  cutovers,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const query = useWorkItemCutoversQuery(workItemId, { enabled: open });
  const view = buildCutoverBadgeView(
    query.data && query.data.length > 0 ? query.data : cutovers,
  );

  if (!view) return null;

  return (
    <Drawer
      open={open}
      onOpenChange={setOpen}
      title={view.title}
      description={view.description}
      trigger={
        <button
          type="button"
          title={view.description}
          className={cn(
            "inline-flex max-w-full rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
            className,
          )}
        >
          <Badge variant="warning">{view.label}</Badge>
        </button>
      }
      closeLabel="Close cutover details"
    >
      <div className="space-y-3">
        {view.details.map((detail) => (
          <div
            key={detail.id}
            className="rounded-md border border-border bg-surface/60 p-3"
          >
            <div className="text-sm font-medium text-slate-100">
              {detail.transition}
            </div>
            <dl className="mt-3 grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 text-xs">
              <dt className="text-slate-500">Trigger</dt>
              <dd className="min-w-0 break-words text-slate-300">
                {detail.trigger}
              </dd>
              <dt className="text-slate-500">Outcome</dt>
              <dd className="min-w-0 text-slate-300">{detail.outcome}</dd>
              <dt className="text-slate-500">Elapsed</dt>
              <dd className="min-w-0 text-slate-300">{detail.elapsed}</dd>
              <dt className="text-slate-500">Triggered</dt>
              <dd className="min-w-0 text-slate-300">
                {formatDate(detail.triggeredAt)}
              </dd>
            </dl>
          </div>
        ))}
      </div>
    </Drawer>
  );
}
