import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/Button";
import { PageHeader } from "../ui/PageHeader";

type DashboardHeaderProps = {
  agentName: string | null | undefined;
  codeAccess?: {
    type: "repository" | "workspace";
    label: string;
    value: string;
  } | null;
  debugMode: boolean;
  focusMode: boolean;
  detailsContent?: ReactNode;
  onToggleDebugMode: () => void;
  onToggleFocusMode: () => void;
  onEditSetup: () => void;
};

export function DashboardHeader({
  agentName,
  codeAccess,
  debugMode,
  focusMode,
  detailsContent,
  onToggleDebugMode,
  onToggleFocusMode,
  onEditSetup,
}: DashboardHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [menuOpen]);

  return (
    <PageHeader
      eyebrow="Runtime dashboard"
      title={agentName ?? "Agent dashboard"}
      variant="dashboard"
      metadata={
        codeAccess ? (
          <div
            className="inline-flex max-w-full items-center gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-2.5 py-1 text-xs text-slate-300"
            title={codeAccess.value}
          >
            <span className="shrink-0 uppercase tracking-[0.14em] text-slate-500">
              Coding access
            </span>
            <span className="min-w-0 truncate font-medium text-slate-200">
              {codeAccess.type === "repository" ? "Repository" : "Workspace"}:{" "}
              {codeAccess.label}
            </span>
          </div>
        ) : null
      }
      className="sm:items-center"
      actionsClassName="flex-nowrap"
      actions={
        <>
          <Button
            variant="ghost"
            className="border border-slate-800 bg-slate-900/60 text-slate-200 hover:border-slate-700"
            onClick={onEditSetup}
          >
            Agent settings
          </Button>
          <div className="relative" ref={menuRef}>
            <Button
              variant="ghost"
              className="border border-slate-800 bg-slate-900/60 text-slate-300 hover:border-slate-700"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-haspopup="dialog"
            >
              View details
              <span className="ml-2 text-slate-500" aria-hidden>
                v
              </span>
            </Button>
            {menuOpen && (
              <div
                className="absolute right-0 z-20 mt-2 max-h-[min(78vh,44rem)] w-[min(92vw,64rem)] overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/95 p-2 shadow-xl"
                role="dialog"
                aria-label="Dashboard details"
              >
                <div className="grid gap-1 sm:grid-cols-2">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-900"
                    onClick={onToggleDebugMode}
                  >
                    <span>Debug mode</span>
                    <span
                      className={debugMode ? "text-blue-300" : "text-slate-500"}
                    >
                      {debugMode ? "On" : "Off"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-900"
                    onClick={onToggleFocusMode}
                  >
                    <span>Focus mode</span>
                    <span
                      className={focusMode ? "text-blue-300" : "text-slate-500"}
                    >
                      {focusMode ? "On" : "Off"}
                    </span>
                  </button>
                </div>
                {detailsContent && (
                  <div className="mt-2 border-t border-slate-800/80 pt-2">
                    {detailsContent}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      }
    />
  );
}
