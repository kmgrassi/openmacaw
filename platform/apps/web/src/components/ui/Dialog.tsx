import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type DialogSize = "sm" | "md" | "lg" | "xl";
type SheetSide = "right" | "left";

const dialogSizeStyles: Record<DialogSize, string> = {
  sm: "sm:max-w-md",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
  xl: "sm:max-w-4xl",
};

const sheetSideStyles: Record<SheetSide, string> = {
  right: "right-0 border-l",
  left: "left-0 border-r",
};

type OverlayRootProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
};

function OverlayRoot({ open, onOpenChange, children }: OverlayRootProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </RadixDialog.Root>
  );
}

function OverlayPortal({ children }: { children: ReactNode }) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/65" />
      {children}
    </RadixDialog.Portal>
  );
}

type AppDialogProps = OverlayRootProps & {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  size?: DialogSize;
  className?: string;
};

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  size = "md",
  className,
}: AppDialogProps) {
  return (
    <OverlayRoot open={open} onOpenChange={onOpenChange}>
      <OverlayPortal>
        <RadixDialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 grid max-h-[min(90vh,42rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-6 shadow-xl focus-visible:outline-none",
            dialogSizeStyles[size],
            className,
          )}
        >
          <DialogHeader title={title} description={description} />
          {children}
        </RadixDialog.Content>
      </OverlayPortal>
    </OverlayRoot>
  );
}

type DrawerProps = OverlayRootProps & {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  side?: SheetSide;
  className?: string;
};

export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  side = "right",
  className,
}: DrawerProps) {
  return (
    <OverlayRoot open={open} onOpenChange={onOpenChange}>
      <OverlayPortal>
        <RadixDialog.Content
          className={cn(
            "fixed bottom-0 top-0 z-50 flex w-full flex-col border-slate-800 bg-slate-950 shadow-xl focus-visible:outline-none sm:w-[min(28rem,92vw)]",
            sheetSideStyles[side],
            className,
          )}
        >
          <div className="border-b border-slate-800 px-4 py-4">
            <DialogHeader title={title} description={description} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        </RadixDialog.Content>
      </OverlayPortal>
    </OverlayRoot>
  );
}

function DialogHeader({
  title,
  description,
}: {
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="pr-8">
      <RadixDialog.Title className="text-lg font-semibold text-slate-100">
        {title}
      </RadixDialog.Title>
      {description && (
        <RadixDialog.Description className="mt-2 text-sm text-slate-400">
          {description}
        </RadixDialog.Description>
      )}
      <RadixDialog.Close className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-900 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
        <span aria-hidden>×</span>
        <span className="sr-only">Close</span>
      </RadixDialog.Close>
    </div>
  );
}
