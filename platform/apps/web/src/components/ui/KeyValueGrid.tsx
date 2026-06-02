import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

type KeyValueGridProps = HTMLAttributes<HTMLDListElement> & {
  columns?: "single" | "responsive";
};

const columnStyles: Record<
  NonNullable<KeyValueGridProps["columns"]>,
  string
> = {
  single: "grid-cols-[auto_1fr]",
  responsive: "md:grid-cols-2",
};

type KeyValueItemProps = {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
};

type KeyValuePairProps = {
  label: ReactNode;
  children: ReactNode;
  labelClassName?: string;
  valueClassName?: string;
};

export function KeyValueGrid({
  className,
  columns = "single",
  children,
  ...rest
}: KeyValueGridProps) {
  return (
    <dl
      className={cn("grid gap-x-4 gap-y-2", columnStyles[columns], className)}
      {...rest}
    >
      {children}
    </dl>
  );
}

export function KeyValueItem({
  label,
  children,
  className,
  labelClassName,
  valueClassName,
}: KeyValueItemProps) {
  return (
    <div className={className}>
      <dt className={cn("text-slate-500", labelClassName)}>{label}</dt>
      <dd className={cn("mt-0.5 text-slate-300", valueClassName)}>
        {children}
      </dd>
    </div>
  );
}

export function KeyValuePair({
  label,
  children,
  labelClassName,
  valueClassName,
}: KeyValuePairProps) {
  return (
    <>
      <dt className={cn("text-slate-500", labelClassName)}>{label}</dt>
      <dd className={cn("text-slate-300", valueClassName)}>{children}</dd>
    </>
  );
}
