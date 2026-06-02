import { useParams } from "react-router-dom";

import { AppShell } from "../../components/AppShell";
import { Card } from "../../components/ui/Card";
import { ButtonLink } from "../../components/ui/ButtonLink";

export function PlanDetail() {
  const { planId = "" } = useParams();

  return (
    <AppShell>
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-6">
        <div>
          <div className="text-xs uppercase tracking-[0.28em] text-slate-500">
            Plan
          </div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
            Plan created
          </h1>
        </div>

        <Card className="border-slate-800 bg-slate-900/70">
          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium text-slate-200">Plan ID</div>
              <div className="mt-2 overflow-x-auto rounded-md border border-border bg-slate-950 px-3 py-2 font-mono text-sm text-slate-300">
                {planId}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <ButtonLink to="/plans/new">Create another plan</ButtonLink>
              <ButtonLink to="/settings/agents" variant="secondary">
                Open agent settings
              </ButtonLink>
            </div>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
