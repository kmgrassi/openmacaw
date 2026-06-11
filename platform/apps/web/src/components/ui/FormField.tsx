import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { FieldMessage } from "./FieldMessage";

type FormFieldProps = {
  label?: ReactNode;
  htmlFor?: string;
  description?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
};

export function FormField({
  label,
  htmlFor,
  description,
  error,
  className,
  children,
}: FormFieldProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {label && (
        <label
          htmlFor={htmlFor}
          className="block text-xs font-medium text-slate-400"
        >
          {label}
        </label>
      )}
      {description && <p className="text-xs text-slate-500">{description}</p>}
      {children}
      {error && <FieldMessage tone="error">{error}</FieldMessage>}
    </div>
  );
}
