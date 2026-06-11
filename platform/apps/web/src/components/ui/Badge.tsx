import { cn } from "../../lib/cn";
import {
  statusToneClass,
  statusToneForValue,
  type StatusTone,
} from "./status-tones";

type Variant = "default" | "success" | "warning" | "error" | "info";

const variantTones: Record<Variant, StatusTone> = {
  default: "neutral",
  success: "success",
  warning: "warning",
  error: "error",
  info: "info",
};

type Props = {
  variant?: Variant;
  value?: string | null;
  tone?: StatusTone;
  className?: string;
  children?: React.ReactNode;
};

export function Badge({
  variant = "default",
  value,
  tone,
  className,
  children,
}: Props) {
  const resolvedTone =
    tone ?? (value ? statusToneForValue(value) : variantTones[variant]);

  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium",
        statusToneClass(resolvedTone, "pill"),
        className,
      )}
    >
      {children ?? value ?? "unknown"}
    </span>
  );
}
