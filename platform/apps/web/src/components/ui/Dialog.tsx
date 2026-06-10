import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn";
import { IconButton } from "./IconButton";

type DialogSize = "sm" | "md" | "lg" | "xl";

const sizeClassNames: Record<DialogSize, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-5xl",
};

type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  trigger?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: DialogSize;
  className?: string;
  bodyClassName?: string;
  closeLabel?: string;
};

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  trigger,
  children,
  footer,
  size = "md",
  className,
  bodyClassName,
  closeLabel = "Close dialog",
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/65" />
        <RadixDialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[min(92vh,46rem)]",
            "w-[calc(100vw-1rem)] -translate-x-1/2 -translate-y-1/2 flex-col",
            "overflow-hidden rounded-lg border border-border bg-surface-raised",
            "shadow-2xl focus-visible:outline-none sm:w-[min(92vw,64rem)]",
            sizeClassNames[size],
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <RadixDialog.Title className="text-sm font-semibold text-slate-100">
                {title}
              </RadixDialog.Title>
              {description && (
                <RadixDialog.Description className="mt-1 text-sm text-slate-400">
                  {description}
                </RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close asChild>
              <IconButton
                size="sm"
                className="text-slate-400 hover:bg-surface-overlay"
                aria-label={closeLabel}
              >
                &times;
              </IconButton>
            </RadixDialog.Close>
          </div>
          <div
            className={cn("min-h-0 flex-1 overflow-y-auto p-4", bodyClassName)}
          >
            {children}
          </div>
          {footer && (
            <div className="flex items-center justify-end gap-3 border-t border-border px-4 py-3">
              {footer}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;
