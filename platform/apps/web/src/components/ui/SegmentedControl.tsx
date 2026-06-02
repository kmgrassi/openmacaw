import { type KeyboardEvent, type ReactNode } from "react";

import { cn } from "../../lib/cn";

type SegmentValue = string;
type SegmentColumns = 2 | 3 | 4;
type SegmentSurface = "default" | "raised";
type SegmentDensity = "compact" | "regular";
type SegmentTone = "primary" | "subtle";
type SegmentTextSize = "xs" | "sm";

export type SegmentedControlOption<TValue extends SegmentValue> = {
  value: TValue;
  label: ReactNode;
  disabled?: boolean;
};

type SegmentedControlProps<TValue extends SegmentValue> = {
  value: TValue;
  options: Array<SegmentedControlOption<TValue>>;
  onValueChange: (value: TValue) => void;
  label?: string;
  ariaLabel?: string;
  columns?: SegmentColumns;
  fullWidth?: boolean;
  surface?: SegmentSurface;
  density?: SegmentDensity;
  tone?: SegmentTone;
  textSize?: SegmentTextSize;
  className?: string;
  disabled?: boolean;
};

const columnStyles: Record<SegmentColumns, string> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
};

const surfaceStyles: Record<SegmentSurface, string> = {
  default: "bg-surface",
  raised: "bg-surface-raised",
};

const densityStyles: Record<SegmentDensity, string> = {
  compact: "px-3 py-1.5",
  regular: "min-h-9 px-3 py-2",
};

const textSizeStyles: Record<SegmentTextSize, string> = {
  xs: "text-xs font-medium",
  sm: "text-sm",
};

const selectedStyles: Record<SegmentTone, string> = {
  primary: "bg-blue-600 text-white",
  subtle: "bg-surface-raised text-slate-100",
};

const idleStyles: Record<SegmentTone, string> = {
  primary: "text-slate-400 hover:bg-surface-overlay hover:text-slate-200",
  subtle: "text-slate-500 hover:text-slate-200",
};

export function SegmentedControl<TValue extends SegmentValue>({
  value,
  options,
  onValueChange,
  label,
  ariaLabel,
  columns,
  fullWidth = false,
  surface = "default",
  density = "regular",
  tone = "primary",
  textSize = "sm",
  className,
  disabled = false,
}: SegmentedControlProps<TValue>) {
  const enabledOptions = options.filter((option) => !option.disabled);
  const selectValue = (nextValue: TValue) => {
    if (nextValue === value || disabled) return;
    onValueChange(nextValue);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = enabledOptions.findIndex(
      (option) => option.value === value,
    );
    if (currentIndex < 0) return;

    const moveSelection = (nextIndex: number) => {
      event.preventDefault();
      const nextOption = enabledOptions.at(nextIndex);
      if (!nextOption) return;
      selectValue(nextOption.value);
      const buttons = Array.from(
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
          "[data-segment-value]",
        ) ?? [],
      );
      buttons
        .find((button) => button.dataset.segmentValue === nextOption.value)
        ?.focus();
    };

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      moveSelection((currentIndex + 1) % enabledOptions.length);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      moveSelection(
        (currentIndex - 1 + enabledOptions.length) % enabledOptions.length,
      );
    } else if (event.key === "Home") {
      moveSelection(0);
    } else if (event.key === "End") {
      moveSelection(enabledOptions.length - 1);
    }
  };

  return (
    <div className={cn("space-y-1.5", fullWidth ? "w-full" : "inline-block")}>
      {label && (
        <div className="text-xs font-medium text-slate-400">{label}</div>
      )}
      <div
        role="radiogroup"
        aria-label={ariaLabel ?? label}
        className={cn(
          columns ? "grid" : "inline-flex",
          columns && columnStyles[columns],
          "rounded-md border border-border p-1",
          surfaceStyles[surface],
          fullWidth && "w-full",
          className,
        )}
      >
        {options.map((option) => {
          const selected = value === option.value;
          const optionDisabled = disabled || option.disabled;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={optionDisabled}
              data-segment-value={option.value}
              onClick={() => {
                if (optionDisabled) return;
                selectValue(option.value);
              }}
              onKeyDown={handleKeyDown}
              className={cn(
                "rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                densityStyles[density],
                textSizeStyles[textSize],
                selected ? selectedStyles[tone] : idleStyles[tone],
                optionDisabled &&
                  "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-slate-400",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
