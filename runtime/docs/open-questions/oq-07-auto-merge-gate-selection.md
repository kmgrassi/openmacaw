# OQ-07: Auto-merge gate selection

> Open question #7 from [docs/product-vision.md](../product-vision.md):
>
> "Auto-merge gate selection. Which gates need to be green before
> the agent merges autonomously? `lint + tests + peer_review`? Just
> `tests`? Configurable per workspace? This is the 'trust dial.'
> Get wrong and the agent merges broken code or asks too often."

## ✅ Decision (2026-04-25)

**The repository's own gates come first.** Before we apply any
workspace policy, we read what the repo itself already declares:
GitHub branch-protection required status checks, CODEOWNERS,
existing CI workflows, and any `.github/auto-merge.yml`-style
config the repo defines. If the repo says "tests + a code-owner
review must pass," that's the floor. We never auto-merge in
violation of the repo's own rules.

**Smart fallback** for repos that don't declare their own:
`lint + tests + self_review + peer_review`, with a per-workspace
trust dial.

**Peer-review is mandatory by default**, and is itself an agent —
ideally on a *different model from the author*. This is the
single most important quality gate; it catches the
"plausible-looking but wrong" diffs that single-agent loops miss.

**Auto-merge is a first-class entity, not buried in
`gateway_config`.** Promote it to its own relational tables,
parallel to [OQ-03](./oq-03-routing-config-schema.md)'s
`routing_rule`. Hot-path lookup, per-row audit, FK enforcement
against gate definitions and credentials, atomic per-rule edits.

The rest of this doc is the schema, the discovery flow for
repo-declared gates, the peer_review design (including the
cross-LLM question), and the build sequence.

## What we know

- This is the **trust dial**. It defines the bargain we're offering
  the user: *"if all of these checks pass, I will merge without
  asking; if any fail and I can't fix them, I escalate."*
- Defaults matter much more than what's possible. Most users will
  never edit this setting — what we ship by default is what the
  product is.
- A gate must have three properties to be useful:
  1. **Cheap** — runs in seconds-to-minutes, not hours.
  2. **Deterministic** — same input → same outcome (modulo flakes,
     which we have to handle separately).
  3. **Negative is unambiguous** — when it's red, the diff is wrong
     for a definable reason.

## Repository-defined gates: the first source of truth

Before applying any workspace-level policy, the orchestrator reads
the repo itself. This avoids re-inventing decisions repos have
already made and prevents us from "auto-merging" something the
repo's own branch protection forbids.

### What we discover from each repo

The orchestrator runs a one-time-per-PR (cached) discovery pass:

| Source                                  | What we learn |
|-----------------------------------------|---------------|
| GitHub branch protection on target      | Required status checks, required reviewers, required signed commits, "dismiss stale reviews" setting |
| `CODEOWNERS`                            | Who must review which paths |
| `.github/workflows/*`                   | What `lint` and `tests` actually map to (workflow names → status checks) |
| `.github/auto-merge.yml`/`renovate.json`/`dependabot.yml` | Existing auto-merge intent on the repo |
| `package.json` / `Makefile` / `mix.exs` | Conventional `lint`/`test` script names — used as the local pre-flight before we even open the PR |

These get hashed and stored in a `repo_inherited_policy` row
(schema below) so we don't refetch on every dispatch. We refresh
on PR-open and on a 24h TTL.

### Conflict resolution

- The orchestrator's **required gates** = `union(repo_required, workspace_required)`. We never *subtract* a gate that the repo requires.
- The orchestrator's **mergeability rule** = AND of all required gates passing AND the repo's branch-protection state being satisfied (e.g., if the repo requires a code-owner approval and there's no code-owner in the workspace, that's an escalation, not a green-light to merge).
- If the repo has **no auto-merge intent** (`.github/auto-merge.yml` missing, no required checks, no protection), we apply the workspace fallback gates *but* the workspace `auto_merge.enabled = true` is also required before any autonomous merge.

### Why this order matters

Repo-defined first means a customer can ship rules in their repo
that propagate to every agent automatically — no workspace config
edit needed. It also means we *can't* be the cause of merging
something a human reviewer's branch protection would have blocked.

## Smart fallback (when the repo doesn't define gates)

For repos that don't declare their own rules, the workspace-level
fallback applies. Default fallback gate set:

1. **`lint`** — repo-discovered linter (e.g., the `lint` script in
   `package.json`). Must exit 0.
2. **`tests`** — repo-discovered test command. Subset selection
   allowed (run only tests touching changed files) but full suite
   required for diffs over `max_diff_lines_for_full_suite`.
3. **`self_review`** — the authoring agent re-reads its own diff
   against the workspace review checklist. Cheap pre-filter.
4. **`peer_review`** — a *separate* agent (ideally on a different
   model) reviews the diff against the same checklist. See
   *[Peer-review: cross-LLM by default](#peer_review-cross-llm-by-default)*
   below.

Auto-merge fires only when **all four** are green AND the repo's
own gates (if any) are green.

The trust dial **starts here in private beta and never gets
weaker by default.**

## Schema: `auto_merge_policy` is its own table

Auto-merge config is hot-path (read on every PR), needs FK
enforcement (links to gate definitions, credentials, repos), and
is edited individually per row. A JSON blob in `gateway_config`
is the wrong storage shape. Promote it.

### `auto_merge_policy`

```sql
create table auto_merge_policy (
  id                          uuid primary key default gen_random_uuid(),
  workspace_id                uuid not null references workspace(id) on delete cascade,
  repo_id                     uuid     references repo(id)      on delete cascade, -- null = workspace default
  enabled                     boolean  not null default false,
  preset                      text     check (preset in ('conservative', 'balanced', 'aggressive', 'custom')),
  max_diff_lines_for_auto_merge int    not null default 200,
  max_diff_lines_for_full_suite int    not null default 100,
  max_auto_merges_per_hour    int      not null default 5,
  blocked_paths               text[]   not null default '{}',
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (workspace_id, repo_id)                              -- one policy per (workspace, repo); repo_id null = workspace default
);

create index on auto_merge_policy (workspace_id, enabled);
```

Resolution order at PR-time: `repo-specific row → workspace
default row → built-in conservative preset`. The first one found
wins for that field; missing fields fall through to the next
level.

### `auto_merge_required_gate`

```sql
create table auto_merge_required_gate (
  id                  uuid primary key default gen_random_uuid(),
  policy_id           uuid not null references auto_merge_policy(id) on delete cascade,
  gate_kind           text not null check (gate_kind in (
                        'lint', 'tests', 'self_review', 'peer_review', 'custom'
                      )),
  gate_definition_id  uuid references gate_definition(id),       -- required when gate_kind = 'custom'
  ordering            int  not null default 0,                   -- UI display only; gates run in parallel
  created_at          timestamptz not null default now()
);

create index on auto_merge_required_gate (policy_id);
```

### `repo_inherited_policy`

Captures what we discovered from the repo itself. Refreshed on
PR-open and on a 24h TTL.

```sql
create table repo_inherited_policy (
  id                          uuid primary key default gen_random_uuid(),
  repo_id                     uuid not null references repo(id) on delete cascade,
  branch                      text not null,                                      -- target branch we inspected
  required_status_checks      text[] not null default '{}',                       -- from branch protection
  required_reviewer_teams     text[] not null default '{}',                       -- from branch protection + CODEOWNERS
  codeowners_blob_sha         text,                                               -- so we know if it changed
  has_explicit_auto_merge     boolean not null default false,
  raw_discovery               jsonb  not null default '{}',                       -- everything we got, for debug
  fetched_at                  timestamptz not null default now(),
  unique (repo_id, branch)
);
```

`raw_discovery` is jsonb because it's hand-inspected debug
material, not queried.

### `peer_review_config`

Peer-review is special enough to warrant its own row (1:1 with
policy). See *[Peer-review: cross-LLM by default](#peer_review-cross-llm-by-default)*
for the design.

```sql
create table peer_review_config (
  policy_id                  uuid primary key references auto_merge_policy(id) on delete cascade,
  reviewer_runner_kind       text,                                              -- null = use default routing
  reviewer_model             text,                                              -- null = "any model different from author"
  prefer_different_model     boolean not null default true,
  reviewer_credential_id     uuid references credential(id) on delete set null,
  checklist_id               uuid references review_checklist(id),
  max_review_rounds          int  not null default 2,                           -- after this many back-and-forths, escalate
  block_on_review_fail       boolean not null default true                      -- review veto power
);
```

### `auto_merge_audit`

Per-merge audit log so we can answer "why did this auto-merge?"
months later.

```sql
create table auto_merge_audit (
  id                  uuid primary key default gen_random_uuid(),
  work_item_id        uuid not null references work_item(id),
  pr_url              text not null,
  policy_snapshot     jsonb not null,                                           -- frozen policy values at merge time
  gate_results        jsonb not null,                                           -- {lint: pass, tests: pass, peer_review: {verdict: approve, reviewer_model: ...}, ...}
  merged_at           timestamptz not null default now()
);

create index on auto_merge_audit (work_item_id);
create index on auto_merge_audit (merged_at desc);
```

### Knobs explained

- **`enabled = false` is the v1 default** at the workspace level.
  A user must explicitly opt in to auto-merge. The agent still
  runs all gates and *prepares* the merge — it just stops at
  "ready, awaiting human click."
- **`max_diff_lines_for_auto_merge`** — large diffs always
  escalate. A 5000-line refactor should be human-blessed even
  when green.
- **`blocked_paths`** — paths where auto-merge never fires
  regardless of gate state. Mirrors the structural escalation
  rule in [OQ-06](./oq-06-escalation-policy-schema.md), and these
  two lists should default to the same set.
- **`max_auto_merges_per_hour`** — rate-limit on autonomous
  merges per workspace. If the agent is going haywire and
  somehow getting green gates on bad work, this is the
  blast-radius cap.

## Tier presets

To make the trust dial discoverable, ship three presets:

| Tier        | enabled | required_gates                                | max_diff |
|-------------|---------|-----------------------------------------------|----------|
| Conservative| false   | lint + tests + peer_review + self_review      | 100      |
| Balanced    | true    | lint + tests + peer_review + self_review      | 200      |
| Aggressive  | true    | lint + tests + self_review                    | 500      |

`Conservative` is the default. New users see the preset selector on
first plan.

## Peer-review: cross-LLM by default

Peer-review is the single most important quality gate in this
system. It is also the most cost-sensitive (extra LLM tokens for
every PR). The design has to be both *good* and *cheap enough that
users keep it on by default*.

### The author/reviewer split

When the authoring agent finishes a diff:

1. The orchestrator dispatches a **separate** runner with the
   reviewer prompt, the diff, and the workspace's review
   checklist.
2. The reviewer is a normal runner of any kind (Codex, OpenClaw,
   Claude Code, OpenAI-compatible local model). It receives the
   diff as its input and emits a structured verdict via tool
   call.
3. The reviewer cannot edit code. It can only:
   - approve (verdict: `approve`)
   - request changes (verdict: `request_changes`, with structured
     comments)
   - escalate (verdict: `escalate`, using the same
     `escalate_to_human` tool from
     [OQ-06](./oq-06-escalation-policy-schema.md))

### Cross-LLM: same model or different model?

User-facing question: *if Claude wrote it, can Claude review it?
Or should the reviewer always be a different model?*

Three patterns to choose from:

| Pattern                                     | Catches | Cost     | Default? |
|---------------------------------------------|---------|----------|----------|
| **A. Same model, two passes**               | Most syntax / obvious-logic mistakes. Misses blind spots the model has. | 1× extra | Fallback only |
| **B. Different model, one pass each**       | Significantly more "looks plausible, is wrong" cases — different training, different priors. | 1× extra (sometimes 2× if cross-provider switch is expensive) | **Default** |
| **C. Multiple reviewers (N≥2)**             | Even more — but diminishing returns past 2. | N× extra | Power-user opt-in |

**Default = Pattern B.** Specifically:

- `peer_review_config.prefer_different_model = true` (default).
- The reviewer's runner is resolved through the same routing
  table as everything else
  ([OQ-03](./oq-03-routing-config-schema.md)). The router gets
  one extra input — `author_model` — and prefers a rule whose
  `model` is *not equal*. If no such rule matches, fall back to
  the same model with a warning logged on the audit row.
- Workspaces can pin a specific reviewer model (e.g., "always
  review with `gpt-5`") via `peer_review_config.reviewer_model`.

### Why not always different model

- Some workspaces only have one provider configured. We can't
  conjure a second provider out of thin air; falling back to the
  same model is better than failing the gate.
- Some specialized review tasks genuinely benefit from a model
  that's seen a lot of the same code (e.g., a Python-heavy repo
  may want a Python-strong model for both author and review).
  Workspaces can pin this case explicitly.

### Multi-round review loop

The author/reviewer back-and-forth is bounded by
`peer_review_config.max_review_rounds` (default 2). Each round:

1. Author posts diff.
2. Reviewer reviews.
3. If `request_changes`: comments flow back to author via the
   webhook loopback ([OQ-12](./oq-12-git-and-source-control.md)).
   Author addresses, pushes a new commit. Round counter increments.
4. If `approve`: gate passes.
5. If round counter exceeds `max_review_rounds` without approve:
   escalate to human with the conversation transcript.

### Veto power

`peer_review_config.block_on_review_fail = true` (default) means
peer_review is a hard veto: even if every other gate is green, a
`request_changes` verdict blocks merge until resolved. This is
the whole point of having it; it would be perverse to add a
review gate and then ignore the reviewer.

### Reviewer prompt and checklist

The reviewer's prompt template lives in
`prompts/peer_review-checklist-v1.md`, versioned the same way as
the escalation guidance in
[OQ-06](./oq-06-escalation-policy-schema.md). Workspaces can
override per repo via the `review_checklist` table referenced
from `peer_review_config.checklist_id`.

### Cost note

Peer-review approximately doubles per-PR LLM cost. We accept
that. Workspaces with budget pressure can:
- Drop to the `Aggressive` preset (no peer_review). Strongly
  discouraged in the UI.
- Pin reviewer to a cheaper model than the author (e.g., author
  with frontier, review with mid-tier). This is the right cost
  trade-off for most workspaces and we ship it as a preset.

## What "merge" means for non-coding tasks

The same shape applies but the gates differ:

- Video edit: `spec_check` (ffprobe-derived) + `peer_review` (an
  agent watches the output and checks against the brief).
- Design / Figma: `lint`-equivalent (no broken links, layer count
  in range) + `peer_review`.

See [OQ-10 (deferred)](./deferred/oq-10-per-vertical-gate-hooks.md) for the hook
schema.

## Build sequence

Auto-merge is a first-class entity, so this starts with migrations
on the critical path.

1. **Migrations** for `auto_merge_policy`,
   `auto_merge_required_gate`, `peer_review_config`,
   `repo_inherited_policy`, `auto_merge_audit`, `review_checklist`.
   Index `(workspace_id, repo_id)` for resolution and
   `(merged_at desc)` for audit. (one PR in
   `parallel-agent-platform`)
2. **Repo-discovery worker.** Fetches GitHub branch protection,
   CODEOWNERS, workflows, and any auto-merge config. Writes
   `repo_inherited_policy` rows. Refreshes on PR-open + 24h TTL.
   (one PR in `parallel-agent-platform`)
3. **Policy resolver.** `AutoMerge.resolve(workspace_id, repo_id,
   target_branch)` returning the effective gate set after
   layering repo → workspace → preset. Includes the conflict
   logic ("union of required, never subtract repo gates"). (one
   PR in `parallel-agent-runtime`)
4. **Gate runner.** Behavior callback per gate kind (`lint`,
   `tests`, `self_review`, `peer_review`, `custom` — backed by
   `gate_definition` rows from
   [OQ-10 (deferred)](./deferred/oq-10-per-vertical-gate-hooks.md)). (one PR in
   `parallel-agent-runtime`)
5. **Peer-review dispatcher.** Pulls reviewer routing from
   `peer_review_config` + the routing rules from
   [OQ-03](./oq-03-routing-config-schema.md), picks a different
   model where possible, dispatches the reviewer agent with the
   reviewer prompt and the diff. Returns a structured verdict
   (`approve | request_changes | escalate`). (one PR in
   `parallel-agent-runtime`)
6. **Multi-round review loop.** Wires reviewer comments back via
   the GitHub webhook handler from
   [OQ-12](./oq-12-git-and-source-control.md). Honors
   `max_review_rounds` and escalates when exceeded. (one PR in
   `parallel-agent-runtime`)
7. **Audit log.** Write `auto_merge_audit` row on every merge,
   capturing the frozen policy snapshot and gate results
   inline. (one PR)
8. **Trust-dial UI.** Three-preset selector + per-repo override
   + visualization showing which gates are inherited from the
   repo vs from workspace policy. (one PR in
   `parallel-agent-platform`)
9. **Reviewer prompt versioning.** Land
   `prompts/peer_review-checklist-v1.md` and
   `prompts/reviewer-system-v1.md`. (one PR in
   `parallel-agent-runtime`)
10. **Cost telemetry.** Per-PR cost split (author tokens vs
    reviewer tokens) so users can see what peer_review actually
    costs them. (deferred — one PR after the data is flowing)

## Open sub-questions

- Do we treat **flaky tests** specially (retry once before
  failing)? Recommendation: yes, but cap retries at 1 and surface
  the flake in the dashboard.
- Should peer_review have a "veto" capability (block merge even if
  other gates are green)? Recommendation: yes — a peer_review fail
  blocks regardless. That's the whole point of having it.
