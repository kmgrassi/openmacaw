import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

type NavSectionProps = {
  label: string;
  collapsed: boolean;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
};

export function NavSection({
  label,
  collapsed,
  open,
  onToggle,
  action,
  children,
}: NavSectionProps) {
  return (
    <div className="space-y-1">
      <div
        className={cn(
          "flex min-h-8 items-center rounded-md",
          collapsed ? "justify-center" : "gap-1",
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            "flex min-h-8 min-w-0 flex-1 items-center rounded-md px-2 text-xs font-medium uppercase tracking-wide text-slate-500 hover:bg-surface-raised hover:text-slate-300",
            collapsed ? "justify-center" : "justify-between",
          )}
          aria-expanded={open}
        >
          <span className={cn(collapsed && "sr-only")}>{label}</span>
          {collapsed ? (
            <span aria-hidden>{label.slice(0, 1)}</span>
          ) : (
            <span aria-hidden>{open ? "-" : "+"}</span>
          )}
        </button>
        {!collapsed && action}
      </div>
      {open && <div className="space-y-0.5">{children}</div>}
    </div>
  );
}
