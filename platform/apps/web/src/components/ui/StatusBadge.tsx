import { cn } from "../../lib/cn";
import {
  statusToneClass,
  statusToneForValue,
  type StatusTone,
} from "./status-tones";

type StatusBadgeProps = {
  value?: string | null;
  tone?: StatusTone;
  className?: string;
  children?: React.ReactNode;
};

export function StatusBadge({
  value,
  tone,
  className,
  children,
}: StatusBadgeProps) {
  const resolvedTone = tone ?? statusToneForValue(value);

  return (
    <span
      className={cn(
        "inline-flex rounded border px-2 py-0.5 text-xs",
        statusToneClass(resolvedTone, "pill"),
        className,
      )}
    >
      {children ?? value ?? "unknown"}
    </span>
  );
}
