import type { ToolDefinition } from "../../../hooks/useToolDefinitions";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";

type ToolRowProps = {
  tool: ToolDefinition;
  source: string;
  actionLabel: string;
  disabled?: boolean;
  onPreview: () => void;
  onAction: () => void;
};

export function ToolRow({
  tool,
  source,
  actionLabel,
  disabled,
  onPreview,
  onAction,
}: ToolRowProps) {
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h5 className="text-sm font-medium text-slate-200">{tool.name}</h5>
            <Badge>{source}</Badge>
            {tool.executionKind && <Badge>{tool.executionKind}</Badge>}
            {tool.runnerKind && <Badge>{tool.runnerKind}</Badge>}
            {!tool.enabled && <Badge variant="warning">disabled</Badge>}
          </div>
          <p className="mt-1 break-all font-mono text-xs text-slate-500">
            {tool.slug}
          </p>
          {tool.description && (
            <p className="mt-2 line-clamp-2 text-sm text-slate-400">
              {tool.description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onPreview}
          >
            Schema
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={onAction}
          >
            {actionLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
