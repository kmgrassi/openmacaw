# OQ-01: Plan format

> Open question #1 from [docs/product-vision.md](../product-vision.md):
>
> "Plan format. YAML? JSON? A DSL? An LLM-generated structure derived
> from natural-language intent? Big design call. The
> chat-message-persistence and launcher-integration-pr-plan docs already
> contemplate work items as the primitive — plans are aggregates over
> work items, but the user-facing creation surface is undefined."

## ✅ Decision (2026-04-25)

**Option D — hybrid.** NL is the default user surface, structured
JSON is the canonical storage shape, YAML is the export/import
format for power users. No DSL.

**Implementation rule:** the planning agent's LLM tool surface is
the **canonical plan shape itself**. The function-call schema the
LLM sees and the JSON we persist are the same object, validated by
the same JSON Schema. There is no "translate LLM output into our
format" step — the LLM is constrained, by tool schema, to emit
exactly what we store.

See [Implementation: planning-agent tool
shape](#implementation-planning-agent-tool-shape) below.

## What we know

- `work_item` rows already exist as the unit-of-work primitive (see
  [chat-message-persistence.md](../chat-message-persistence.md) and
  [launcher-integration-pr-plan.md](../launcher-integration-pr-plan.md)).
- A `plan` is an aggregate over `work_item`s — it groups them, gives
  them a shared parent, and lets the dashboard show "plan X with 12
  fanned-out tasks" as a single object.
- The orchestrator does not need a structured plan to run a single
  task. Plans only matter when there is **more than one task** that
  share intent / context / branching strategy / merge target.
- We have two distinct user populations to design for:
  1. A user typing "clean up unused imports across `src/` — one PR per
     directory" into a chat box. They never want to see JSON.
  2. A power user who wants reproducible, version-controllable plans
     they can drop into CI or a repo.

## Options

### Option A: Pure LLM-generated, no surfaced format

User types intent into the chat. An LLM converts it to a `plan` row +
N `work_item` rows. The plan blob is opaque.

- **Pros:** Lowest-friction UX. Matches how everyone already thinks
  about asking an agent for work.
- **Cons:** Not reproducible. No way to edit a plan precisely. No way
  to check a plan into a repo. No way for an external system (CI, a
  cron, another agent) to author a plan.

### Option B: Hand-authored YAML/JSON only

Plan files are first-class structured documents. UI is a JSON/YAML
editor or form-builder.

- **Pros:** Reproducible. Diffable. Power-user friendly.
- **Cons:** Punishingly slow for the 80% case ("just do the obvious
  thing across these files"). Re-introduces the "writing JSON to talk
  to an agent" anti-pattern we are explicitly trying to escape.

### Option C: Custom DSL

Define a small plan-authoring language (think: a tiny restricted
TypeScript-ish or Starlark-ish surface).

- **Pros:** Expressive. Could capture branching/depends-on neatly.
- **Cons:** Big up-front cost, ongoing parser maintenance, learning
  curve for users. Not justified at our stage.

### Option D (recommended): Hybrid — NL is the front door, structured JSON is the storage

1. **Chat-first authoring.** User types natural-language intent. An
   LLM produces a draft plan (a tree of `task` specs) and shows it
   inline in the dashboard for confirmation — *"I'm planning to fan
   this out into these 12 tasks; edit / approve / cancel."*
2. **Storage shape.** The persisted form is JSON, embedded in
   `plan.metadata` (existing column) plus normalized `work_item` rows.
   The JSON is the source of truth; rows are the projection the
   orchestrator and dashboard read.
3. **Power-user export/import.** Each plan has a deterministic YAML
   export. Power users can `pull` a plan (`harper-cli plan get …`),
   edit YAML in their editor, `push` it back. Round-trips are
   lossless.
4. **External authoring.** A `POST /api/plans` endpoint accepts the
   same JSON shape, so CI / cron / another agent can author plans
   without going through the chat surface.

This deliberately mirrors how Terraform plans work: the user almost
never writes the `.tfplan` binary, but it exists, is versioned, and
can be reasoned about.

## Recommendation

**Option D — hybrid.** NL is the default user surface, JSON is the
canonical storage shape, YAML is the export/import format for power
users. No DSL. *(Confirmed — see Decision callout above.)*

## Sketched JSON shape (for review, not final)

```json
{
  "schema_version": "1",
  "title": "Clean up unused imports in src/",
  "intent": "human-readable summary",
  "default_runner": "codex",
  "default_model": "claude-opus-4",
  "tasks": [
    {
      "id": "t-01",
      "title": "Clean up src/components/",
      "instructions": "…",
      "labels": { "directory": "src/components" },
      "depends_on": [],
      "completion_gates": ["lint", "tests"]
    }
  ]
}
```

`tasks[]` is what gets normalized into `work_item` rows at insert
time.

## Implementation: planning-agent tool shape

The planning agent (the LLM that converts natural-language intent
into a draft plan) is invoked through **function-calling** against
a single canonical tool, not through free-form text-to-JSON
extraction. The tool's input schema **is** the plan schema —
there is no second translation layer.

### Why function calling, not text-to-JSON

- **Eliminates a parser.** Text-to-JSON requires either regex
  extraction or a second LLM call to "fix the JSON." Both are
  flaky.
- **The schema doubles as the prompt.** Tool descriptions /
  parameter docstrings give the LLM strong guidance about what to
  emit. The structure isn't a hope — it's enforced by the
  provider's function-call decoder.
- **Consistent across providers.** OpenAI, Anthropic, and
  OpenAI-compatible local models all support typed function
  calling. The tool definition is portable.
- **Same schema, server-side validation.** The planning endpoint
  validates the tool-call arguments against the *same* JSON
  Schema that `POST /api/plans` uses. If validation fails the
  planning agent is asked to retry with the validation error in
  the loop.

### The tool

A single tool, `create_plan`, whose JSON-Schema input is the plan
shape:

```jsonc
{
  "name": "create_plan",
  "description": "Create a plan that the orchestrator will fan out into one work_item per task. Tasks run in parallel unless depends_on is set.",
  "input_schema": {
    "type": "object",
    "required": ["title", "intent", "tasks"],
    "properties": {
      "schema_version": { "type": "string", "const": "1" },
      "title":          { "type": "string", "minLength": 1, "maxLength": 200 },
      "intent":         { "type": "string", "description": "One-paragraph human summary of the user's request, in the user's voice." },
      "default_runner": { "type": "string", "enum": ["codex", "openclaw", "computer-use", "openai-compatible"] },
      "default_model":  { "type": "string" },
      "tasks": {
        "type": "array",
        "minItems": 1,
        "items": {
          "type": "object",
          "required": ["id", "title", "instructions"],
          "properties": {
            "id":           { "type": "string", "pattern": "^t-[a-z0-9-]+$" },
            "title":        { "type": "string", "minLength": 1, "maxLength": 120 },
            "instructions": { "type": "string", "description": "Self-contained brief; the runner sees only this and the labels." },
            "labels":       { "type": "object", "additionalProperties": { "type": "string" } },
            "depends_on":   { "type": "array", "items": { "type": "string" } },
            "completion_gates": { "type": "array", "items": { "type": "string", "enum": ["lint", "tests", "peer-review", "self-review"] } }
          }
        }
      }
    }
  }
}
```

The same schema is exported from a single source-of-truth file
(`packages/plan-schema/v1.json`) and consumed by:
1. The planning-agent tool definition (above).
2. `POST /api/plans` request validation.
3. `harper-cli plan push` client-side validation.
4. The dashboard's plan editor (form generated from the schema).

One schema, four call sites, no drift.

### Tool-call → persistence flow

```
user types intent
      │
      ▼
planner endpoint dispatches LLM
   with tools = [create_plan]
      │
      ▼
LLM emits create_plan(args)
      │
      ▼
server validates args against
   plan-schema-v1.json
      │
      ├─ invalid → re-prompt LLM with error message (max 2 retries)
      │
      ▼
return draft to dashboard for user approval
      │
      ▼ (approve)
POST /api/plans { ...args }
      │
      ▼
plan row + N work_item rows inserted in one transaction
```

The LLM is **never** asked to do anything other than call the
tool. If it tries to respond with text, the planner retries with
"please call create_plan."

### What this rules out

- **No prompt-templated JSON.** We don't do `prompt: "respond in
  JSON like {…}"` — that's the path that produces the "fix the
  JSON" anti-pattern.
- **No per-runner planning shapes.** The plan shape is independent
  of which runner the tasks dispatch to. Runner choice is a
  `default_runner` / per-task label, resolved by routing
  ([OQ-03](./oq-03-routing-config-schema.md)).
- **No partial plans.** The tool either produces a complete,
  valid plan or it retries. We never persist a half-formed plan.

## Concrete next step

- [ ] Land `packages/plan-schema/v1.json` as the single source of
      truth for the plan shape, with tests that lock the schema
      against the example documents in this doc. (one PR in
      `parallel-agent-platform`)
- [ ] Add `POST /api/plans` accepting that schema, persisting to
      `plan.metadata` + creating `work_item` rows in one
      transaction. (one PR)
- [ ] Add an LLM-driven planner endpoint
      (`POST /api/plans/draft-from-prompt`) that dispatches with
      `tools = [create_plan]` (the schema above), validates the
      tool-call arguments against `plan-schema-v1.json`, and
      retries on validation failure with the error fed back to the
      LLM. The endpoint returns the draft for user confirmation
      before any rows are written. (one PR)
- [ ] Wire the dashboard to render the draft plan with edit /
      approve / cancel actions; on approve, call `POST /api/plans`
      with the (possibly user-edited) plan. (one PR)
- [ ] Add CLI `harper-cli plan {get,push,run}` for the power-user
      lane, validating with the same schema. (deferred — separate
      PR)

## Open sub-questions

- Does `depends_on` ship in v1, or is plan-level concurrency limited
  to "all tasks fan out in parallel" until we have a real customer
  asking? (Recommendation: defer.)
- Where does plan-level cost / concurrency policy live? Probably in
  `gateway_config` (see [OQ-03](./oq-03-routing-config-schema.md)) so
  it's policy, not embedded in every plan.
