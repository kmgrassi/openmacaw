import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";

type FieldMessageTone = "error" | "success" | "warning" | "neutral";

const toneClasses: Record<FieldMessageTone, string> = {
  error: "text-red-400",
  success: "text-green-400",
  warning: "text-amber-400",
  neutral: "text-slate-500",
};

type Props = HTMLAttributes<HTMLParagraphElement> & {
  children: ReactNode;
  tone?: FieldMessageTone;
};

export function FieldMessage({
  children,
  className,
  tone = "neutral",
  ...rest
}: Props) {
  return (
    <p className={cn("text-xs", toneClasses[tone], className)} {...rest}>
      {children}
    </p>
  );
}
