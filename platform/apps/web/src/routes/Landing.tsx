import { useState, type CSSProperties } from "react";

type LandingProps = {
  appUrl: string;
};

type ThemePreset = {
  name: string;
  label: string;
  page: string;
  surface: string;
  surfaceSoft: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  accentSoft: string;
  accentText: string;
  primary: string;
  primaryHover: string;
  primaryText: string;
  inverse: string;
  inverseMuted: string;
  hero: string;
};

const themes: ThemePreset[] = [
  {
    name: "Ember",
    label: "Warm",
    page: "#fffaf5",
    surface: "#ffffff",
    surfaceSoft: "#ffedd5",
    text: "#18181b",
    muted: "#57534e",
    border: "#fed7aa",
    accent: "#c2410c",
    accentSoft: "#fed7aa",
    accentText: "#7c2d12",
    primary: "#9a3412",
    primaryHover: "#7c2d12",
    primaryText: "#ffffff",
    inverse: "#1c1917",
    inverseMuted: "#fdba74",
    hero:
      "radial-gradient(circle at 18% 20%, rgba(249,115,22,0.16), transparent 30%), radial-gradient(circle at 90% 10%, rgba(244,63,94,0.12), transparent 28%), linear-gradient(135deg, #fffaf5 0%, #fff1e7 48%, #fff7ed 100%)",
  },
  {
    name: "Evergreen",
    label: "Default",
    page: "#fafaf9",
    surface: "#ffffff",
    surfaceSoft: "#ecfdf5",
    text: "#020617",
    muted: "#475569",
    border: "#cbd5e1",
    accent: "#0f766e",
    accentSoft: "#ccfbf1",
    accentText: "#134e4a",
    primary: "#020617",
    primaryHover: "#1e293b",
    primaryText: "#ffffff",
    inverse: "#020617",
    inverseMuted: "#94a3b8",
    hero:
      "radial-gradient(circle at 20% 18%, rgba(20,184,166,0.18), transparent 30%), radial-gradient(circle at 92% 8%, rgba(225,83,61,0.14), transparent 28%), linear-gradient(135deg, #f8faf5 0%, #eaf5f1 45%, #fbf0e9 100%)",
  },
  {
    name: "Signal",
    label: "Blue",
    page: "#f8fbff",
    surface: "#ffffff",
    surfaceSoft: "#e0f2fe",
    text: "#0f172a",
    muted: "#475569",
    border: "#bfdbfe",
    accent: "#2563eb",
    accentSoft: "#dbeafe",
    accentText: "#1e3a8a",
    primary: "#1d4ed8",
    primaryHover: "#1e40af",
    primaryText: "#ffffff",
    inverse: "#0b1220",
    inverseMuted: "#93c5fd",
    hero:
      "radial-gradient(circle at 20% 18%, rgba(37,99,235,0.16), transparent 30%), radial-gradient(circle at 88% 12%, rgba(14,165,233,0.16), transparent 28%), linear-gradient(135deg, #f8fbff 0%, #eaf4ff 48%, #f6f8ff 100%)",
  },
  {
    name: "Orchid",
    label: "Violet",
    page: "#fbf8ff",
    surface: "#ffffff",
    surfaceSoft: "#f3e8ff",
    text: "#181026",
    muted: "#5b5366",
    border: "#ddd6fe",
    accent: "#7c3aed",
    accentSoft: "#ede9fe",
    accentText: "#4c1d95",
    primary: "#6d28d9",
    primaryHover: "#5b21b6",
    primaryText: "#ffffff",
    inverse: "#171022",
    inverseMuted: "#c4b5fd",
    hero:
      "radial-gradient(circle at 20% 18%, rgba(124,58,237,0.16), transparent 30%), radial-gradient(circle at 92% 8%, rgba(236,72,153,0.12), transparent 28%), linear-gradient(135deg, #fbf8ff 0%, #f3ecff 46%, #fff7fb 100%)",
  },
  {
    name: "Graphite",
    label: "Neutral",
    page: "#f7f7f5",
    surface: "#ffffff",
    surfaceSoft: "#e7e5e4",
    text: "#111827",
    muted: "#52525b",
    border: "#d6d3d1",
    accent: "#3f3f46",
    accentSoft: "#e7e5e4",
    accentText: "#27272a",
    primary: "#18181b",
    primaryHover: "#3f3f46",
    primaryText: "#ffffff",
    inverse: "#18181b",
    inverseMuted: "#d4d4d8",
    hero:
      "radial-gradient(circle at 18% 18%, rgba(63,63,70,0.12), transparent 30%), radial-gradient(circle at 88% 10%, rgba(120,113,108,0.14), transparent 28%), linear-gradient(135deg, #f7f7f5 0%, #eeeeeb 48%, #fafafa 100%)",
  },
  {
    name: "Mint",
    label: "Green",
    page: "#f6fff8",
    surface: "#ffffff",
    surfaceSoft: "#dcfce7",
    text: "#052e16",
    muted: "#3f6212",
    border: "#bbf7d0",
    accent: "#15803d",
    accentSoft: "#dcfce7",
    accentText: "#14532d",
    primary: "#166534",
    primaryHover: "#14532d",
    primaryText: "#ffffff",
    inverse: "#052e16",
    inverseMuted: "#86efac",
    hero:
      "radial-gradient(circle at 20% 18%, rgba(34,197,94,0.16), transparent 30%), radial-gradient(circle at 90% 10%, rgba(20,184,166,0.14), transparent 28%), linear-gradient(135deg, #f6fff8 0%, #e9fcef 48%, #f4fff9 100%)",
  },
];

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

const projectComparisons = [
  {
    project: "OpenMacaw",
    role: "Product control plane for agent operations, including the web app, API, runtime orchestrator, and local helper.",
    runs: "Browser, API service, database, runtime services, and developer machines connected through the local helper.",
    fit: "Coordinating teams, workspaces, credentials, health, traces, and mixed hosted/local execution without opening inbound access.",
  },
  {
    project: "OpenClaw",
    role: "Execution backend and runner target with WebSocket and HTTP/SSE adapter paths.",
    runs: "Local or cloud runner infrastructure.",
    fit: "Rich runtime control, live event streams, interrupt support, and agent/session operations.",
  },
  {
    project: "Hermes Agent",
    role: "Learning-layer blueprint for self-improving personal agents and skill evolution.",
    runs: "Conceptual agent runtime pattern rather than a bundled OpenMacaw runner.",
    fit: "User memory, skill growth, and personal-agent learning ideas that inform future sidecar work.",
  },
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

function CheckIcon({ color }: { color: string }) {
  return (
    <svg
      aria-hidden="true"
      className="mt-0.5 h-4 w-4 flex-none"
      viewBox="0 0 20 20"
      fill="none"
      style={{ color }}
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
  const [themeIndex, setThemeIndex] = useState(0);
  const theme = themes[themeIndex] ?? themes[0]!;
  const primaryButtonStyle: CSSProperties = {
    backgroundColor: theme.primary,
    color: theme.primaryText,
  };
  const outlineButtonStyle: CSSProperties = {
    backgroundColor: theme.surface,
    borderColor: theme.border,
    color: theme.text,
  };
  const elevatedSurfaceStyle: CSSProperties = {
    backgroundColor: `${theme.surface}e6`,
    borderColor: theme.border,
    boxShadow:
      "0 22px 70px rgba(120, 53, 15, 0.10), 0 1px 0 rgba(255, 255, 255, 0.70) inset",
  };

  return (
    <main
      className="min-h-full"
      style={{ backgroundColor: theme.page, color: theme.text }}
    >
      <section
        className="relative overflow-hidden border-b"
        style={{ borderColor: theme.border }}
      >
        <div
          className="absolute inset-0"
          style={{
            background: `${theme.hero}, radial-gradient(circle at 74% 48%, rgba(194,65,12,0.18), transparent 34%)`,
          }}
        />
        <div
          className="absolute inset-0 opacity-[0.28]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(120, 53, 15, 0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(120, 53, 15, 0.08) 1px, transparent 1px)",
            backgroundSize: "72px 72px",
            maskImage:
              "linear-gradient(to bottom, transparent 0%, black 16%, black 72%, transparent 100%)",
          }}
        />
        <div className="relative mx-auto flex min-h-[86vh] max-w-7xl flex-col px-5 py-5 sm:px-8 lg:px-10">
          <header
            className="flex items-center justify-between gap-4 rounded-2xl border px-3 py-3 backdrop-blur-md sm:px-4"
            style={elevatedSurfaceStyle}
          >
            <a className="flex items-center gap-3" href="/">
              <span
                className="flex h-11 w-11 items-center justify-center rounded-xl"
                style={{ backgroundColor: theme.surfaceSoft }}
              >
                <img
                  src="/openmacaw-logo.png"
                  alt=""
                  className="h-9 w-9 object-contain"
                  aria-hidden="true"
                />
              </span>
              <span className="text-base font-semibold tracking-tight">
                OpenMacaw
              </span>
            </a>
            <nav className="flex items-center gap-2">
              <a
                href="https://github.com/kmgrassi/OpenMacaw"
                className="hidden rounded-xl px-3 py-2 text-sm font-medium transition hover:bg-black/[0.04] hover:opacity-90 sm:inline-flex"
                style={{ color: theme.muted }}
              >
                GitHub
              </a>
              <a
                href={appUrl}
                className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition hover:brightness-95"
                style={{
                  ...primaryButtonStyle,
                  boxShadow: "0 12px 28px rgba(154, 52, 18, 0.22)",
                }}
              >
                Open app
                <ArrowIcon />
              </a>
            </nav>
          </header>

          <div className="grid flex-1 items-center gap-12 py-8 lg:grid-cols-[minmax(0,0.88fr)_minmax(430px,1.12fr)] lg:py-8">
            <div className="max-w-3xl lg:pb-8">
              <p
                className="mb-6 inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold uppercase tracking-[0.16em]"
                style={{
                  backgroundColor: "rgba(255,255,255,0.62)",
                  color: theme.accent,
                  boxShadow:
                    "0 1px 0 rgba(255,255,255,0.85) inset, 0 10px 30px rgba(120,53,15,0.08)",
                }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: theme.accent }}
                />
                Open-source AI agent coordination
              </p>
              <h1 className="max-w-4xl text-5xl font-semibold leading-[0.98] tracking-tight sm:text-6xl lg:text-7xl">
                One control plane for hosted and local AI agents.
              </h1>
              <p
                className="mt-6 max-w-2xl text-lg font-normal leading-8 sm:text-xl sm:leading-9"
                style={{ color: theme.muted }}
              >
                OpenMacaw combines a web/API platform, runtime orchestrator, and
                installable local helper so teams can coordinate agent work
                across cloud and local execution without losing visibility.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a
                  href={appUrl}
                  className="inline-flex items-center gap-2 rounded-xl px-5 py-3.5 text-sm font-semibold transition hover:brightness-95"
                  style={{
                    ...primaryButtonStyle,
                    boxShadow:
                      "0 18px 36px rgba(154, 52, 18, 0.26), 0 1px 0 rgba(255,255,255,0.22) inset",
                  }}
                >
                  Launch dashboard
                  <ArrowIcon />
                </a>
                <a
                  href="https://github.com/kmgrassi/OpenMacaw"
                  className="rounded-xl border px-5 py-3.5 text-sm font-semibold transition hover:bg-white hover:opacity-90"
                  style={{
                    ...outlineButtonStyle,
                    boxShadow: "0 10px 26px rgba(120, 53, 15, 0.07)",
                  }}
                >
                  View source
                </a>
              </div>
              <div className="mt-8 grid max-w-2xl gap-3 sm:grid-cols-2">
                {workflowSteps.map((item) => (
                  <div
                    key={item}
                    className="flex items-start gap-3 rounded-xl border px-3.5 py-3 text-sm leading-6"
                    style={{
                      backgroundColor: "rgba(255,255,255,0.50)",
                      borderColor: "rgba(254, 215, 170, 0.72)",
                      color: theme.muted,
                    }}
                  >
                    <span
                      className="flex h-6 w-6 flex-none items-center justify-center rounded-lg"
                      style={{
                        backgroundColor: theme.accentSoft,
                        color: theme.accent,
                      }}
                    >
                      <CheckIcon color="currentColor" />
                    </span>
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="relative min-h-[440px] lg:min-h-[540px]">
              <div
                className="absolute inset-x-8 top-14 h-72 rounded-full blur-3xl lg:inset-x-0"
                style={{ backgroundColor: "rgba(194, 65, 12, 0.20)" }}
              />
              <div className="absolute inset-x-0 top-0 mx-auto max-w-[720px] rounded-[28px] border border-white/10 bg-[#07111f] p-3 shadow-[0_34px_100px_rgba(28,25,23,0.32),0_2px_0_rgba(255,255,255,0.08)_inset]">
                <div className="rounded-[22px] border border-white/10 bg-gradient-to-b from-white/[0.08] to-white/[0.02]">
                  <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
                    <span className="h-2.5 w-2.5 rounded-full bg-teal-300" />
                  </div>
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-slate-300">
                    app.openmacaw.ai
                  </span>
                </div>
                <div className="grid gap-4 p-4 md:grid-cols-[200px_1fr]">
                  <aside className="rounded-2xl border border-white/10 bg-white/[0.045] p-4 shadow-[0_1px_0_rgba(255,255,255,0.08)_inset]">
                    <div className="mb-5 h-2.5 w-24 rounded-full bg-white/25" />
                    {[
                      "Agent dashboard",
                      "Runtime health",
                      "Local runners",
                      "Credentials",
                    ].map((route) => (
                      <div
                        key={route}
                        className="mb-2 rounded-xl border border-white/10 bg-white/[0.045] px-3 py-2.5 text-[13px] text-slate-300"
                      >
                        {route}
                      </div>
                    ))}
                  </aside>
                  <div className="rounded-2xl border border-white/10 bg-[#0b1626] p-5 shadow-[0_1px_0_rgba(255,255,255,0.08)_inset]">
                    <div className="mb-6 flex items-start justify-between gap-3">
                      <div>
                        <div className="text-base font-semibold text-white">
                          Runtime dashboard
                        </div>
                        <div className="mt-2 text-sm text-slate-400">
                          Hosted, local, and custom execution targets
                        </div>
                      </div>
                      <div
                        className="rounded-full px-3 py-1.5 text-xs font-semibold"
                        style={{
                          backgroundColor: theme.accentSoft,
                          color: theme.accentText,
                        }}
                      >
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
                          className="rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.075] to-white/[0.035] p-4"
                        >
                          <div className="text-sm font-semibold text-white">
                            {label}
                          </div>
                          <p className="mt-2 text-[13px] leading-5 text-slate-400">
                            {value}
                          </p>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 rounded-2xl border border-white/10 bg-[#07111f] p-4 shadow-[0_1px_0_rgba(255,255,255,0.07)_inset]">
                      <div className="mb-4 flex items-center justify-between text-xs font-medium text-slate-400">
                        <span>Runtime activity</span>
                        <span className="rounded-full bg-white/[0.06] px-2 py-1 text-slate-300">
                          Live
                        </span>
                      </div>
                      <div className="space-y-3">
                        <div
                          className="h-2.5 rounded-full"
                          style={{
                            background:
                              "linear-gradient(90deg, #fb923c 0%, #c2410c 100%)",
                          }}
                        />
                        <div className="h-2.5 w-4/5 rounded-full bg-orange-300/60" />
                        <div className="h-2.5 w-3/5 rounded-full bg-amber-200/60" />
                      </div>
                    </div>
                  </div>
                </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        className="border-b"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,250,245,0.35) 0%, rgba(255,255,255,0.86) 100%)",
          borderColor: theme.border,
        }}
      >
        <div className="mx-auto grid max-w-7xl gap-4 px-5 py-10 sm:grid-cols-2 sm:px-8 lg:grid-cols-4 lg:px-10">
          {stats.map(([label, value]) => (
            <div
              key={label}
              className="rounded-2xl border p-5 transition hover:-translate-y-0.5"
              style={{
                backgroundColor: "rgba(255,255,255,0.72)",
                borderColor: theme.border,
                boxShadow:
                  "0 18px 44px rgba(120, 53, 15, 0.07), 0 1px 0 rgba(255,255,255,0.86) inset",
              }}
            >
              <div
                className="text-sm font-semibold uppercase tracking-[0.12em]"
                style={{ color: theme.accent }}
              >
                {label}
              </div>
              <div className="mt-2 text-sm leading-6" style={{ color: theme.muted }}>
                {value}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ backgroundColor: theme.page }}>
        <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 lg:px-10">
          <div className="max-w-3xl">
            <p
              className="text-sm font-semibold uppercase tracking-[0.14em]"
              style={{ color: theme.accent }}
            >
              Built for agent operations
            </p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-4xl">
              Bring coordination, runtime control, and local execution into one
              workflow.
            </h2>
          </div>

          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            {productPillars.map((pillar) => (
              <article
                key={pillar.title}
                className="rounded-md border p-6 shadow-sm"
                style={{
                  backgroundColor: theme.surface,
                  borderColor: theme.border,
                }}
              >
                <h3 className="text-lg font-semibold">{pillar.title}</h3>
                <p
                  className="mt-4 text-sm leading-7"
                  style={{ color: theme.muted }}
                >
                  {pillar.description}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section
        className="border-y text-white"
        style={{ backgroundColor: theme.inverse, borderColor: theme.border }}
      >
        <div className="mx-auto grid max-w-7xl gap-10 px-5 py-20 sm:px-8 lg:grid-cols-[0.72fr_1fr] lg:px-10">
          <div>
            <p
              className="text-sm font-semibold uppercase tracking-[0.14em]"
              style={{ color: theme.inverseMuted }}
            >
              System architecture
            </p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-4xl">
              A single source tree for the platform, orchestrator, and local
              helper.
            </h2>
            <p
              className="mt-5 text-sm leading-7"
              style={{ color: theme.inverseMuted }}
            >
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
                <p
                  className="mt-3 text-sm leading-7"
                  style={{ color: theme.inverseMuted }}
                >
                  {layer.detail}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section style={{ backgroundColor: theme.surface }}>
        <div className="mx-auto grid max-w-7xl gap-8 px-5 py-20 sm:px-8 lg:grid-cols-[0.82fr_1fr] lg:px-10">
          <div>
            <p
              className="text-sm font-semibold uppercase tracking-[0.14em]"
              style={{ color: theme.accent }}
            >
              Local-first when it matters
            </p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-4xl">
              Connect local runners without opening inbound access to your
              machine.
            </h2>
          </div>
          <div className="text-sm leading-7" style={{ color: theme.muted }}>
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

      <section
        className="border-y"
        style={{ backgroundColor: theme.page, borderColor: theme.border }}
      >
        <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 lg:px-10">
          <div className="max-w-3xl">
            <p
              className="text-sm font-semibold uppercase tracking-[0.14em]"
              style={{ color: theme.accent }}
            >
              Project comparison
            </p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight sm:text-4xl">
              How OpenMacaw relates to OpenClaw and Hermes.
            </h2>
            <p
              className="mt-4 text-sm leading-7"
              style={{ color: theme.muted }}
            >
              The local docs frame OpenClaw as an execution backend, Hermes as
              a learning-layer blueprint, and OpenMacaw as the product surface
              that brings agent operations together.
            </p>
          </div>

          <div
            className="mt-10 overflow-hidden rounded-md border"
            style={{
              backgroundColor: theme.surface,
              borderColor: theme.border,
            }}
          >
            <div
              className="hidden grid-cols-[0.9fr_1.35fr_1fr_1.25fr] border-b px-5 py-3 text-xs font-semibold uppercase tracking-[0.12em] lg:grid"
              style={{ borderColor: theme.border, color: theme.muted }}
            >
              <div>Project</div>
              <div>Primary job</div>
              <div>Where it runs</div>
              <div>Best fit</div>
            </div>
            {projectComparisons.map((item) => (
              <article
                key={item.project}
                className="grid gap-4 border-b px-5 py-5 last:border-b-0 lg:grid-cols-[0.9fr_1.35fr_1fr_1.25fr]"
                style={{ borderColor: theme.border }}
              >
                <div>
                  <div
                    className="text-xs font-semibold uppercase tracking-[0.12em] lg:hidden"
                    style={{ color: theme.muted }}
                  >
                    Project
                  </div>
                  <h3 className="mt-1 text-base font-semibold lg:mt-0">
                    {item.project}
                  </h3>
                </div>
                <div>
                  <div
                    className="text-xs font-semibold uppercase tracking-[0.12em] lg:hidden"
                    style={{ color: theme.muted }}
                  >
                    Primary job
                  </div>
                  <p
                    className="mt-1 text-sm leading-6 lg:mt-0"
                    style={{ color: theme.muted }}
                  >
                    {item.role}
                  </p>
                </div>
                <div>
                  <div
                    className="text-xs font-semibold uppercase tracking-[0.12em] lg:hidden"
                    style={{ color: theme.muted }}
                  >
                    Where it runs
                  </div>
                  <p
                    className="mt-1 text-sm leading-6 lg:mt-0"
                    style={{ color: theme.muted }}
                  >
                    {item.runs}
                  </p>
                </div>
                <div>
                  <div
                    className="text-xs font-semibold uppercase tracking-[0.12em] lg:hidden"
                    style={{ color: theme.muted }}
                  >
                    Best fit
                  </div>
                  <p
                    className="mt-1 text-sm leading-6 lg:mt-0"
                    style={{ color: theme.muted }}
                  >
                    {item.fit}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section
        className="border-t"
        style={{ backgroundColor: theme.surfaceSoft, borderColor: theme.border }}
      >
        <div className="mx-auto grid max-w-7xl gap-8 px-5 py-14 sm:px-8 lg:grid-cols-[1fr_410px] lg:items-start lg:px-10">
          <div>
            <h2 className="text-2xl font-semibold">
              Start with the dashboard or inspect the source.
            </h2>
            <p className="mt-2 text-sm" style={{ color: theme.muted }}>
              OpenMacaw is moving toward a polished open-source launch while
              remaining usable for active local development.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <a
                href={appUrl}
                className="inline-flex items-center gap-2 rounded-md px-5 py-3 text-sm font-semibold transition hover:opacity-90"
                style={primaryButtonStyle}
              >
                Open app
                <ArrowIcon />
              </a>
              <a
                href="https://github.com/kmgrassi/OpenMacaw"
                className="rounded-md border px-5 py-3 text-sm font-semibold transition hover:opacity-80"
                style={outlineButtonStyle}
              >
                GitHub repository
              </a>
            </div>
          </div>

          <div
            className="rounded-md border p-4"
            style={{
              backgroundColor: theme.surface,
              borderColor: theme.border,
            }}
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold">Theme settings</h3>
                <p className="mt-1 text-xs" style={{ color: theme.muted }}>
                  Preview launch palettes before choosing the production look.
                </p>
              </div>
              <span
                className="rounded-md px-2 py-1 text-xs font-semibold"
                style={{
                  backgroundColor: theme.accentSoft,
                  color: theme.accentText,
                }}
              >
                {theme.name}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {themes.map((preset, index) => {
                const selected = index === themeIndex;

                return (
                  <button
                    key={preset.name}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setThemeIndex(index)}
                    className="flex min-h-12 items-center gap-2 rounded-md border px-3 py-2 text-left text-sm font-medium transition hover:opacity-80"
                    style={{
                      backgroundColor: selected
                        ? preset.accentSoft
                        : theme.surface,
                      borderColor: selected ? preset.accent : theme.border,
                      color: selected ? preset.accentText : theme.text,
                    }}
                  >
                    <span
                      className="h-4 w-4 flex-none rounded-full border"
                      style={{
                        background: `linear-gradient(135deg, ${preset.accent} 0%, ${preset.primary} 55%, ${preset.surfaceSoft} 100%)`,
                        borderColor: selected ? preset.accent : theme.border,
                      }}
                    />
                    <span>{preset.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
