import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

type Density = "compact" | "default";
type Align = "left" | "center";

const densityStyles: Record<Density, string> = {
  compact: "px-3 py-4",
  default: "px-4 py-8",
};

const alignStyles: Record<Align, string> = {
  left: "text-left",
  center: "text-center",
};

type Props = HTMLAttributes<HTMLDivElement> & {
  label: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  density?: Density;
  align?: Align;
};

export function EmptyState({
  label,
  description,
  action,
  density = "default",
  align = "center",
  className,
  ...rest
}: Props) {
  return (
    <div
      className={cn(
        "rounded-md border border-dashed border-border bg-surface/40 text-sm text-slate-500",
        densityStyles[density],
        alignStyles[align],
        className,
      )}
      {...rest}
    >
      <div>{label}</div>
      {description && (
        <div className="mt-1 text-xs text-slate-600">{description}</div>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
