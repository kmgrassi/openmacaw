import { Card } from "../../ui/Card";

export function DebugSnapshotCard({ value }: { value: unknown }) {
  return (
    <Card>
      <h3 className="text-sm font-medium text-slate-300 mb-3">
        Debug snapshot
      </h3>
      <pre className="overflow-auto rounded-md bg-slate-950/80 p-3 text-xs text-slate-300">
        {JSON.stringify(value, null, 2)}
      </pre>
    </Card>
  );
}
