import { WIZARD_STEPS, type WizardState } from "./wizard-state";

export function WizardSteps({ state }: { state: WizardState }) {
  const activeIndex = WIZARD_STEPS.findIndex((step) => step.state === state);

  return (
    <div className="grid gap-2 lg:grid-cols-2">
      {WIZARD_STEPS.map((step, index) => {
        const complete = index < activeIndex;
        const active = index === activeIndex;
        return (
          <div
            key={step.state}
            className={`rounded-md border px-3 py-2 text-xs ${
              active || complete
                ? "border-blue-500/40 bg-blue-950/20 text-blue-200"
                : "border-border bg-surface-raised text-slate-500"
            }`}
          >
            <div className="font-medium">{step.label}</div>
            <div className="mt-0.5">
              {complete ? "Complete" : active ? "Current" : "Pending"}
            </div>
          </div>
        );
      })}
    </div>
  );
}
