import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { FieldMessage } from "./FieldMessage";

type Props = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  error?: string;
};

export const Input = forwardRef<HTMLInputElement, Props>(
  ({ className, label, error, id, ...rest }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");
    return (
      <div className="space-y-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="block text-xs font-medium text-slate-400"
          >
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            "w-full rounded-md border bg-surface-raised px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500",
            error ? "border-red-500" : "border-border",
            className,
          )}
          {...rest}
        />
        {error && <FieldMessage tone="error">{error}</FieldMessage>}
      </div>
    );
  },
);
Input.displayName = "Input";
