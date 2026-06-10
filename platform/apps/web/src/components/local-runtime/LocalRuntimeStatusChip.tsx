import { Link } from "react-router-dom";

import type { LocalRuntime } from "../../api/local-runtime";
import { cn } from "../../lib/cn";
import {
  localRuntimeBindingStatusForAgent,
  type LocalRuntimeBindingStatus,
} from "./status";

const CHIP_STYLES: Record<LocalRuntimeBindingStatus["tone"], string> = {
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  error: "border-red-500/30 bg-red-500/10 text-red-200",
  neutral: "border-slate-700 bg-slate-900 text-slate-400",
};

const DOT_STYLES: Record<LocalRuntimeBindingStatus["tone"], string> = {
  success: "bg-emerald-400",
  warning: "bg-amber-400",
  error: "bg-red-400",
  neutral: "bg-slate-500",
};

export function LocalRuntimeStatusChip({
  agentId,
  runtimes,
  className,
  showWhenUnbound = false,
  linkToSettings = true,
}: {
  agentId: string;
  runtimes: LocalRuntime[];
  className?: string;
  showWhenUnbound?: boolean;
  linkToSettings?: boolean;
}) {
  const status = localRuntimeBindingStatusForAgent(agentId, runtimes);
  if (status.kind === "none" && !showWhenUnbound) return null;

  const chip = (
    <span
      title={status.detail}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        CHIP_STYLES[status.tone],
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          DOT_STYLES[status.tone],
        )}
      />
      <span className="truncate">{status.label}</span>
    </span>
  );

  if (status.kind === "none" || !linkToSettings) return chip;

  return (
    <Link to="/settings/local-runtimes" className="inline-flex max-w-full">
      {chip}
    </Link>
  );
}
