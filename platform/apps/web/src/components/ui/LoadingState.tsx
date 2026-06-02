import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

type Variant = "route" | "inline";

type Props = HTMLAttributes<HTMLDivElement> & {
  label: ReactNode;
  variant?: Variant;
};

export function LoadingState({
  label,
  variant = "inline",
  className,
  ...rest
}: Props) {
  if (variant === "route") {
    return (
      <div
        className={cn("flex h-full items-center justify-center", className)}
        role="status"
        aria-live="polite"
        {...rest}
      >
        <div className="text-center">
          <div className="mb-3 text-sm text-slate-400">{label}</div>
          <div className="h-1 w-32 overflow-hidden rounded-full bg-surface-raised">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-blue-600" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn("text-sm text-slate-500", className)}
      role="status"
      aria-live="polite"
      {...rest}
    >
      {label}
    </div>
  );
}
