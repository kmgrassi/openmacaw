import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { FormField } from "./FormField";

type Props = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  error?: string;
};

export const Input = forwardRef<HTMLInputElement, Props>(
  ({ className, label, error, id, ...rest }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");
    return (
      <FormField label={label} htmlFor={inputId} error={error}>
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
      </FormField>
    );
  },
);
Input.displayName = "Input";
