import { useState, type ReactNode } from "react";
import { Button } from "../ui/Button";
import { Drawer } from "../ui/Dialog";
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
  const [detailsOpen, setDetailsOpen] = useState(false);

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
          <div>
            <Button
              variant="ghost"
              className="border border-slate-800 bg-slate-900/60 text-slate-300 hover:border-slate-700"
              onClick={() => setDetailsOpen(true)}
              aria-expanded={detailsOpen}
              aria-haspopup="dialog"
            >
              View details
              <span className="ml-2 text-slate-500" aria-hidden>
                v
              </span>
            </Button>
            <Drawer
              open={detailsOpen}
              onOpenChange={setDetailsOpen}
              title="Dashboard details"
              description="Runtime display controls and live diagnostic context."
            >
              <div className="grid gap-2">
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-left text-sm text-slate-300 transition-colors hover:border-slate-700 hover:bg-slate-900"
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
                  className="flex w-full items-center justify-between rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-left text-sm text-slate-300 transition-colors hover:border-slate-700 hover:bg-slate-900"
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
                <div className="mt-4 border-t border-slate-800/80 pt-4">
                  {detailsContent}
                </div>
              )}
            </Drawer>
          </div>
        </>
      }
    />
  );
}
