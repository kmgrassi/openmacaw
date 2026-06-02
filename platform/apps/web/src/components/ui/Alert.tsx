import { type HTMLAttributes, type ReactNode, forwardRef } from "react";

import { cn } from "../../lib/cn";

export type AlertTone = "neutral" | "info" | "success" | "warning" | "error";

type AlertProps = HTMLAttributes<HTMLDivElement> & {
  tone?: AlertTone;
  title?: ReactNode;
  actions?: ReactNode;
  detail?: ReactNode;
  compact?: boolean;
};

const toneStyles: Record<
  AlertTone,
  {
    container: string;
    title: string;
    body: string;
    detail: string;
  }
> = {
  neutral: {
    container: "border-border bg-surface-raised text-slate-300",
    title: "text-slate-100",
    body: "text-slate-300",
    detail: "border-border bg-black/20 text-slate-300",
  },
  info: {
    container: "border-blue-600/30 bg-blue-950/25 text-blue-200",
    title: "text-blue-100",
    body: "text-blue-200/90",
    detail: "border-blue-700/40 bg-black/20 text-blue-100/90",
  },
  success: {
    container: "border-green-600/30 bg-green-900/20 text-green-300",
    title: "text-green-200",
    body: "text-green-300",
    detail: "border-green-700/40 bg-black/20 text-green-200/90",
  },
  warning: {
    container: "border-amber-800/60 bg-amber-950/30 text-amber-100",
    title: "text-amber-100",
    body: "text-amber-200/85",
    detail: "border-amber-800/40 bg-black/20 text-amber-100/90",
  },
  error: {
    container: "border-red-600/30 bg-red-900/20 text-red-300",
    title: "text-red-200",
    body: "text-red-300",
    detail: "border-red-700/40 bg-black/20 text-red-200/90",
  },
};

export const Alert = forwardRef<HTMLDivElement, AlertProps>(
  (
    {
      tone = "neutral",
      title,
      actions,
      detail,
      compact = false,
      className,
      children,
      role,
      ...rest
    },
    ref,
  ) => {
    const styles = toneStyles[tone];

    return (
      <div
        ref={ref}
        role={role ?? (tone === "error" ? "alert" : "status")}
        className={cn(
          "rounded-md border",
          compact ? "px-3 py-2 text-xs" : "px-3 py-2 text-sm",
          styles.container,
          className,
        )}
        {...rest}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            {title && (
              <div className={cn("font-medium", styles.title)}>{title}</div>
            )}
            {children && (
              <div
                className={cn(
                  title ? "mt-1" : "",
                  compact ? "text-xs leading-5" : "text-sm leading-5",
                  styles.body,
                )}
              >
                {children}
              </div>
            )}
            {detail && (
              <div
                className={cn(
                  "mt-2 break-words rounded border px-2 py-1 font-mono text-[11px]",
                  styles.detail,
                )}
              >
                {detail}
              </div>
            )}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </div>
      </div>
    );
  },
);

Alert.displayName = "Alert";
