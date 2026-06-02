import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";

type AgentDangerZoneProps = {
  deleting: boolean;
  onDelete: () => void;
};

export function AgentDangerZone({ deleting, onDelete }: AgentDangerZoneProps) {
  return (
    <Card className="border-red-600/30">
      <h4 className="text-sm font-medium text-red-400 mb-2">Danger zone</h4>
      <p className="text-xs text-slate-400 mb-3">
        Permanently delete this agent and all associated configuration.
      </p>
      <Button variant="danger" size="sm" loading={deleting} onClick={onDelete}>
        Delete agent
      </Button>
    </Card>
  );
}
