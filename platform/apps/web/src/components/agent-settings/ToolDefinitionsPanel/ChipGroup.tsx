import type { ToolDefinition } from "../../../hooks/useToolDefinitions";
import { SurfaceListItem } from "../../ui/SurfaceList";

type ChipGroupProps = {
  title: string;
  emptyLabel: string;
  tools: ToolDefinition[];
  actionLabel: string;
  onAction: (toolId: string) => void;
};

export function ChipGroup({
  title,
  emptyLabel,
  tools,
  actionLabel,
  onAction,
}: ChipGroupProps) {
  return (
    <SurfaceListItem>
      <h4 className="text-sm font-medium text-slate-300">{title}</h4>
      <div className="mt-3 flex flex-wrap gap-2">
        {tools.length === 0 ? (
          <span className="text-xs text-slate-500">{emptyLabel}</span>
        ) : (
          tools.map((tool) => (
            <button
              key={tool.id}
              type="button"
              onClick={() => onAction(tool.id)}
              className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-surface-raised px-2.5 py-1 text-xs text-slate-300 hover:bg-surface-overlay"
            >
              <span className="truncate">{tool.name}</span>
              <span className="text-slate-500">{actionLabel}</span>
            </button>
          ))
        )}
      </div>
    </SurfaceListItem>
  );
}
