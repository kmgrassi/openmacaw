# Planner Chat Dashboard and Work Items Routing Scope (Platform)

Supersedes `docs/active/single-chat-planning-agent-dashboard-scope.md`.

## Premise

The planning agent is the product's primary user-facing agent. A normal
workspace user should land in a minimal dashboard centered on the planning
agent chat, not on an agent picker and not on a plan board.

Plans and work items are still important, but they are secondary navigation
surfaces. They let the user inspect what the planner has created, what is
queued or running, and how the orchestrator is routing work through the
canonical `work_items` table. They should be easy to reach, but they should
not become the central focus of the dashboard.

The orchestrator (parallel-agent-runtime) already routes work via
`work_items`. The platform's job is to make the planner chat the front door,
improve the existing plans/work-items views, and keep background agents out of
the normal workflow path.

## Why The Previous Framing Was Wrong

`single-chat-planning-agent-dashboard-scope.md` proposed:

- a default mode where only the planning agent's chat is visible,
- a debug mode toggle that exposes all background agents,
- planner-specific transcript merging of worker summaries,
- hiding `AgentSwitcher` to prevent the user from chatting with workers.

The intent was right — the dashboard was cluttered, the planner was the
natural entry point. But the implementation framing bolted special UI plumbing
onto one specific agent, and asked the runtime to bolt matching plumbing on
its side (parent/child run linkage, message visibility taxonomy, summary
injection).

The cleaner story: **the dashboard is planner-chat first, and plans/work items
are a navigable inspection surface fed by the canonical `work_items` table.**
That gives the user the "what is my planner doing for me" view without
inventing a chat-merging protocol or turning the plan board into the product
home.

## Product Model

### Workspace Landing

- The workspace landing page defaults to the planning agent chat.
- The dashboard is intentionally minimal: planner transcript, composer,
  runtime/setup status, and compact links to plans and work items.
- The user should not need to choose between manager, planning, coding, or
  specialist agents before asking for work.
- Normal workflow starts by talking to the planner. The planner owns user
  clarification, decomposition, delegation, status summaries, and final
  explanations.
- The chat component can remain technically reusable, but the user-facing
  route resolves to the planning agent rather than exposing every agent as a
  peer chat target.

### Background Agent Navigation

Background agents should not compete with the planner chat. For normal users,
workers are implementation detail surfaced through plan/work-item status, not
as first-class chat destinations. This intentionally removes the full agent
list as a visible top-level navigation element in the normal workflow.

Required navigation contract:

- the workspace landing page defaults to planner chat;
- primary navigation omits the full agent list by default;
- plans and work items remain directly reachable from primary navigation;
- background agents are reachable only through explicit operational surfaces
  such as settings, debug mode, or support/deep links;
- deep links to selected-agent dashboards keep working for debugging,
  operations, and support;
- agent transcripts, gateway state, runtime cards, run history, tool calls,
  and logs remain available through the debug/agent surface.

### Plans And Work Items

The plans/work-items surface is an inspection and navigation view rendered
from the canonical `work_items` table (via Supabase reads, the same path
everything else uses). The repo already has this surface at `/work`, plus
plan creation/detail routes. This scope should improve those views rather than
invent a second primary dashboard.

For each plan:

- show the plan's `intent`, `default_runner_kind`, `default_model`,
  `schema_version`, and `created_at`;
- list its `work_items` grouped by `state` (Kanban or table);
- show per-item `repository`, `runner_kind`, `priority`, `depends_on`,
  `completion_gates`, `instructions`;
- link each item to the orchestrator run that processed it (if any),
  surfacing run status, tool calls, and outputs — pulled from existing
  run/observability tables.

When the planning agent finishes a turn that wrote new plans or work items,
the plans/work-items view updates live the same way other Supabase-backed
views do.

### Where The Old Doc's Concerns Land

- **"User shouldn't have to choose an agent"** → solved by making planner chat
  the workspace landing surface. The user starts by talking to the planner.
- **"Background workers should be visible without dominating the chat"** →
  solved by the work-items view and compact dashboard status; each item shows
  its run status. No need to inject summaries into the planner transcript.
- **"Debug mode for power users"** → keep the existing debug primitives
  (`GatewayDebugPanel`, `RuntimeDebugCard`, `AgentDashboardPanel`). They work
  unchanged.

## Current State

Useful pieces that stay:

- `apps/web/src/routes/Dashboard.tsx` — selected-agent dashboard scaffolding.
- `apps/web/src/components/dashboard/RuntimeChatPanel.tsx`,
  `apps/web/src/components/ChatView.tsx` — uniform chat for any agent,
  reused for the planner-first dashboard.
- `apps/web/src/routes/WorkspaceItems.tsx`,
  `apps/web/src/routes/WorkspaceItems/*`, `apps/web/src/pages/plans/NewPlan.tsx`,
  and `apps/web/src/pages/plans/PlanDetail.tsx` — existing plans/work-items
  surfaces that should be improved, not duplicated.
- `apps/web/src/components/AppShell.tsx`, `AgentSwitcher.tsx` — keep the
  switcher for explicit agent/debug surfaces; do not make it part of default
  navigation.
- `apps/web/src/components/GatewayDebugPanel.tsx`, `RuntimeDebugCard`,
  `AgentDashboardPanel` — keep, no changes needed for this scope.

Pieces that change or land new:

- a workspace landing route that resolves to the planning agent chat.
- enhancements to the existing `/work` plans/work-items view backed by
  `work_items` / `plan` Supabase reads.
- navigation: the workspace's default landing surface becomes planner chat;
  plans and work items are directly reachable but secondary; background-agent
  chats move behind explicit debug/settings/support paths.
- the existing single-chat doc and its in-flight UI direction get removed.

## How Plans And Work Items Stay In Sync With Orchestration

The plans/work-items view reads from the canonical `work_items` table — the
same table the runtime orchestrator polls for dispatch. The platform does not
push work to the orchestrator and does not receive work-completion events from
it; both sides read and write the table.

Flow on a typical user interaction:

1. User chats with the planner agent. The planner's `task.create` tool
   call writes a `work_items` row (in the runtime, via PostgREST).
2. The new row is visible to the platform immediately through Supabase
   reads.
3. The runtime orchestrator picks up the row on its next poll tick
   (default ~30 seconds; see runtime scope doc for the dispatch path).
4. As the dispatched run progresses, it writes status updates back to
   the row's `state`, related run rows, and the broker log — all
   readable by the platform.

The plans/work-items view does not need a special API channel to the runtime.
Supabase realtime (or react-query polling) over `work_items` and the existing
run/observability tables is sufficient.

## Test Cases

### Unit: plans/work-items view renders grouped work items

```
given:  a Supabase fixture with
        - 1 plan { id: P, intent: "Refactor login", default_runner_kind: "codex" }
        - 5 work_items linked to P, mixed states (draft, running, done)
when:   the plans/work-items view renders with workspaceId = W
then:   the plan header shows intent and default_runner_kind
and:    items are grouped by state with the right counts
and:    each item row shows its repository and runner_kind chips
```

### Unit: per-item runner_kind override is reflected in the chip

```
given:  a plan with default_runner_kind = "codex" and one item with
        runner_kind = "local_relay"
when:   the plans/work-items view renders the plan
then:   the overridden item's chip shows "local_relay" (not "codex")
and:    sibling items inherit and show "codex"
```

### Integration: live refresh on new work_item insert

```
given:  the plans/work-items view mounted, subscribed to work_items realtime
        for the plan's workspace
when:   a new work_items row is inserted (simulated Supabase channel
        event) belonging to a visible plan
then:   within 1 second, a new row appears in the rendered board with
        the correct state column and chips
```

### API contract: plans/work-items read endpoint

```
given:  authenticated user in workspace W
when:   GET /api/workspaces/W/plans
then:   response is 200 with body shape
        { plans: [{
            id, intent, defaultRunnerKind, defaultRepository,
            schemaVersion, createdAt, updatedAt,
            workItems: [{
              id, identifier, title, state, priority,
              runnerKind, repository, dependsOn, completionGates,
              latestRun: { id, status, startedAt, endedAt } | null
            }]
          }]
        }
and:    snake_case is converted to camelCase at the route boundary per
        the case-conventions rule in CLAUDE.md
```

### Browser smoke: planner chat → plans/work-items update

Manual smoke (extends the existing planner work-item smoke):

1. Open the workspace landing page; verify the planner chat is the central
   surface.
2. Ask the planner to "create a plan with three tasks, one in each of repo-a,
   repo-b, repo-c."
3. Navigate to the plans/work-items view.
4. Within ~1 second (realtime) the new plan and its three items appear,
   each grouped under the initial state with the correct repository
   chip.
5. After one orchestrator poll interval (~30 seconds, see runtime
   scope), the items begin transitioning state as runs are dispatched
   — visible without a manual page refresh.

### Negative: missing run state degrades cleanly

```
given:  a work_item whose latest_run is null (never dispatched, or
        orchestrator hasn't polled yet)
when:   the plans/work-items view renders that row
then:   the row shows "pending dispatch" (or similar) instead of run
        status, and does not error
```

## Proposed Platform Work

### PLATFORM-1 — Correct The Dashboard Product Direction

- The superseded `single-chat-planning-agent-dashboard-scope.md` was removed
  in a prior PR; do not reintroduce it.
- Preserve the useful part of that direction: the normal dashboard is centered
  on the planning agent chat.
- Drop any in-progress UI work that merges worker output into planner chat or
  invents parent/child transcript plumbing. Worker progress is represented
  through plans, work items, and debug surfaces.
- Do not present background agents as peer chat destinations in default
  navigation.

### PLATFORM-2 — Plans/Work Items Read Paths

Add Supabase queries/hooks for:

- `plan` rows scoped to the active workspace, ordered by `updated_at`;
- `work_items` joined to their plan, grouped by `state`;
- per-item run status pulled from existing run/observability tables.

These belong alongside the existing Supabase data layer (whatever pattern
`AgentDashboardPanel` already uses for run reads).

### PLATFORM-3 — Plans/Work Items UI

Improve the existing `/work` route and related plan pages rather than creating
a second primary dashboard. For each plan:

- header row: title, intent, defaults, status.
- work-items table or Kanban with columns/groups by `state`.
- per-row chips for `runner_kind`, `repository`, `priority`.
- expand-row reveals `instructions`, `depends_on`, `completion_gates`, and
  the latest run if dispatched.

This is the secondary surface the user opens when they ask "what work has my
planner created, and where is it right now?" — without a custom chat protocol.

### PLATFORM-4 — Workspace Landing

Update workspace landing routing so planner chat is the default. Plans and
work items should be one nav click away. Background agents should be hidden
from default navigation and reachable only through clear settings/debug/support
paths that open the existing selected-agent dashboard/chat route.

Do not delete or disable the selected-agent route, `AgentSwitcher`,
`AgentDashboardPanel`, `GatewayDebugPanel`, or `RuntimeDebugCard`; move them
out of the normal workflow path.

### PLATFORM-5 — Live Refresh

Wire Supabase realtime (or react-query polling, whichever the codebase already
uses for run state) so plan + work-items updates appear without a manual
refresh. The planner writing a new work item should be visible within a second
or two after the user opens the plans/work-items view.

## Non-Goals

- No special chat-merge UI for planner transcripts.
- No plan-board-first workspace landing. Plans and work items are important,
  but the central dashboard surface is planner chat.
- No normal-workflow access to background-agent chat. Per-agent inspection
  stays available through explicit settings/debug/support paths.
- No parent/child run linkage UI; the relationship is "this work item ran;
  here is its run." That's already enough.

## Cross-Repo Pieces

- **parallel-agent-runtime**: planner tool calls produce work_items with
  routing fields. See runtime scope doc.
- **harper-server**: migration adds `work_items.runner_kind` and
  `work_items.repository_id` (or equivalent FK) so the plans/work-items view
  can render and filter without parsing `metadata` JSON. See harper-server
  companion PR.

## Acceptance Criteria

- A workspace user lands on a minimal planner-chat dashboard.
- Plans and work items are directly reachable from navigation, but they are
  not the central dashboard surface.
- The plans/work-items view renders without parsing `metadata` JSON for
  routing fields once the harper-server migration lands.
- The normal user-facing chat target is the planning agent.
- Background agents are hidden from normal navigation but remain reachable
  through explicit settings/debug/support paths, including direct
  selected-agent dashboard links.
- The superseded `single-chat-planning-agent-dashboard-scope.md` is
  removed.

## Open Questions

- Should the planner-chat route be `/`, `/dashboard`, or a workspace-scoped
  route? Default: keep `/` as the authenticated landing route and resolve it
  to the workspace planning agent.
- Should `/work` remain the route for plans/work items, or should it be
  renamed to `/plans` while preserving route redirects? Default: keep `/work`
  for this scope and avoid route churn.
- How should we render plans the user has not yet seen? A "new since last
  visit" affordance is nice but out of scope here.
