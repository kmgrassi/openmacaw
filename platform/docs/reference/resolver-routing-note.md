# Resolver Routing Note

This note captures a useful external reference for future routing and context
management work in the platform:

- Garry Tan X post: <https://x.com/garrytan/status/2044479509874020852?s=20>
- Related essay with the same framing:
  <https://github.com/garrytan/gbrain/blob/master/docs/ethos/THIN_HARNESS_FAT_SKILLS.md>

## Core Idea

The post frames a resolver as a routing table for agent context: when a task of
type X appears, load context or skill Y first. Skills define how an agent should
do work; resolvers decide what context the agent should read and when.

The important warning is that one giant instruction file or prompt eventually
degrades agent performance. A smaller resolver that points to focused documents
or skills keeps the default context thin while still making domain knowledge
reachable.

## How It Applies Here

Parallel Agent Platform already has several routing-shaped concepts:

- task labels such as runner/model hints
- agent types like coding, planning, and custom
- model settings and provider credentials
- planning handoff rules
- settings sections that describe per-agent runtime behavior

Those pieces should not become scattered conditional logic or a growing prompt.
They should converge toward an explicit resolver layer that answers:

- Which runner should handle this task?
- Which model or provider policy should apply?
- Which planning or review context should be loaded before execution?
- Which safety or handoff rules must be consulted before a tool is available?
- Which docs, contracts, or runbooks should an agent read for this task type?

## Candidate Product Shape

A platform resolver could be represented as structured configuration owned by
workspace, repository, or agent scope:

- `trigger`: task label, agent type, repository path, source integration, or
  natural-language intent description
- `loads`: documents, plan context, settings sections, tool policies, or model
  policies
- `routes_to`: runner, model profile, agent, or handoff workflow
- `evals`: sample inputs and expected routing decisions
- `health`: last validation time, unresolved references, and overlapping
  triggers

This would let the platform keep the orchestrator thin while still making
agent behavior more reliable and explainable.

## Useful Checks

The post also points toward resolver maintenance checks that would fit this app:

- Trigger evals: sample work items that assert the selected runner, model, and
  context bundle.
- Reachability checks: every configured skill, document, tool policy, model
  policy, or settings surface should be reachable from at least one resolver
  path.
- Overlap checks: flag ambiguous routes where two resolver entries claim the
  same task class.
- Drift checks: periodically verify that database config, docs, and runtime
  allowlists still agree.

## Near-Term Use

Before building a full resolver service, use this framing when adding routing
features:

1. Keep the default agent context small.
2. Prefer pointers to focused docs/config over embedding long instructions.
3. Make routing decisions inspectable in the dashboard.
4. Add tests for routing decisions, not just execution outcomes.
5. Treat unreachable skills or policies as product bugs.
