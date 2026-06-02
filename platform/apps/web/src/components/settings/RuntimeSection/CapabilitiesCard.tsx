import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";

type Props = {
  events?: string[];
  methods?: string[];
};

export function CapabilitiesCard({ events, methods }: Props) {
  return (
    <Card>
      <h3 className="text-sm font-medium text-slate-300 mb-3">Capabilities</h3>
      {methods && methods.length > 0 && (
        <div className="mb-2">
          <span className="text-xs text-slate-500">Methods</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {methods.map((method) => (
              <Badge key={method}>{method}</Badge>
            ))}
          </div>
        </div>
      )}
      {events && events.length > 0 && (
        <div>
          <span className="text-xs text-slate-500">Events</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {events.map((event) => (
              <Badge key={event}>{event}</Badge>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
