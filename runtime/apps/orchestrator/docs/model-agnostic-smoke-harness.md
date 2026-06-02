# Model-Agnostic Smoke Harness

This harness covers the runtime side of PR 11 from the model-agnostic agent
refactor plan: Planning Agent on provider A creates a plan, the user approves a
subset of tasks, and Coding Agent on provider B receives only the approved
handoff.

Run the deterministic local path from `apps/orchestrator`:

```bash
mix model_agnostic.smoke
```

The default fixture lives at
`priv/fixtures/model_agnostic_smoke/planning_to_coding_handoff.json`.

The fixture is API-shaped and intentionally contains no provider secrets. It
does not call Anthropic, OpenAI, Codex, or any other live provider. The harness
validates:

- planning and coding execution profiles include required routing fields;
- planning emits normalized runner events accepted by `Runner.Contract`;
- `plan.create` output includes task IDs;
- approval references existing plan tasks;
- coding receives exactly the approved task IDs;
- secret-bearing fields such as `api_key`, `token`, and `authorization` are not
  present anywhere in the fixture envelope.
