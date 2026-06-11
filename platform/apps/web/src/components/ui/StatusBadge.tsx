import { Badge } from "./Badge";
import type { StatusTone } from "./status-tones";

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
  return (
    <Badge value={value} tone={tone} className={className}>
      {children}
    </Badge>
  );
}
