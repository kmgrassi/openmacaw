import { OnboardingCards } from "../components/OnboardingCards";

export function Onboarding() {
  return (
    <div className="min-h-full bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="mb-8 max-w-2xl">
          <div className="text-xs uppercase tracking-[0.3em] text-sky-300">
            First-run setup
          </div>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white">
            Start with your planning agent.
          </h1>
          <p className="mt-3 text-sm text-slate-400">
            Choose how the default agents should run, then continue to the
            dashboard.
          </p>
        </div>
        <OnboardingCards />
      </div>
    </div>
  );
}
