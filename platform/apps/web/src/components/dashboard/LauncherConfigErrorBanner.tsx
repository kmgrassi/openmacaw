import { Link } from "react-router-dom";

import type { PrepareError } from "../../api/ws-types";
import { runtimeErrorFix } from "../../lib/runtime-error-fix";
import { Button, buttonClassName } from "../ui/Button";
import { StatusBanner } from "../ui/StatusBanner";

type LauncherConfigErrorBannerProps = {
  error: PrepareError;
  onDismiss: () => void;
};

function humanCode(error: PrepareError): string {
  return error.launcherErrorCode ?? error.code;
}

export function LauncherConfigErrorBanner({
  error,
  onDismiss,
}: LauncherConfigErrorBannerProps) {
  const fix = runtimeErrorFix(error.code, error.launcherErrorCode);
  return (
    <StatusBanner
      tone="warning"
      className="border-amber-700/60 bg-amber-950/25"
      contentClassName="block"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-amber-200">
            Agent can't start: {humanCode(error)}
          </div>
          <div className="mt-1 text-sm text-amber-100/90">{error.message}</div>
          {error.resolutionHint && (
            <div className="mt-2 text-xs text-amber-200/70">
              Hint: {error.resolutionHint}
            </div>
          )}
          {error.requiredConfig && error.requiredConfig.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {error.requiredConfig.map((key) => (
                <span
                  key={key}
                  className="rounded-md border border-amber-700/40 bg-amber-900/30 px-2 py-0.5 font-mono text-[11px] text-amber-100/90"
                >
                  {key}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
          {fix && (
            <Link
              to={fix.to}
              className={buttonClassName({ variant: "primary", size: "sm" })}
            >
              {fix.label}
            </Link>
          )}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={onDismiss}
          >
            Dismiss
          </Button>
        </div>
      </div>
    </StatusBanner>
  );
}
