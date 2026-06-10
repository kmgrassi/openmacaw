import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { FormField } from "./FormField";

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  error?: string;
  label?: string;
  wrapperClassName?: string;
};

export const Textarea = forwardRef<HTMLTextAreaElement, Props>(
  ({ className, error, id, label, wrapperClassName, ...rest }, ref) => {
    const textareaId = id || label?.toLowerCase().replace(/\s+/g, "-");

    return (
      <FormField
        label={label}
        htmlFor={textareaId}
        error={error}
        className={wrapperClassName}
      >
        <textarea
          ref={ref}
          id={textareaId}
          className={cn(
            "w-full rounded-md border bg-surface-raised px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50",
            error ? "border-red-500" : "border-border",
            className,
          )}
          {...rest}
        />
      </FormField>
    );
  },
);
Textarea.displayName = "Textarea";
