import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Props = HTMLAttributes<HTMLDivElement>;

export function Card({ className, children, ...rest }: Props) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-surface-raised p-4", className)}
      {...rest}
    >
      {children}
    </div>
  );
}
