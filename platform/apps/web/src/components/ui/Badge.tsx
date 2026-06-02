import { cn } from "../../lib/cn";

type Variant = "default" | "success" | "warning" | "error";

const variantStyles: Record<Variant, string> = {
  default: "bg-slate-700/50 text-slate-300",
  success: "bg-green-900/40 text-green-400",
  warning: "bg-yellow-900/40 text-yellow-400",
  error: "bg-red-900/40 text-red-400",
};

type Props = {
  variant?: Variant;
  className?: string;
  children: React.ReactNode;
};

export function Badge({ variant = "default", className, children }: Props) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        variantStyles[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
