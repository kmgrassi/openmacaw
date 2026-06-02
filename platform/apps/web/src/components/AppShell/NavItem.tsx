import { NavLink } from "react-router-dom";

import { cn } from "../../lib/cn";

type NavItemProps = {
  to: string;
  label: string;
  collapsed: boolean;
  onNavigate: () => void;
  end?: boolean;
};

export function NavItem({
  to,
  label,
  collapsed,
  onNavigate,
  end,
}: NavItemProps) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      title={label}
      className={({ isActive }) =>
        cn(
          "flex min-h-9 items-center rounded-md px-2.5 py-2 text-sm transition-colors",
          collapsed ? "justify-center" : "justify-between gap-3",
          isActive
            ? "bg-surface-raised text-slate-100"
            : "text-slate-400 hover:bg-surface-raised hover:text-slate-200",
        )
      }
    >
      <span className={cn("truncate", collapsed && "sr-only")}>{label}</span>
      {collapsed && <span aria-hidden>{label.slice(0, 1)}</span>}
    </NavLink>
  );
}
