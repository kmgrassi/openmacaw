import type { ToolDefinition } from "../../../hooks/useToolDefinitions";
import { EmptyState } from "../../ui/EmptyState";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { TOOL_BUNDLES } from "./utils";
import { ToolRow } from "./ToolRow";

type ToolCatalogProps = {
  tools: ToolDefinition[];
  search: string;
  bundleFilter: string;
  saving: boolean;
  localExecutionLoading: boolean;
  setSearch: (value: string) => void;
  setBundleFilter: (value: string) => void;
  isLocalCodingToolBlocked: (toolId: string) => boolean;
  onPreview: (toolId: string) => void;
  onAddTool: (toolId: string) => void;
};

export function ToolCatalog({
  tools,
  search,
  bundleFilter,
  saving,
  localExecutionLoading,
  setSearch,
  setBundleFilter,
  isLocalCodingToolBlocked,
  onPreview,
  onAddTool,
}: ToolCatalogProps) {
  return (
    <section className="space-y-3">
      <div>
        <h4 className="text-sm font-medium text-slate-300">Tool catalog</h4>
        <p className="mt-1 text-xs text-slate-500">
          Search tools, inspect schemas, and add them to this agent.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_170px]">
        <Input
          label="Search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Tool name, slug, or description"
        />
        <Select
          label="Template"
          value={bundleFilter}
          onChange={(event) => setBundleFilter(event.target.value)}
          options={[
            { value: "", label: "All templates" },
            ...TOOL_BUNDLES.map((bundle) => ({
              value: bundle.id,
              label: bundle.label,
            })),
          ]}
        />
      </div>
      <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1 chat-scrollbar">
        {tools.length === 0 ? (
          <EmptyState label="No matching catalog tools." />
        ) : (
          tools.map((tool) => {
            const isBlocked = isLocalCodingToolBlocked(tool.id);

            return (
              <ToolRow
                key={tool.id}
                tool={tool}
                source="catalog"
                actionLabel={isBlocked ? "Requires helper" : "Add"}
                disabled={
                  saving || localExecutionLoading || !tool.enabled || isBlocked
                }
                onPreview={() => onPreview(tool.id)}
                onAction={() => onAddTool(tool.id)}
              />
            );
          })
        )}
      </div>
    </section>
  );
}
