import { EmptyState } from "../../ui/EmptyState";

export function NoModelsState() {
  return (
    <EmptyState
      density="compact"
      align="left"
      label="No models available."
      description="Add provider credentials or register a local model first."
      action={
        <a className="text-xs text-blue-400 hover:text-blue-300" href="#models">
          Manage provider credentials
        </a>
      }
    />
  );
}
