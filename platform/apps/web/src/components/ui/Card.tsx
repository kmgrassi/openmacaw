import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type CardPadding = "none" | "sm" | "md";
type CardTone = "default" | "raised" | "info";

const paddingStyles: Record<CardPadding, string> = {
  none: "p-0",
  sm: "p-3",
  md: "p-4",
};

const toneStyles: Record<CardTone, string> = {
  default: "border-border bg-surface-raised",
  raised: "border-slate-800 bg-slate-900/70 shadow-xl",
  info: "border-blue-500/30 bg-blue-500/10",
};

type Props = HTMLAttributes<HTMLDivElement> & {
  padding?: CardPadding;
  tone?: CardTone;
};

export function Card({
  className,
  children,
  padding = "md",
  tone = "default",
  ...rest
}: Props) {
  return (
    <div
      className={cn(
        "rounded-lg border",
        toneStyles[tone],
        paddingStyles[padding],
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
