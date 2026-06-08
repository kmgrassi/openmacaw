type LandingProps = {
  appUrl: string;
};

const appRoutes = [
  "Hosted and local runtimes",
  "Agent dashboards",
  "Model and credential controls",
  "Runtime diagnostics",
];

const workflowSteps = [
  {
    label: "Route",
    value: "Pick cloud, local, or custom runners per agent.",
  },
  {
    label: "Run",
    value: "Launch work with live status, traces, and chat handoff.",
  },
  {
    label: "Review",
    value: "Inspect outputs, credentials, runtime health, and history.",
  },
];

export function Landing({ appUrl }: LandingProps) {
  return (
    <main className="min-h-full bg-[#f7f8f4] text-[#13201d]">
      <section className="relative min-h-[92vh] overflow-hidden border-b border-[#d9dfd4]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_22%,rgba(20,184,166,0.16),transparent_28%),radial-gradient(circle_at_82%_12%,rgba(225,83,61,0.13),transparent_26%),linear-gradient(135deg,#f7f8f4_0%,#eef5f2_48%,#f8efe9_100%)]" />
        <div className="relative mx-auto flex min-h-[92vh] max-w-7xl flex-col px-5 py-5 sm:px-8 lg:px-10">
          <header className="flex items-center justify-between gap-4">
            <a className="flex items-center gap-3" href="/">
              <span className="flex h-10 w-10 items-center justify-center rounded-md border border-[#d9dfd4] bg-white">
                <img
                  src="/favicon.svg"
                  alt=""
                  className="h-7 w-7"
                  aria-hidden="true"
                />
              </span>
              <span className="text-base font-semibold">OpenMacaw</span>
            </a>
            <nav className="flex items-center gap-2">
              <a
                href="https://github.com/kmgrassi/OpenMacaw"
                className="hidden rounded-md px-3 py-2 text-sm font-medium text-[#52645e] transition hover:bg-white hover:text-[#13201d] sm:inline-flex"
              >
                GitHub
              </a>
              <a
                href={appUrl}
                className="rounded-md bg-[#13201d] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#25453d]"
              >
                Open app
              </a>
            </nav>
          </header>

          <div className="grid flex-1 items-center gap-10 py-12 lg:grid-cols-[minmax(0,0.92fr)_minmax(420px,1.08fr)] lg:py-16">
            <div className="max-w-3xl">
              <p className="mb-5 inline-flex rounded-md border border-[#c9d2ca] bg-white/70 px-3 py-1 text-sm font-medium text-[#52645e]">
                Open-source AI agent coordination
              </p>
              <h1 className="max-w-4xl text-5xl font-semibold leading-[1.02] text-[#13201d] sm:text-6xl lg:text-7xl">
                OpenMacaw
              </h1>
              <p className="mt-6 max-w-2xl text-lg leading-8 text-[#52645e]">
                Coordinate hosted and local AI agents from one control plane,
                with runtime routing, workspace context, credentials, and
                diagnostics built for real software work.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a
                  href={appUrl}
                  className="rounded-md bg-[#13201d] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#25453d]"
                >
                  Launch dashboard
                </a>
                <a
                  href="https://github.com/kmgrassi/OpenMacaw"
                  className="rounded-md border border-[#bfc9c0] bg-white px-5 py-3 text-sm font-semibold text-[#13201d] transition hover:border-[#7f918b]"
                >
                  View source
                </a>
              </div>
            </div>

            <div className="relative min-h-[430px] lg:min-h-[560px]">
              <div className="absolute inset-x-0 top-0 mx-auto max-w-[660px] rounded-md border border-[#b8c4bc] bg-[#101918] p-3 shadow-2xl shadow-[#78938b]/25">
                <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-[#e1533d]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#e7c85c]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#35b89f]" />
                  </div>
                  <span className="text-xs text-slate-400">
                    app.openmacaw.ai
                  </span>
                </div>
                <div className="grid gap-3 p-3 md:grid-cols-[190px_1fr]">
                  <aside className="rounded-md border border-white/10 bg-white/[0.04] p-3">
                    <div className="mb-4 h-3 w-24 rounded bg-white/25" />
                    {appRoutes.map((route) => (
                      <div
                        key={route}
                        className="mb-2 rounded-md border border-white/10 bg-white/[0.05] px-3 py-2 text-xs text-slate-300"
                      >
                        {route}
                      </div>
                    ))}
                  </aside>
                  <div className="rounded-md border border-white/10 bg-[#172321] p-4">
                    <div className="mb-5 flex items-center justify-between">
                      <div>
                        <div className="h-3 w-36 rounded bg-white/35" />
                        <div className="mt-2 h-2 w-52 rounded bg-white/15" />
                      </div>
                      <div className="rounded-md bg-[#35b89f] px-3 py-1 text-xs font-semibold text-[#06211c]">
                        Healthy
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-3">
                      {workflowSteps.map((step) => (
                        <div
                          key={step.label}
                          className="rounded-md border border-white/10 bg-white/[0.04] p-3"
                        >
                          <div className="text-sm font-semibold text-white">
                            {step.label}
                          </div>
                          <p className="mt-2 text-xs leading-5 text-slate-400">
                            {step.value}
                          </p>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 rounded-md border border-white/10 bg-[#0d1514] p-4">
                      <div className="mb-3 flex items-center justify-between text-xs text-slate-400">
                        <span>Runtime activity</span>
                        <span>Live</span>
                      </div>
                      <div className="space-y-2">
                        <div className="h-2 rounded bg-[#35b89f]/70" />
                        <div className="h-2 w-4/5 rounded bg-[#e1533d]/70" />
                        <div className="h-2 w-3/5 rounded bg-[#e7c85c]/70" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
