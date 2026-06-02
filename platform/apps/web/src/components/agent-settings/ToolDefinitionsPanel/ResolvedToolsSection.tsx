import type { ToolDefinition } from "../../../hooks/useToolDefinitions";
import { EmptyState } from "../../ui/EmptyState";
import { ChipGroup } from "./ChipGroup";
import { ToolRow } from "./ToolRow";

type ResolvedToolsSectionProps = {
  draftTools: ToolDefinition[];
  addedTools: ToolDefinition[];
  excludedTools: ToolDefinition[];
  excludedGrantTools: ToolDefinition[];
  saving: boolean;
  sourceForTool: (toolId: string) => string;
  onPreview: (toolId: string) => void;
  onAddTool: (toolId: string) => void;
  onRemoveTool: (toolId: string) => void;
  onRemoveGrant: (toolId: string) => void;
};

export function ResolvedToolsSection({
  draftTools,
  addedTools,
  excludedTools,
  excludedGrantTools,
  saving,
  sourceForTool,
  onPreview,
  onAddTool,
  onRemoveTool,
  onRemoveGrant,
}: ResolvedToolsSectionProps) {
  return (
    <div className="space-y-4">
      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h4 className="text-sm font-medium text-slate-300">Resolved tools</h4>
          <span className="text-xs text-slate-500">
            {draftTools.length} active
          </span>
        </div>
        <div className="space-y-2">
          {draftTools.length === 0 ? (
            <EmptyState label="No tools are assigned to this agent." />
          ) : (
            draftTools.map((tool) => (
              <ToolRow
                key={tool.id}
                tool={tool}
                source={sourceForTool(tool.id)}
                actionLabel="Exclude"
                disabled={saving}
                onPreview={() => onPreview(tool.id)}
                onAction={() => onRemoveTool(tool.id)}
              />
            ))
          )}
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        <ChipGroup
          title="Added tools"
          emptyLabel="No added tools staged."
          tools={addedTools}
          actionLabel="Remove"
          onAction={onRemoveTool}
        />
        <ChipGroup
          title="Staged excludes"
          emptyLabel="No excludes staged."
          tools={excludedTools}
          actionLabel="Restore"
          onAction={onAddTool}
        />
        <ChipGroup
          title="Current exclude grants"
          emptyLabel="No exclude grants."
          tools={excludedGrantTools}
          actionLabel="Remove grant"
          onAction={onRemoveGrant}
        />
      </section>
    </div>
  );
}
