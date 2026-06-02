import type { ToolDefinition } from "../../../hooks/useToolDefinitions";
import { Button } from "../../ui/Button";
import { SurfaceListItem } from "../../ui/SurfaceList";
import { formatSchema } from "./utils";

type SchemaPreviewProps = {
  tool: ToolDefinition;
  onClose: () => void;
};

export function SchemaPreview({ tool, onClose }: SchemaPreviewProps) {
  return (
    <SurfaceListItem className="mt-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-medium text-slate-200">{tool.name}</h4>
          <p className="mt-1 break-all font-mono text-xs text-slate-500">
            {tool.slug}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <pre className="max-h-72 overflow-auto rounded-md border border-border bg-black/20 p-3 text-xs leading-5 text-slate-300 chat-scrollbar">
        {formatSchema(tool.parameters)}
      </pre>
    </SurfaceListItem>
  );
}
