import type { LocalRuntime } from "../../../api/local-runtime";

export type WizardState = "not_registered" | "waiting" | "connected" | "bound";

export const WIZARD_STEPS: Array<{ state: WizardState; label: string }> = [
  { state: "not_registered", label: "Register" },
  { state: "waiting", label: "Connect" },
  { state: "connected", label: "Bind" },
  { state: "bound", label: "Ready" },
];

function expectedRunnerKinds(runtime: LocalRuntime): string[] {
  // A registration is considered "connected" only once the helper advertises
  // every runner kind the user actually configured. Each runner row carries a
  // registration-family identifier ("openai_compatible" | "openclaw") that maps
  // directly to a TOML stanza, which is the same value the helper reports back
  // in RegisterFrame.runner_kinds.
  return runtime.runners.map((runner) => runner.kind);
}

export function wizardStateFor(
  runtime: LocalRuntime | null,
  hasRegistrationResult: boolean,
): WizardState {
  if (!runtime) return hasRegistrationResult ? "waiting" : "not_registered";
  if (!runtime.localExecution.helperOnline) return "waiting";
  const advertised = new Set(runtime.localExecution.advertisedRunnerKinds);
  const missing = expectedRunnerKinds(runtime).some(
    (kind) => !advertised.has(kind),
  );
  if (missing) return "waiting";
  const anyBound = runtime.runners.some((runner) => runner.agents.length > 0);
  return anyBound ? "bound" : "connected";
}
