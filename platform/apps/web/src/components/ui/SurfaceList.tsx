import type { HTMLAttributes, LabelHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type SurfaceListProps = HTMLAttributes<HTMLDivElement> & {
  gap?: "sm" | "md";
};

const gapStyles: Record<NonNullable<SurfaceListProps["gap"]>, string> = {
  sm: "space-y-2",
  md: "space-y-3",
};

type SurfaceItemProps = HTMLAttributes<HTMLDivElement> & {
  density?: "compact" | "default";
  muted?: boolean;
};

type SurfaceLabelProps = LabelHTMLAttributes<HTMLLabelElement> & {
  density?: "compact" | "default";
  muted?: boolean;
};

const densityStyles: Record<
  NonNullable<SurfaceItemProps["density"]>,
  string
> = {
  compact: "px-3 py-2",
  default: "px-3 py-3",
};

function surfaceClassName({
  className,
  density = "default",
  muted = false,
}: {
  className?: string;
  density?: SurfaceItemProps["density"];
  muted?: boolean;
}) {
  return cn(
    "rounded-md border bg-surface",
    muted ? "border-white/5" : "border-border",
    densityStyles[density],
    className,
  );
}

export function SurfaceList({
  className,
  gap = "sm",
  children,
  ...rest
}: SurfaceListProps) {
  return (
    <div className={cn(gapStyles[gap], className)} {...rest}>
      {children}
    </div>
  );
}

export function SurfaceListItem({
  className,
  density,
  muted,
  children,
  ...rest
}: SurfaceItemProps) {
  return (
    <div className={surfaceClassName({ className, density, muted })} {...rest}>
      {children}
    </div>
  );
}

export function SurfaceLabel({
  className,
  density,
  muted,
  children,
  ...rest
}: SurfaceLabelProps) {
  return (
    <label
      className={surfaceClassName({
        className: cn("cursor-pointer", className),
        density,
        muted,
      })}
      {...rest}
    >
      {children}
    </label>
  );
}
