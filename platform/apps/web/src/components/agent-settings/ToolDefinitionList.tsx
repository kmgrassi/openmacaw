import { useState } from "react";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import type {
  ToolDefinition,
  ToolDefinitionInput,
} from "../../hooks/useToolDefinitions";

type Props = {
  tools: ToolDefinition[];
  saving: boolean;
  onEdit: (tool: ToolDefinition) => void;
  onDelete: (tool: ToolDefinition) => void;
  onUnassign: (tool: ToolDefinition) => void;
  onUpdate: (toolId: string, input: ToolDefinitionInput) => Promise<void>;
  onReorder: (tools: ToolDefinition[]) => Promise<void>;
};

function toInput(tool: ToolDefinition): ToolDefinitionInput {
  return {
    slug: tool.slug,
    name: tool.name,
    description: tool.description,
    functionName: tool.functionName,
    parameters: tool.parameters,
    type: tool.type,
    executionKind: tool.executionKind,
    runnerKind: tool.runnerKind,
    enabled: tool.enabled,
  };
}

function moveTool(tools: ToolDefinition[], fromIndex: number, toIndex: number) {
  const next = [...tools];
  const [removed] = next.splice(fromIndex, 1);
  if (!removed) return tools;
  next.splice(toIndex, 0, removed);
  return next;
}

export function ToolDefinitionList({
  tools,
  saving,
  onEdit,
  onDelete,
  onUnassign,
  onUpdate,
  onReorder,
}: Props) {
  const [draggedToolId, setDraggedToolId] = useState<string | null>(null);

  if (tools.length === 0) {
    return <EmptyState label="No tools are assigned to this agent." />;
  }

  const handleDrop = async (targetToolId: string) => {
    if (!draggedToolId || draggedToolId === targetToolId) return;
    const fromIndex = tools.findIndex((tool) => tool.id === draggedToolId);
    const toIndex = tools.findIndex((tool) => tool.id === targetToolId);
    setDraggedToolId(null);
    if (fromIndex < 0 || toIndex < 0) return;
    await onReorder(moveTool(tools, fromIndex, toIndex));
  };

  return (
    <div className="space-y-2">
      {tools.map((tool, index) => (
        <div
          key={tool.id}
          draggable
          onDragStart={() => setDraggedToolId(tool.id)}
          onDragEnd={() => setDraggedToolId(null)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => void handleDrop(tool.id)}
          className={`rounded-md border border-border bg-surface px-3 py-3 ${
            draggedToolId === tool.id ? "opacity-60" : ""
          }`}
        >
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="cursor-grab text-xs text-slate-500"
                  aria-hidden="true"
                >
                  ::
                </span>
                <h4 className="text-sm font-medium text-slate-200">
                  {tool.name}
                </h4>
                <Badge>{tool.executionKind ?? "untyped"}</Badge>
                {tool.runnerKind && <Badge>{tool.runnerKind}</Badge>}
                {!tool.enabled && <Badge variant="warning">disabled</Badge>}
              </div>
              <p className="mt-1 text-xs text-slate-500 font-mono">
                {tool.slug}
              </p>
              {tool.description && (
                <p className="mt-2 text-sm text-slate-400">
                  {tool.description}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={saving || index === 0}
                onClick={() =>
                  void onReorder(moveTool(tools, index, index - 1))
                }
              >
                Up
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={saving || index === tools.length - 1}
                onClick={() =>
                  void onReorder(moveTool(tools, index, index + 1))
                }
              >
                Down
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={saving}
                onClick={() =>
                  void onUpdate(tool.id, {
                    ...toInput(tool),
                    enabled: !tool.enabled,
                  })
                }
              >
                {tool.enabled ? "Disable" : "Enable"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => onEdit(tool)}
              >
                Edit
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => onUnassign(tool)}
              >
                Unassign
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                disabled={saving}
                onClick={() => onDelete(tool)}
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
