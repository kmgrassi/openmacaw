import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../../lib/cn";

type StatusBannerTone = "neutral" | "info" | "success" | "warning" | "error";
type StatusBannerPlacement = "inline" | "top" | "bottom";
type StatusBannerDensity = "compact" | "default";

const inlineToneStyles: Record<StatusBannerTone, string> = {
  neutral: "border-border bg-surface-raised text-slate-200",
  info: "border-blue-500/30 bg-blue-950/25 text-blue-100",
  success: "border-emerald-500/30 bg-emerald-950/25 text-emerald-100",
  warning: "border-amber-500/30 bg-amber-950/20 text-amber-50",
  error: "border-red-900/50 bg-red-950/25 text-red-300",
};

const edgeToneStyles: Record<StatusBannerTone, string> = {
  neutral: "border-border bg-surface/90 text-slate-300",
  info: "border-blue-900/40 bg-blue-950/90 text-blue-300",
  success: "border-emerald-900/40 bg-emerald-950/90 text-emerald-300",
  warning: "border-amber-900/40 bg-amber-950/90 text-amber-300",
  error: "border-red-900/40 bg-red-950/90 text-red-300",
};

const titleToneStyles: Record<StatusBannerTone, string> = {
  neutral: "text-slate-100",
  info: "text-blue-100",
  success: "text-emerald-100",
  warning: "text-amber-100",
  error: "text-red-200",
};

const paddingStyles: Record<StatusBannerDensity, string> = {
  compact: "px-3 py-2",
  default: "px-4 py-3",
};

type StatusBannerProps = HTMLAttributes<HTMLElement> & {
  tone?: StatusBannerTone;
  placement?: StatusBannerPlacement;
  density?: StatusBannerDensity;
  title?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  contentClassName?: string;
  titleClassName?: string;
  actionsClassName?: string;
  backdrop?: boolean;
};

export function StatusBanner({
  tone = "neutral",
  placement = "inline",
  density = "default",
  title,
  actions,
  children,
  className,
  contentClassName,
  titleClassName,
  actionsClassName,
  backdrop,
  role,
  ...rest
}: StatusBannerProps) {
  const edgePlacement = placement !== "inline";

  return (
    <section
      role={role ?? (tone === "error" ? "alert" : "status")}
      className={cn(
        "text-sm",
        edgePlacement
          ? cn(
              placement === "top" ? "border-b" : "border-t",
              edgeToneStyles[tone],
              backdrop && "backdrop-blur",
            )
          : cn("rounded-md border", inlineToneStyles[tone]),
        paddingStyles[density],
        className,
      )}
      {...rest}
    >
      <div
        className={cn(
          "flex flex-col gap-3 md:flex-row md:items-start md:justify-between",
          contentClassName,
        )}
      >
        <div className="min-w-0">
          {title && (
            <h2
              className={cn(
                "text-sm font-semibold",
                titleToneStyles[tone],
                titleClassName,
              )}
            >
              {title}
            </h2>
          )}
          {children}
        </div>
        {actions && (
          <div
            className={cn("flex shrink-0 items-center gap-2", actionsClassName)}
          >
            {actions}
          </div>
        )}
      </div>
    </section>
  );
}
