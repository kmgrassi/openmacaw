import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  containerClassName?: string;
  description?: ReactNode;
  label?: ReactNode;
  labelClassName?: string;
};

export const Checkbox = forwardRef<HTMLInputElement, Props>(
  (
    {
      className,
      containerClassName,
      description,
      label,
      labelClassName,
      ...rest
    },
    ref,
  ) => {
    return (
      <label
        className={cn(
          "inline-flex items-center gap-2 text-sm text-slate-300",
          containerClassName,
        )}
      >
        <input
          ref={ref}
          type="checkbox"
          className={cn(
            "h-4 w-4 rounded border-border bg-surface-raised text-blue-600 focus:ring-blue-500 disabled:opacity-50",
            className,
          )}
          {...rest}
        />
        {(label || description) && (
          <span className={cn("min-w-0", labelClassName)}>
            {label && <span className="block">{label}</span>}
            {description && (
              <span className="block text-xs text-slate-500">
                {description}
              </span>
            )}
          </span>
        )}
      </label>
    );
  },
);
Checkbox.displayName = "Checkbox";
