import { Card } from "../ui/Card";

type RuntimeDebugCardProps = {
  loading: boolean;
  runtimeAgents: unknown;
};

export function RuntimeDebugCard({ loading, runtimeAgents }: RuntimeDebugCardProps) {
  return (
    <Card className="border-slate-800 bg-slate-900/70">
      <div className="text-sm font-medium text-white">Proxied `/api/agents`</div>
      <pre className="mt-4 max-h-80 overflow-auto rounded-lg bg-slate-950/80 p-3 text-xs text-slate-300">
        {loading ? "Loading..." : JSON.stringify(runtimeAgents, null, 2)}
      </pre>
    </Card>
  );
}
