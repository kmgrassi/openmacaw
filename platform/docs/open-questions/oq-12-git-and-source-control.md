# OQ-12: Git/GitHub workflow and source-control strategy

> Open question (added 2026-04-25):
>
> "How to use Git and GitHub appropriately with this. For example:
> How do we trigger a code review? When does the code review get
> triggered? How does that loop back in? Do we even use 'git as
> source'? Or, since we're moving so fast, do we use some other
> source, or some other method, for source control?"

## ✅ Decision (2026-04-25, revised): manager-agent reconciler, not streaming events

The original streaming-event design (every webhook → runner_event
row → next-turn dispatch) is **rejected** in favor of a
**manager-agent reconciler**.

**Why:** GitHub events are too numerous to dispatch on (cost,
LLM context overflow), and individual events go stale — an
event might fire and then be made irrelevant by a later event,
so reasoning from the stream is fundamentally harder than
reasoning from the current state.

**The replacement:** a `Runner.Manager` agent runs on a schedule
(default: every 5 minutes, configurable). On each tick, it
reads the **current state** of every active task's artifacts
(PR state, gate results, comments since last check, dependency
state) and decides per task what action to take. It dispatches
author/reviewer agents, merges PRs, escalates, or snoozes —
same way a human team lead checks in on twelve in-flight PRs
twice a day, not by reading every notification.

**Webhooks are kept but demoted** from "primary input" to
"wake-up signals." A webhook arrival doesn't trigger a runner
turn directly. It just bumps the affected work_item's
`next_poll_at` to now, so latency-sensitive events
(`@-mentions`, gate-greens, security alerts) get fast-lane
attention without us giving up the convergent-state benefits.

**Why this is better in three ways:**

1. **Convergent state beats event streams for correctness.** A
   snapshot is always right; an event becomes stale the moment
   a follow-up arrives. Missed webhooks are self-healing —
   the next poll catches them.
2. **An order of magnitude less LLM dispatch.** One manager
   check per work_item per 5 minutes beats one runner turn per
   review comment by 10–100×.
3. **Generalizes beyond GitHub for free.** The manager loop
   doesn't care whether the artifact is a PR, a Figma project,
   a video render, a Linear ticket, or a Notion page. Each
   artifact type just needs a `read_state` adapter. See
   _[Per-vertical generalization](#per-vertical-generalization)_
   below.

The manager is **just another runner kind** in our existing
abstraction. It's routed via the same `routing_rule` table
([OQ-03](./oq-03-routing-config-schema.md)), uses credentials
from the same `credential` table ([OQ-04](./oq-04-per-task-model-overrides-credentials.md)),
and emits escalation events through the shared escalation policy.
What's special is its prompt and its toolset.

The rest of this doc spells it out.

## What's already shipped (don't reinvent)

The platform repo already has a working GitHub webhook handler.
This doc builds on it; we are NOT starting from scratch.

- `apps/api/src/routes/work-items.ts` accepts inbound GitHub
  webhooks, verifies `X-Hub-Signature-256`, and routes by
  `x-github-event`.
- Currently handled events: **`issues`** and **`pull_request`**.
  Both upsert canonical `work_item` (formerly `task`) rows with
  `source = 'github'`. (Confirmed in
  `apps/api/src/services/work-item-ingest.test.ts`.)
- The signature-verification, replay-protection, and
  workspace-routing infra is reusable for any additional event
  types we add.

What's **missing for the auto-loop** described below — and what
this doc proposes adding — is handling for review and
check-result events plus the @-mention pattern. None of those
exist yet.

## What we know

- For **code work**, Git/GitHub is the universally adopted source
  of truth. PR review is a well-understood human ceremony with rich
  tooling. Replacing it would be a frame-the-rest-of-the-industry-
  uses-this kind of fight we shouldn't pick.
- For **non-code work** (video, design, ops runbook execution), Git
  is a poor fit:
  - Binary diffs are useless.
  - File sizes blow past Git's comfort zone.
  - Reviewers don't read diffs — they watch the video, look at the
    Figma, check the dashboard.
- Speed of iteration is real but doesn't justify replacing Git for
  code. Twelve agents producing twelve PRs in parallel is not
  _fewer_ PRs than today; it's _more_ PRs that need a mechanism for
  reviewing them efficiently. The bottleneck is review tooling, not
  storage.

## Strategy: dual-track, with Git as code's spine

### Code track — GitHub-first, opinionated

1. **Each task gets its own branch.** Naming:
   `agent/<workspace>/<plan>/<task-id>`. The orchestrator owns this
   branch — the agent commits, the orchestrator may rebase/squash.
2. **Each task produces exactly one PR**, opened by the agent.
   1:1 task↔PR mapping. The orchestrator records `pr_url` on
   `work_item`.
3. **Self-review runs first**, before opening the PR. The
   authoring agent reads its own diff against the workspace review
   checklist, fixes obvious issues. (Cheap pre-filter.)
4. **PR opens** in `draft` state if any gate hasn't run yet, or
   directly in `ready` if all gates already passed locally.
5. **Peer review fires automatically** when:
   - The PR is `ready`, AND
   - Workspace `gateway_config.body.gates.policies_by_kind.code`
     lists `peer-review` as a required gate (it does by default
     — see [OQ-07](./oq-07-auto-merge-gate-selection.md)).
   - A _separate_ runner is dispatched (different model where
     possible) and posts review comments via the GitHub API.
6. **External reviews** (a human teammate's comments) loop back via
   GitHub webhooks. The existing handler in
   `apps/api/src/routes/work-items.ts` already does signature
   verification and event routing — we extend it to handle
   review-shaped events as `runner_event` translations:
   - `pull_request_review.submitted` → `runner_event: :review_submitted`
   - `pull_request_review_comment` (action `created`) → `runner_event: :review_comment`
   - `check_run.completed` (CI) → `runner_event: :check_complete`
   - `issue_comment.created` (when the comment matches a
     configured `@<bot-name>` mention — see _[@-mention triggers](#mention-triggers)_
     below) → `runner_event: :mention_received`
   - The runner consumes the event on its next turn and either
     pushes a fix-up commit or escalates if it can't address.

   None of the four event handlers above exist yet — they're new
   work. The shared signature-verification and workspace-routing
   plumbing already exists; we're adding event-type-specific
   ingestion paths.

7. **Auto-merge** fires only when all required gates are green and
   workspace policy allows ([OQ-07](./oq-07-auto-merge-gate-selection.md)).
   Default in private beta is auto-merge **off** — the agent
   prepares the merge and waits for one human click.

### Non-code track — object-storage-first

For verticals where the artifact isn't code:

1. Outputs land in **object storage** (S3-compatible) at a
   workspace-scoped bucket. Versioned bucket, immutable keys.
2. `work_item.metadata.outputs[]` is the canonical pointer:
   ```json
   "outputs": [
     { "kind": "video", "uri": "s3://harper-out/.../final.mp4",
       "version": "v3", "size_bytes": 142_000_000 }
   ]
   ```
3. Review of non-code outputs happens **in our dashboard** (we
   show the video, render the Figma, etc.) — there is no GitHub
   equivalent for "watch this 90-second cut and tell me if it's
   right." This is one of the things the platform UI exists to
   provide.
4. For text-and-markdown work that _is_ git-friendly (research
   reports, documentation), we still default to GitHub — same
   mechanism as code.

## When does a code review get triggered?

**Triggered automatically on PR-open**, not at task-completion:

- The agent considers the task "done from its perspective" when it
  has a green local lint+tests run and a self-review pass.
- It opens the PR. Opening the PR is what fires peer-review (via
  the gate runner) and external CI (via the existing GitHub
  Actions workflow).
- Review feedback (whether from the peer-review agent or a human)
  flows back via webhook → orchestrator → next runner turn.
- The task isn't truly `done` until the PR merges (auto or human).

This decouples "the agent stopped emitting tokens" from "the work
is accepted."

## Per-vertical generalization

The manager-agent reconciler is the same loop regardless of what
artifact a task produces. Each artifact type just needs a
`read_artifact_state` adapter — the rest of the machinery is
unchanged.

| Vertical                | Artifact                       | `read_artifact_state` reads…                                     | Wake-up signals                                        |
| ----------------------- | ------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------ |
| Code (GitHub)           | PR                             | PR status, review verdicts, check_run results, comments          | GitHub webhooks                                        |
| Code (GitLab/Bitbucket) | MR                             | MR status, approvals, pipelines, threads                         | GitLab/Bitbucket webhooks                              |
| Video editing           | Render job                     | DaVinci/Premiere render queue state, output spec compliance      | DaVinci scripting events; manual `harper-runtime` push |
| Design                  | Figma project                  | Figma file version, plugin-bridge annotations, comments          | Figma webhooks                                         |
| Research / writing      | Notion / Google Doc            | Doc revision history, comments, share state                      | Notion / Google Drive webhooks                         |
| Ops / SRE runbook       | Internal ticket + system state | Ticket status, runbook step results, target system telemetry     | Ticket webhooks; metric thresholds                     |
| Browser automation      | Job result blob                | Captured outputs (screenshots, scrape results) in object storage | Local-runtime daemon push                              |

The manager's prompt is the same shape for all of these:
_"Here's a list of due tasks. For each one, read the current
state and decide the smallest next action."_ Only the
`read_artifact_state` tool implementation differs per vertical.

This is why we don't end up with `Manager.GitHub`,
`Manager.Figma`, `Manager.Video` as separate runners. There's
**one manager runner** per workspace, with adapters behind
`read_artifact_state` selected by `work_item.kind`.

## @-mention triggers {#mention-triggers}

GitHub Apps like Claude's GitHub bot, OpenAI Codex's GitHub bot,
Cursor, etc. already follow a well-established UX: a human or
another agent types `@<bot-name>` in a PR comment and the bot
responds. In the manager-agent model, an `@-mention` is a
**wake-up signal that bumps `next_poll_at` to now**, and the
manager dispatches the matched runner on its very-soon tick.
This preserves the conversational UX (response in seconds) while
keeping the architecture uniform.

### What happens on a mention

1. `issue_comment.created` webhook fires.
2. Layer 1 handler: append to `event_log`. Comment body matched
   against the workspace's `mention_handler` table:
   ```sql
   create table mention_handler (
     id            uuid primary key default gen_random_uuid(),
     workspace_id  uuid not null references workspace(id) on delete cascade,
     mention       text not null,                                 -- e.g. '@harper-claude', '@harper-codex'
     runner_kind   text not null,
     model         text,
     credential_id uuid references credential(id),
     intent        text not null check (intent in (
                     'review', 'add_tests', 'expand_explanation', 'rerun_gates', 'custom'
                   )),
     prompt_template_id uuid references prompt_template(id),       -- optional override
     enabled       boolean not null default true,
     unique (workspace_id, mention)
   );
   ```
3. Match found → bump `work_item.next_poll_at = now()`. The
   manager-agent loop wakes (within `min_cadence`, default 60s,
   configurable lower for mention-driven workspaces). On its
   tick the manager sees the mention in `events_since_last_poll`
   and dispatches the matched runner intent with the comment body
   and PR context.
4. The dispatched runner posts its response **back as a PR
   comment via the GitHub API**. That comment becomes part of
   the PR's review conversation, exactly the way humans expect.
5. The runner's response also flows through the existing
   webhook handler (it'll fire `issue_comment.created` again,
   but with the bot's own user as author — we filter to avoid
   loops).

The manager being a layer between the mention and the dispatch
adds 0–60s of latency in the worst case. For most workspaces
this is invisible; for workspaces that want sub-10s mention
response, drop `min_cadence` to 10s.

### Three concrete uses

1. **Human-triggered double-take.** A teammate reads the agent's
   PR, isn't sure about a conditional, comments
   `@harper-claude can you double-check the off-by-one in line 47?`.
   Orchestrator dispatches Claude with that intent; Claude
   replies inline.
2. **Cross-model peer review on demand.** PR auto-passed our
   default peer-review (model A reviewing model A's diff). A
   reviewer wants a second opinion: `@harper-codex please review
for performance issues`. Orchestrator dispatches Codex; we
   get the cross-model second opinion without changing default
   policy.
3. **Re-run gates without a re-push.** CI was flaky;
   `@harper-bot rerun gates` triggers the gate runner to re-fetch
   `check_run` status without the agent having to push a no-op
   commit.

### Why this is complementary to orchestrator-dispatched review

| Trigger                 | Source                            | Default?                                                | Cost                      |
| ----------------------- | --------------------------------- | ------------------------------------------------------- | ------------------------- |
| Orchestrator-dispatched | Auto, on PR-open                  | **Yes** ([OQ-07](./oq-07-auto-merge-gate-selection.md)) | Counted on every PR       |
| @-mention               | Human or another bot, in comments | Off by default — opt-in per workspace                   | Counted only when invoked |

Both feed back into the orchestrator the same way (webhook →
`runner_event :review_submitted` or `:mention_received`). The
runner doesn't know which trigger fired it; the orchestrator
just reports the source in the audit log.

### Anti-loop

- A bot's own comment never re-triggers a mention, even if the
  comment text contains `@<bot-name>`. Filter by GitHub user ID
  before pattern-matching.
- Rate-limit per `(workspace_id, mention, pr_number)`: max 5
  invocations per hour. Beyond that, post a one-line
  "rate-limited; mention again in N minutes" reply and stop.
- `mention_handler.enabled = false` per workspace disables the
  whole pattern — useful for orgs that don't want any
  bot-triggered actions.

## How event handling actually works (manager-agent reconciler)

The architecture has three layers. Only the middle layer
involves LLMs, and even then in a _bounded_ way — one manager
turn per work_item per cadence, not one turn per webhook event.

```
                 ┌─────────────────────────────────────┐
                 │   Layer 1: Wake-up signals          │   no LLM
                 │   (webhooks, scheduled ticks,       │   plain code
                 │    explicit user actions)           │
                 └────────────────┬────────────────────┘
                                  │ bumps next_poll_at
                                  ▼
                 ┌─────────────────────────────────────┐
                 │   Layer 2: Manager-agent reconciler │   1 LLM turn
                 │   - reads current state of artifact │   per check
                 │   - decides per-task next action    │
                 │   - emits dispatch / merge / escalate
                 │     / snooze decisions              │
                 └────────────────┬────────────────────┘
                                  │ tool calls
                                  ▼
                 ┌─────────────────────────────────────┐
                 │   Layer 3: Author / reviewer / etc. │   N LLM turns
                 │   runners that do the actual work   │   only when
                 │                                     │   manager says so
                 └─────────────────────────────────────┘
```

### Layer 1: wake-up signals (deterministic, no LLM)

The platform's existing webhook handler in
`apps/api/src/routes/work-items.ts` keeps doing what it does
today — verify HMAC, parse, persist. The change: instead of
synthesizing a `runner_event` for the runner to consume, it does
exactly two things:

1. **De-dupe and append to `event_log`** (audit trail; cheap).
2. **Bump `work_item.next_poll_at = now()`** if the event is
   "interesting" (a review submitted, a check completed, a
   mention received, a security alert). Boring events
   (assignee changed, label added) update `event_log` but don't
   bump.

The "interesting" classification is a tiny static dispatch
table — explicitly NOT an LLM call. We're not trying to be
clever here; we're just deciding "should the manager look
sooner than the scheduled tick?".

```sql
create table event_log (
  id              uuid primary key default gen_random_uuid(),
  work_item_id    uuid references work_item(id) on delete cascade,
  workspace_id    uuid not null references workspace(id) on delete cascade,
  source          text not null,                 -- 'github_webhook' | 'mention' | 'gate_runner' | 'mcp' | 'manual'
  source_event_id text,                           -- e.g. GitHub delivery UUID, for idempotent dedupe
  kind            text not null,                  -- raw event kind from source
  raw_payload     jsonb not null,
  was_interesting boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (source, source_event_id)
);

create index on event_log (work_item_id, created_at desc);

alter table work_item
  add column next_poll_at timestamptz,
  add column last_polled_at timestamptz,
  add column poll_cadence_seconds int not null default 300,    -- 5 min default
  add column manager_runner_id uuid references credential(id); -- which credentialed manager polls this
```

The manager reads `event_log` on its turn — that's its window
into "what happened since I last looked." But it's reading a
log, not consuming events one-by-one, so a missed event or a
stale event doesn't break anything. The current state of the
artifact (next layer down) is the source of truth; the log is
context.

### Layer 2: the manager-agent reconciler

The manager is a `Runner.Manager` runner kind in the existing
abstraction ([runner-abstraction.md](../runner-abstraction.md)).
Same lifecycle, same routing, same credential resolution. What's
distinctive:

- **Schedule.** The manager runs on a clock. Default: each
  workspace has a manager session that wakes every
  `min_cadence` seconds (default 60s) and processes any
  work_items where `next_poll_at <= now()`. Per-work-item
  `poll_cadence_seconds` controls how often a _non-bumped_
  task is checked (default 300s = 5 min).
- **Stateless across ticks.** The manager reconstructs context
  from the database each tick. It does not maintain a
  persistent conversation. Cheap, predictable token usage.
- **Toolset.** The manager has _meta-level_ tools that act on
  tasks, not within them. See below.

#### The manager's tools

Same function-calling pattern as `create_plan`
([OQ-01](./oq-01-plan-format.md)) — typed function-call schema, no
text-to-JSON parsing. The original version of this plan listed
older manager-specific artifact tool names. Those names are deprecated; current platform defaults grant catalog tools such as `git.run` and `scheduled_task.*`.

| Tool                                      | Purpose                                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `read_artifact_state(work_item_id)`       | Returns the current state of the artifact (PR, Figma project, video render, …). Manager calls this for each task it's checking on.      |
| `read_recent_events(work_item_id, since)` | Returns recent `event_log` rows — what happened since last poll.                                                                        |
| `merge_pr(work_item_id)`                  | Performs the merge if `auto_merge_policy` allows ([OQ-07](./oq-07-auto-merge-gate-selection.md)). Returns the gate-resolution snapshot. |

#### What the manager actually sees on a tick

```jsonc
{
  "system": "You are a manager agent responsible for moving tasks forward in a workspace. For each task, decide the smallest next action that brings it closer to done.",
  "workspace": {
    /* workspace context */
  },
  "due_tasks": [
    {
      "work_item_id": "...",
      "title": "Clean up unused imports in src/components/",
      "current_state_summary": "PR #142 open, 1 review (request_changes from alice), 2 line-comments, lint green, tests green, last commit 18m ago",
      "last_polled_at": "2026-04-25T15:55:00Z",
      "events_since_last_poll": [
        {
          "kind": "pull_request_review.submitted",
          "summary": "alice: request_changes — see comments",
        },
        { "kind": "pull_request.review_comment.created", "count": 2 },
      ],
    },
    /* ...up to N more tasks in this batch... */
  ],
  "tools": ["read_artifact_state", "read_recent_events", "merge_pr"],
}
```

Note that the manager doesn't see the _content_ of every event
upfront. It sees a summary. If it needs detail, it calls
`read_artifact_state` or `read_recent_events`. This keeps the
manager's input small and predictable in cost regardless of how
chatty a PR has been.

#### Idempotency and convergence

The manager is a **convergent reconciler**, K8s-controller
style. Two important properties:

- **Idempotent.** Running the same tick twice on the same state
  produces the same decisions. The manager's tool calls are
  themselves idempotent (`merge_pr` is a no-op on an already-
  merged PR; runner dispatch for an intent already in flight
  short-circuits).
- **Self-healing.** A missed webhook is harmless — the next
  scheduled tick will read the current state and catch up.
  This means we don't need elaborate webhook re-delivery
  guarantees.

### Layer 3: author / reviewer / etc. runners

These are unchanged from the existing runner abstraction. The
manager dispatches them through the runtime with an intent
("address review feedback", "review this diff", "implement this
plan task"). They do their work, post their output (commit and
push to a PR; render and upload a video; etc.), and return.
They never poll; they're always reactive to a manager dispatch
or an explicit user-initiated action.

### Per-event-kind disposition (revised)

| Event kind                                         | Layer 1 reaction                  | Layer 2 (manager) sees on next tick     | Typical manager decision                                 |
| -------------------------------------------------- | --------------------------------- | --------------------------------------- | -------------------------------------------------------- |
| `check_run.completed` (green)                      | bump `next_poll_at`               | "all gates green for PR #142"           | `merge_pr` if policy allows                              |
| `check_run.completed` (red)                        | bump `next_poll_at`               | "tests failed for PR #142"              | dispatch a fix-tests runner or escalate                  |
| `pull_request_review.submitted`, `request_changes` | bump                              | "review requesting changes"             | dispatch an address-review runner                        |
| `pull_request_review.submitted`, `approve`         | bump                              | "review approved"                       | `merge_pr` if other gates green                          |
| `pull_request_review_comment` (action `created`)   | bump (debounced 30s)              | "N comments since last poll"            | one address-review runner dispatch covering all comments |
| `@-mention` matched in `mention_handler`           | bump (immediate)                  | "user pinged @harper-claude for review" | dispatch the matched runner intent                       |
| Stuck task (no progress in K polls)                | n/a (manager detects)             | "no progress in 4 ticks"                | `escalate_to_human`                                      |
| Bot's own comment                                  | logged but NOT bumped (anti-loop) | only as background context              | usually nothing                                          |

### Cost and latency

| Dimension                          | Streaming-event design (rejected) | Manager-agent design (chosen)                                |
| ---------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| LLM dispatch volume                | 1 per interesting webhook event   | 1 per work_item per `poll_cadence_seconds`                   |
| Cost @ 100 active tasks, chatty    | ~50–500 LLM calls / hour          | ~12 manager calls per task / hour = stable, capped           |
| Latency for `@-mention`            | seconds                           | seconds (webhook bumps `next_poll_at` to now)                |
| Latency for gate-green → merge     | seconds                           | seconds–minutes (webhook bumps; `min_cadence` floors at 60s) |
| Latency for arbitrary state change | seconds                           | up to `poll_cadence_seconds` (default 5 min)                 |
| Robustness to missed events        | requires replay logic             | self-healing (next tick reads current state)                 |
| Cost predictability                | linear in webhook volume          | linear in active-task count                                  |

For `@-mention` and gate-green cases the latency is
near-equivalent because the webhook bumps the poll. For
non-bumped state changes (someone edits a comment without it
being interesting), latency is bounded by the poll cadence, and
that's fine — these are exactly the cases where waiting is
correct.

## How review loops back in (manager-agent edition)

```
author runner commits → opens PR
   ↓
webhook fires → Layer 1: append to event_log, bump next_poll_at
   ↓
( manager scheduler runs on tick )
   ↓
manager reads artifact state + recent events for this work_item:
   "PR open, peer-review needed, no CI yet"
   ↓
manager dispatches a peer-review runner
   ↓
reviewer runner reviews, posts comments via GitHub API
   ↓
webhook fires → Layer 1: bump next_poll_at
   ↓
manager next tick:
   "review approve, gates green" → calls merge_pr
                                  OR
   "review request_changes"      → dispatches an address-review runner
                                  OR
   "stuck after K polls"          → emits an escalation event
   ↓
PR merged → manager marks the work item done
```

Critical design point: the runner's next turn is **driven by the
manager's reconciliation decisions**, not by individual webhook
events. The manager reads the _current state_ of the artifact
(plus a summary of recent events), decides the smallest next
action, and dispatches it. Webhook delivery is best-effort;
missed webhooks are caught by the next scheduled tick.

## Do we even use Git?

**Yes, for code. Always.** Two reasons:

1. The reviewers we want to integrate with — humans, CI, security
   scanners, downstream tools — all already speak Git.
2. The cost of Git for our use case is approximately zero. We're
   not asking the orchestrator to be a VCS; we're asking it to
   interact with one.

Where we **don't** use Git: artifacts that aren't text-shaped
(video, Figma, audio, large datasets). Object storage for those.

## Why not invent a new source mechanism

The temptation: "agents commit so fast that PRs feel like
overhead — let's just have the agent stream changes into a
real-time CRDT-backed editor." Tempting and wrong:

- Reviewers (humans, CI, downstream services) don't speak CRDTs.
- "Fast" isn't the user's problem. "Many parallel changes I can
  make sense of" is. PRs are a coherent unit-of-review; CRDTs
  blend everything into one stream.
- Git is the slowest part of _nothing_ in our stack. Optimizing it
  away saves no real time.

A possible future variant: orchestrator-managed **stacked diffs**
(à la Phabricator / Graphite) where dependent agent PRs land in
order. This is a worthwhile follow-up once we have plans with
inter-task dependencies, but doesn't change the answer to "do we
use Git" — it's still Git, just with stacking conventions on top.

## Build sequence

1. **Migrations.** `event_log` table; `work_item.next_poll_at`,
   `last_polled_at`, `poll_cadence_seconds`, `manager_runner_id`
   columns; `mention_handler` table. (one PR in
   `parallel-agent-platform`)
2. **Layer 1: webhook → event_log + bump.** Extend the existing
   handler in `apps/api/src/routes/work-items.ts` to (a) write
   `event_log` rows with idempotent `(source, source_event_id)`
   dedupe, and (b) bump `next_poll_at` for "interesting" events
   per a static dispatch table. Existing `issues`/`pull_request`
   handling stays. (one PR in `parallel-agent-platform`)
3. **Layer 1: additional GitHub event subscriptions.** Subscribe
   to `pull_request_review`, `pull_request_review_comment`,
   `check_run`, `issue_comment` on the GitHub App so they reach
   the handler. Document the GitHub App permissions update.
   (one PR in `parallel-agent-platform`)
4. **`Runner.Manager` runner kind.** New module conforming to
   the existing `Runner` behavior. Gets routed via the same
   `routing_rule` table — workspaces can pick which model runs
   their manager. (one PR in `parallel-agent-runtime`)
5. **Manager toolset.** `read_artifact_state`,
   `read_recent_events`, `merge_pr`, plus current catalog tools such as
   `git.run` and `scheduled_task.*`.
   Function-call schemas validated against JSON Schema; same
   pattern as [OQ-01](./oq-01-plan-format.md)'s `create_plan`.
   (one PR per tool, batchable)
6. **Manager scheduler.** GenServer / Oban worker per workspace
   that selects `where next_poll_at <= now()` work_items and
   dispatches a manager turn with the batch. Honors
   `min_cadence`. (one PR in `parallel-agent-runtime`)
7. **`read_artifact_state` adapter for GitHub PRs.** Reads PR
   state, review verdicts, check_run results, recent comments
   via the GitHub API. Cached briefly. (one PR)
8. **Manager system prompt.** Versioned in
   `prompts/manager-system-v1.md`. Same versioning pattern as
   [OQ-06](./oq-06-escalation-policy-schema.md)'s escalation
   guidance. (one PR)
9. **`mention_handler` matching + bump.** Layer 1 handler
   matches comment bodies against `mention_handler` rows for the
   workspace; on match, bumps `next_poll_at` to now and writes
   an event_log row tagged with the matched mention.
   Anti-loop filter by GitHub user ID. Rate-limit per
   `(workspace_id, mention, pr_number)` to 5/hour. (one PR)
10. **Branch naming + `GitHub.PRClient`.** Spec the
    `agent/<workspace>/<plan>/<task-id>` convention; build the
    PR client module that opens / updates / merges PRs on
    behalf of agents using `github_app_install` credentials.
    (one PR in `parallel-agent-runtime`)
11. **Stuck-task detection.** Manager emits an escalation
    when a task has had no progress in K consecutive polls
    (default K=4). (one PR — small)
12. **Per-vertical adapters.** Add `read_artifact_state`
    implementations for the next vertical(s) we ship —
    `Figma`, `DaVinci`, `Notion`, etc., each as a separate PR.
    (deferred — one PR per vertical when the customer arrives)
13. **`work_item.outputs` jsonb column** for non-code artifact
    pointers. (one PR in `parallel-agent-platform`)
14. **Workspace-scoped S3 bucket** creation flow as part of
    workspace setup, versioning enabled. (one PR)

## Open sub-questions

- Do we support **non-GitHub** Git hosts (GitLab, Gitea, Bitbucket)
  in v1? Recommendation: no — design `GitHub.PRClient` behind a
  `Forge` behavior so other forges can be added later, but ship
  GitHub-only.
- How do we handle **multiple PRs per task** (the agent realizes
  it needs to split mid-task)? Recommendation: explicit task
  split — the agent creates child `work_item`s under the same
  plan, each with its own PR. Don't allow N-PRs-per-task.
- Should the orchestrator ever **force-push** the agent branch
  (e.g., to incorporate review fixes cleanly)? Recommendation: no
  by default. Always additive commits. Power users can opt in.
- For very long-running PRs (peer-review agent had a slow turn),
  do we need **PR-level timeouts**? Recommendation: yes, mirror
  the `escalation.resource.max_wallclock_minutes` cap; if a PR
  has been "in review" longer than the cap, escalate.
