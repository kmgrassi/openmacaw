# OQ-03: Routing config schema

> Open question #3 from [docs/product-vision.md](../product-vision.md):
>
> "Routing config schema. Need to design before we build the UI for
> it. Strongly suspect it should live in `gateway_config` (versioned,
> scoped, already in the schema) but the JSON shape is undefined."

## ✅ Decision (2026-04-25)

1. **Routing rules live in proper relational tables**, not in a
   JSON blob in `gateway_config`. The original "stuff it all in
   `gateway_config.body.routing`" sketch is rejected — too much of
   the system needs to query, index, and FK against this data for
   JSON-blob storage to make sense.
2. **`gateway_config` is reframed** as the home for *opaque,
   hand-edited, versioned-as-a-unit policy* (escalation, auto-merge
   knobs, structural rules — see [OQ-06](./oq-06-escalation-policy-schema.md),
   [OQ-07](./oq-07-auto-merge-gate-selection.md)). Hot-path
   individually-edited config gets its own tables.
3. **Fallback chains are first-class.** Each routing rule can
   declare a `next_fallback_rule_id`. On dispatch failure (runner
   unreachable, 429/capacity, timeout), the orchestrator cascades
   to the fallback. This is a hard requirement — the system must
   try to be as resilient as possible.
4. **Percentage-based splits / canary routing: not in v1.** Defer
   until there's a real need.

The rest of this doc is the relational schema, the fallback
semantics, and the migration shape.

## What we know

- `gateway_config` already exists with `(scope_type, scope_id,
  version, body jsonb)` columns. It is the canonical home for
  versioned, workspace-or-global policy.
- Routing is the decision: *given a task with these attributes,
  which runner runs it, and which model does that runner use, with
  which credentials?*
- Inputs available at routing time:
  - `task.runner_label` (e.g., `runner:openclaw`)
  - `task.model_label` (e.g., `model:claude-opus-4`)
  - `task.kind` (e.g., `code`, `video-edit`, `browse`)
  - `task.metadata` (free-form JSON authored by the planner)
  - `plan.id`, `plan.metadata`
  - `workspace.id`
- The user-facing pillar is "intelligent routing": a default rule
  set ships out of the box; users override per workspace.

## Recommended schema (relational)

### `routing_rule`

The hot-path table — one row per rule. Read on every task dispatch.

```sql
create table routing_rule (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references workspace(id) on delete cascade,
  name                  text not null,                              -- human-readable identifier
  priority              int  not null,                              -- higher wins
  enabled               boolean not null default true,

  -- dispatch target
  runner_kind           text not null,                              -- 'codex' | 'openclaw' | 'computer-use' | …
  model                 text,                                       -- nullable: rule may pin runner only
  credential_id         uuid references credential(id) on delete restrict,

  -- fallback chain
  next_fallback_rule_id uuid references routing_rule(id) on delete set null,

  -- audit
  hit_count             bigint not null default 0,
  last_hit_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index on routing_rule (workspace_id, enabled, priority desc);
create index on routing_rule (workspace_id, next_fallback_rule_id);
```

Key properties this gets us:

- **FK enforcement** on `credential_id` and `next_fallback_rule_id`.
  A rule pointing at a deleted credential / nonexistent fallback is
  rejected by the database, not discovered at dispatch time.
- **Indexable resolution**: `where workspace_id = $1 and enabled
  order by priority desc` is one B-tree scan.
- **Atomic per-rule edits** — drag-to-reorder updates one row, not
  the whole policy document.
- **Per-rule audit** — `hit_count` + `last_hit_at` columns are
  trivially queried, much harder if rules are buried in JSON.

### `routing_rule_match`

Matches are AND'd within a rule. One row per match condition.

```sql
create table routing_rule_match (
  id          uuid primary key default gen_random_uuid(),
  rule_id     uuid not null references routing_rule(id) on delete cascade,
  kind        text not null check (kind in (
                'task_kind', 'plan_id', 'label_eq',
                'runner_label', 'model_label'
              )),
  key         text,                  -- for 'label_eq': the label key; null for others
  value       text not null,         -- the value to match exactly
  created_at  timestamptz not null default now()
);

create index on routing_rule_match (rule_id);
create index on routing_rule_match (kind, key, value);     -- helps reverse lookups ("which rules match label foo=bar?")
```

A rule with **no** match rows is the catch-all (matches every
task) — that's how the `default` rule works in this model.

### `credential_alias` (referenced from [OQ-04](./oq-04-per-task-model-overrides-credentials.md))

Logical aliases that point at a `credential` row, so rotating a
credential = updating one alias, not every rule.

```sql
create table credential_alias (
  workspace_id  uuid not null references workspace(id) on delete cascade,
  alias         text not null,
  credential_id uuid not null references credential(id) on delete restrict,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, alias)
);
```

Routing rules can reference either `credential_id` directly or an
alias resolved via `(workspace_id, alias)`. We add an
`credential_alias_id` nullable FK to `routing_rule` so a rule
points at *one of the two*, never both:

```sql
alter table routing_rule
  add column credential_alias varchar(64),
  add constraint routing_rule_one_credential check (
    (credential_id is not null and credential_alias is null) or
    (credential_id is null and credential_alias is not null) or
    (credential_id is null and credential_alias is null)        -- rule may also be credential-free
  );
```

The dispatcher resolves alias → credential at dispatch time via
the FK to `credential_alias`.

### What stays in `gateway_config`

`gateway_config.body` is reframed as a **hand-edited policy
document** for things that are NOT hot-path-queried per-dispatch:

- `escalation` (OQ-06)
- `auto_merge` (OQ-07)
- `policies_by_kind` referencing gate-definition names ([OQ-10 (deferred)](./deferred/oq-10-per-vertical-gate-hooks.md))
- workspace-level constants: cost cap, concurrency cap, default
  routing fallback for `no_routing_rule`

Versioning of `gateway_config` is preserved: edits to the
escalation policy still produce a new version. Routing rules have
their own per-row `created_at` / `updated_at` and an audit-log
table (see migration plan below) — they are not coupled to
`gateway_config.version`.

### Resolution algorithm

```
1. Fetch enabled rules:
     select * from routing_rule
      where workspace_id = $1 and enabled
      order by priority desc

2. For each rule (in priority order):
     all_match = every routing_rule_match row matches the task
     if all_match: candidate = rule; break

3. If no candidate: emit `no_routing_rule` (escalation)
   unless gateway_config.body.routing.default_runner_kind is set,
   in which case use that as the synthetic default.

4. Try to dispatch through the candidate:
     resolved = resolve(rule.credential_id or alias)
     emit dispatch frame to runner

5. If dispatch fails (defined below) AND
   candidate.next_fallback_rule_id is not null:
     candidate = fetch(candidate.next_fallback_rule_id)
     goto 4
   (with a max chain depth = 5 and visited-set cycle break)

6. If chain exhausted without success:
     transition task → `escalated` with reason `dispatch_exhausted`
```

### Fallback trigger conditions

A dispatch is considered "failed for fallback purposes" when the
runner returns:

- `:transport_error` (cloud → runner connection failed)
- `:auth_error` from the credential (will not be fixed by retry)
- `:capacity` / HTTP 429 / "no slots"
- `:provider_unavailable` / HTTP 5xx after the runner-internal
  retry budget is exhausted
- `:timeout` exceeding the per-rule dispatch deadline

A dispatch is **NOT** failed for fallback purposes when the runner
is happily executing but the *task itself* is failing (test
failures, lint errors, etc.). Those go through the gate /
escalation path, not the fallback chain.

### Cycle and depth protection

- `next_fallback_rule_id` is a self-FK. The DB lets you create
  cycles. The dispatcher protects with:
  - `max_fallback_depth = 5` (config-driven, defaults to 5)
  - Visited-set: track rule IDs touched in the current dispatch;
    abort if a rule appears twice
- Validation on rule create/update: walk the chain, refuse if it
  visits more than `max_fallback_depth` rules or contains a cycle.

### Migration plan (back-compat with the JSON sketch)

- Initial migration creates the three tables above.
- A small dual-write window (one release): if `gateway_config.body.
  routing.rules[]` is present, mirror it into `routing_rule` rows.
- Subsequent release removes the JSON-blob path; UI writes only to
  the relational tables.
- The relational tables become the only source of truth from the
  next minor version.

## Alternative considered: per-task `routing_overrides` only

Skip workspace-level config; let every task carry its full
runner/model spec inline. Rejected: forces planners to know the
infra layout, duplicates config, no central place to change
"actually let's send all elixir work to OpenAI now."

## Alternative considered: keep it all in `gateway_config` JSON

Rejected for the reasons in the Decision callout: too many places
need to query, index, FK against, and audit-log this data. JSON in
a single versioned blob is the right shape for *policy documents*
that are edited as a unit; it's the wrong shape for a hot-path
table of individually-edited records.

## Concrete next step

- [ ] Add a JSON-Schema document for the `routing` block of
      `gateway_config.body`. (one PR in `parallel-agent-platform`)
- [ ] Implement `Routing.resolve(task, workspace_id)` in the
      orchestrator that loads the current `gateway_config` row and
      returns `{runner_kind, model, credential_id}`. (one PR in
      `parallel-agent-runtime`)
- [ ] Add a `GET /api/workspaces/:id/routing` + `PUT` endpoint pair
      that read/write the `routing` block. (one PR in
      `parallel-agent-platform`)
- [ ] Build the routing editor UI (form per rule + reorder for
      priority). (deferred — one PR)

## Open sub-questions

- Should rules support **fallback chains** (e.g., "try `runner:codex`,
  if no capacity, fall back to `runner:openclaw`")? Recommendation:
  defer until we have a real over-capacity scenario.
- Should rules support **percentage-based splits** (canary 10% to a
  new model)? Recommendation: defer — useful eventually, not in v1.
