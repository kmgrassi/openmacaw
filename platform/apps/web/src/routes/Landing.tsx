type LandingProps = {
  appUrl: string;
};

const productPillars = [
  {
    title: "Coordinate every runtime",
    description:
      "Run hosted agents, local model workflows, and custom execution targets from one shared control plane.",
  },
  {
    title: "Keep work routed",
    description:
      "Use workspace context, agent profiles, and routing rules to keep planning, coding, and review flows connected.",
  },
  {
    title: "Operate with visibility",
    description:
      "Track health, credentials, sessions, traces, and runtime status without stitching together separate tools.",
  },
];

const systemLayers = [
  {
    name: "Platform",
    detail:
      "Browser UI, API gateway, shared contracts, database coordination, generated Supabase types, and local developer scripts.",
  },
  {
    name: "Runtime",
    detail:
      "Elixir orchestrator, launcher, relay-facing behavior, worker bridge, smoke tools, and generated runtime schemas.",
  },
  {
    name: "Local helper",
    detail:
      "Installable daemon for outbound relay connections, local runner advertisement, and local workflow execution.",
  },
];

const workflowSteps = [
  "Plan with agents that understand workspace context.",
  "Route tasks to hosted, local, or custom runtimes.",
  "Watch execution health, messages, traces, and outputs.",
  "Review results and keep improving the agent system.",
];

const stats = [
  ["Web", "React control plane"],
  ["API", "Database-backed coordination"],
  ["Runtime", "Launcher and orchestrator"],
  ["Helper", "Local runner bridge"],
];

function ArrowIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      viewBox="0 0 20 20"
      fill="none"
    >
      <path
        d="M4 10h10m0 0-4-4m4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      className="mt-0.5 h-4 w-4 flex-none text-teal-700"
      viewBox="0 0 20 20"
      fill="none"
    >
      <path
        d="m5 10.5 3 3L15.5 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Landing({ appUrl }: LandingProps) {
  return (
    <main className="min-h-full bg-stone-50 text-slate-950">
      <section className="relative overflow-hidden border-b border-slate-200">
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 20% 18%, rgba(20,184,166,0.18), transparent 30%), radial-gradient(circle at 92% 8%, rgba(225,83,61,0.14), transparent 28%), linear-gradient(135deg, #f8faf5 0%, #eaf5f1 45%, #fbf0e9 100%)",
          }}
        />
        <div className="relative mx-auto flex min-h-[92vh] max-w-7xl flex-col px-5 py-5 sm:px-8 lg:px-10">
          <header className="flex items-center justify-between gap-4">
            <a className="flex items-center gap-3" href="/">
              <span className="flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 bg-white shadow-sm">
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
                className="hidden rounded-md px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-white hover:text-slate-950 sm:inline-flex"
              >
                GitHub
              </a>
              <a
                href={appUrl}
                className="inline-flex items-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                Open app
                <ArrowIcon />
              </a>
            </nav>
          </header>

          <div className="grid flex-1 items-center gap-10 py-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(430px,1.1fr)] lg:py-16">
            <div className="max-w-3xl">
              <p className="mb-5 inline-flex rounded-md border border-slate-300 bg-white/75 px-3 py-1 text-sm font-medium text-slate-600">
                Open-source AI agent coordination
              </p>
              <h1 className="max-w-4xl text-5xl font-semibold leading-[1.02] text-slate-950 sm:text-6xl lg:text-7xl">
                One control plane for hosted and local AI agents.
              </h1>
              <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600">
                OpenMacaw combines a web/API platform, runtime orchestrator, and
                installable local helper so teams can coordinate agent work
                across cloud and local execution without losing visibility.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a
                  href={appUrl}
                  className="inline-flex items-center gap-2 rounded-md bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  Launch dashboard
                  <ArrowIcon />
                </a>
                <a
                  href="https://github.com/kmgrassi/OpenMacaw"
                  className="rounded-md border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-950 transition hover:border-slate-500"
                >
                  View source
                </a>
              </div>
              <div className="mt-9 grid max-w-2xl gap-3 sm:grid-cols-2">
                {workflowSteps.slice(0, 4).map((item) => (
                  <div key={item} className="flex gap-2 text-sm text-slate-600">
                    <CheckIcon />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="relative min-h-[470px] lg:min-h-[600px]">
              <div className="absolute inset-x-0 top-0 mx-auto max-w-[700px] rounded-md border border-slate-500 bg-slate-950 p-3 shadow-2xl shadow-slate-400/25">
                <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
                    <span className="h-2.5 w-2.5 rounded-full bg-teal-300" />
                  </div>
                  <span className="text-xs text-slate-400">
                    app.openmacaw.ai
                  </span>
                </div>
                <div className="grid gap-3 p-3 md:grid-cols-[190px_1fr]">
                  <aside className="rounded-md border border-white/10 bg-white/[0.04] p-3">
                    <div className="mb-4 h-3 w-24 rounded bg-white/25" />
                    {["Agent dashboard", "Runtime health", "Local runners", "Credentials"].map(
                      (route) => (
                        <div
                          key={route}
                          className="mb-2 rounded-md border border-white/10 bg-white/[0.05] px-3 py-2 text-xs text-slate-300"
                        >
                          {route}
                        </div>
                      ),
                    )}
                  </aside>
                  <div className="rounded-md border border-white/10 bg-slate-900 p-4">
                    <div className="mb-5 flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-white">
                          Runtime dashboard
                        </div>
                        <div className="mt-2 h-2 w-52 max-w-full rounded bg-white/15" />
                      </div>
                      <div className="rounded-md bg-teal-300 px-3 py-1 text-xs font-semibold text-teal-950">
                        Healthy
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-3">
                      {[
                        ["Route", "Hosted, local, or custom runner."],
                        ["Run", "Live status, traces, and chat."],
                        ["Review", "Outputs, credentials, and history."],
                      ].map(([label, value]) => (
                        <div
                          key={label}
                          className="rounded-md border border-white/10 bg-white/[0.04] p-3"
                        >
                          <div className="text-sm font-semibold text-white">
                            {label}
                          </div>
                          <p className="mt-2 text-xs leading-5 text-slate-400">
                            {value}
                          </p>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 rounded-md border border-white/10 bg-slate-950 p-4">
                      <div className="mb-3 flex items-center justify-between text-xs text-slate-400">
                        <span>Runtime activity</span>
                        <span>Live</span>
                      </div>
                      <div className="space-y-2">
                        <div className="h-2 rounded bg-teal-300/70" />
                        <div className="h-2 w-4/5 rounded bg-red-500/70" />
                        <div className="h-2 w-3/5 rounded bg-amber-300/70" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-slate-200 bg-white">
        <div className="mx-auto grid max-w-7xl gap-4 px-5 py-8 sm:grid-cols-2 sm:px-8 lg:grid-cols-4 lg:px-10">
          {stats.map(([label, value]) => (
            <div key={label} className="rounded-md border border-slate-200 p-5">
              <div className="text-sm font-semibold text-teal-700">
                {label}
              </div>
              <div className="mt-2 text-sm text-slate-600">{value}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-stone-50">
        <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 lg:px-10">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.14em] text-teal-700">
              Built for agent operations
            </p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight text-slate-950 sm:text-4xl">
              Bring coordination, runtime control, and local execution into one
              workflow.
            </h2>
          </div>

          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            {productPillars.map((pillar) => (
              <article
                key={pillar.title}
                className="rounded-md border border-slate-200 bg-white p-6 shadow-sm"
              >
                <h3 className="text-lg font-semibold text-slate-950">
                  {pillar.title}
                </h3>
                <p className="mt-4 text-sm leading-7 text-slate-600">
                  {pillar.description}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-slate-200 bg-slate-950 text-white">
        <div className="mx-auto grid max-w-7xl gap-10 px-5 py-20 sm:px-8 lg:grid-cols-[0.72fr_1fr] lg:px-10">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.14em] text-teal-300">
              System architecture
            </p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-4xl">
              A single source tree for the platform, orchestrator, and local
              helper.
            </h2>
            <p className="mt-5 text-sm leading-7 text-slate-400">
              OpenMacaw is designed so the browser UI, API coordination layer,
              runtime orchestration, and local machine bridge can be developed
              together while still preserving clear subsystem boundaries.
            </p>
          </div>

          <div className="grid gap-3">
            {systemLayers.map((layer) => (
              <article
                key={layer.name}
                className="rounded-md border border-white/10 bg-white/[0.04] p-5"
              >
                <h3 className="text-lg font-semibold">{layer.name}</h3>
                <p className="mt-3 text-sm leading-7 text-slate-400">
                  {layer.detail}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-white">
        <div className="mx-auto grid max-w-7xl gap-8 px-5 py-20 sm:px-8 lg:grid-cols-[0.82fr_1fr] lg:px-10">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.14em] text-teal-700">
              Local-first when it matters
            </p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight text-slate-950 sm:text-4xl">
              Connect local runners without opening inbound access to your
              machine.
            </h2>
          </div>
          <div className="text-sm leading-7 text-slate-600">
            <p>
              The local runtime helper runs as a daemon on a user machine,
              opens an outbound relay connection, advertises configured local
              runners, and can execute supported workflows without requiring
              inbound network access.
            </p>
            <p className="mt-5">
              Full end-to-end behavior can include the platform, runtime,
              helper, provider credentials, and a configured database path. The
              project is pre-release, and the public self-hosting path is being
              made more explicit as the repository hardens.
            </p>
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 bg-teal-50">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-14 sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:px-10">
          <div>
            <h2 className="text-2xl font-semibold text-slate-950">
              Start with the dashboard or inspect the source.
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              OpenMacaw is moving toward a polished open-source launch while
              remaining usable for active local development.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <a
              href={appUrl}
              className="inline-flex items-center gap-2 rounded-md bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              Open app
              <ArrowIcon />
            </a>
            <a
              href="https://github.com/kmgrassi/OpenMacaw"
              className="rounded-md border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-950 transition hover:border-slate-500"
            >
              GitHub repository
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
