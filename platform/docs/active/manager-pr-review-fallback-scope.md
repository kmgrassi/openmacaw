# Manager PR Review Fallback — Scope

## Goal

Pillar 4 needs review before autonomous merge, but v1 should not build a
new authoring-agent self-review lifecycle yet. The current product
assumption is that GitHub automation already attaches AI review to most
PRs. The missing behavior is a **manager-agent fallback**:

1. Detect whether an AI review is already present or in flight for a PR.
2. If review is missing, let the manager agent dispatch the PR to a
   reviewer agent.
3. Prefer a reviewer backed by a different model family than the agent
   that authored the code.
4. Persist the review request / result enough for gate evaluation and
   duplicate suppression.
5. Feed actionable review feedback back into the authoring work item.

This scope closes the first concrete slice of vision gap **4.2
Peer-review dispatch**. It intentionally leaves **4.1 Self-review
lifecycle state** unscoped for now.

Although v1 is PR-shaped, the persistence model should not be
PR-specific. The same review loop should cover a document draft,
publication copy, report, design artifact, video render, or any future
work product. V1 therefore uses a generic `review_request` ledger with
versioned artifact fields.

## Current State

Verified against the platform and runtime repos on this branch before
writing this scope:

- Platform has `self-review` as an allowed plan completion gate in
  `contracts/plans.ts`, API route types, and web plan forms.
- Runtime has `self_review` as an allowed planner completion gate in
  `SymphonyElixir.Planner.PlanDraft`.
- Neither repo has a self-review lifecycle module, persisted
  self-review table, self-review API route, self-review prompt phase, or
  enforced transition that consumes the completion gate.
- Existing docs point at `manager-as-regular-agent-scope.md` as the
  structural foundation for peer-review dispatch, but there is no
  peer-review-specific scope.
- GitHub-side automatic AI review is expected to happen outside this
  scope through existing repository hooks / automation. The platform
  should observe and avoid duplicating that review.

## Non-Goals

- No authoring-agent self-review lifecycle in v1.
- No new auto-merge implementation. This scope only produces review
  signals that auto-merge gates can later consume.
- No full GitHub webhook ingestion system. We only need enough GitHub /
  PR inspection to answer "is review already present or running?"
- No human attention queue UI unless review dispatch itself fails in a
  way that policy says requires escalation.
- No generic non-GitHub review tool in v1. The first manager-facing
  tool is PR-shaped, but the persistence layer is generic enough for
  later document, publication, design, or artifact reviews.

## Proposed Behavior

When the manager agent evaluates a work item with an attached PR:

1. Resolve the PR identity from the work item metadata.
2. Check whether an AI review is already present or in flight.
3. If review exists, record that review is satisfied and do not launch
   another reviewer.
4. If review is missing, choose a reviewer agent / model family.
5. Dispatch the PR review task through the same manager-agent message
   injection path used for other scheduled manager work.
6. Persist a `review_request` row so retries and later sweeps do not
   duplicate work.
7. When the reviewer finishes, persist its verdict and link it back to
   the authoring work item.
8. If the verdict requests changes, queue the authoring agent with the
   review feedback.

The manager owns orchestration. The reviewer owns review content.

## Duplicate Review Detection

Before dispatching a reviewer, the platform/runtime should check:

- Existing GitHub PR reviews from known AI reviewers.
- Existing pending GitHub check runs or workflow runs for configured AI
  review automation.
- Existing internal `review_request` rows in `queued`, `running`, or
  `completed` state for the same PR head SHA.

The key should include PR identity and head SHA:

```text
artifact_kind + artifact_provider + artifact_ref + artifact_version
```

For a GitHub PR, that maps to:

```text
artifact_kind     = pull_request
artifact_provider = github
artifact_ref      = owner/repo#123
artifact_version  = head_sha
```

A new commit invalidates prior review satisfaction unless the existing
GitHub auto-review or internal review explicitly targets the new head
SHA.

Known AI reviewer identities should be workspace-configurable, with
safe defaults for the hooks currently used in our repos.

## Cross-Model Reviewer Selection

The reviewer should use a different model family from the author when
possible:

| Authoring provider family | Preferred reviewer family |
|---|---|
| `openai` | `anthropic` |
| `anthropic` | `openai` |
| local / OpenAI-compatible unknown provider | workspace default reviewer, preferring frontier cloud |
| other cloud provider ID | workspace default reviewer with different provider if available |

Selection should be policy-driven rather than hardcoded into the
manager prompt:

1. Read authoring provider/model from the broker run, execution profile,
   or PR metadata written by the authoring agent. Provider-family
   decisions are keyed on provider IDs only; runner kinds such as
   `openai_codex` or `claude_code` are metadata for how the work ran,
   not provider-family identifiers.
2. Resolve a reviewer candidate from workspace routing rules or a
   dedicated `reviewer` agent role.
3. Prefer an opposite provider family.
4. If no opposite family is configured, use the default reviewer and
   record `cross_model=false` in the review request.
5. If no reviewer can be resolved, escalate or leave the work item
   blocked according to policy.

The prompt should make the model-family choice visible to the manager,
but the actual selection should live in code so it is testable.

## Data Model

Harper-server owns all database changes for this scope. The migration
and RLS details live in the Harper-server companion scope:
[`docs/review-request-schema-scope.md`](https://github.com/harper-hq/harper-server/blob/main/docs/review-request-schema-scope.md).

Platform owns the contract that reads/writes the table and should expect
a generic `review_request` relation with this logical shape:

```sql
CREATE TABLE review_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  subject_work_item_id uuid REFERENCES work_items(id),
  review_work_item_id uuid REFERENCES work_items(id),
  resource_id uuid REFERENCES workspace_resource(id),
  author_agent_id uuid REFERENCES agent(id),
  reviewer_agent_id uuid REFERENCES agent(id),
  artifact_kind text NOT NULL,
  artifact_provider text NOT NULL,
  artifact_ref text NOT NULL,
  artifact_version text NOT NULL,
  artifact_locator jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_review_id text,
  state text NOT NULL CHECK (
    state IN ('queued', 'running', 'completed', 'failed', 'skipped')
  ),
  skip_reason text,
  author_provider_family text,
  reviewer_provider_family text,
  cross_model boolean NOT NULL DEFAULT false,
  verdict text CHECK (
    verdict IN ('approved', 'changes_requested', 'commented', 'failed')
  ),
  summary text,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX review_request_one_active_per_artifact_version
  ON review_request(
    workspace_id,
    artifact_kind,
    artifact_provider,
    artifact_ref,
    artifact_version
  )
  WHERE state IN ('queued', 'running', 'completed');
```

`skipped` means the system found an existing external review or
in-flight external review for that artifact version and deliberately did
not dispatch an internal reviewer. It is intentionally **not** part of
the active-version unique index: if the external review disappears,
fails, or never completes for the same version, a later manager sweep
must be able to insert a real `queued` internal review request.

Why this is not just a `work_items` column:

- a single artifact may have multiple review observations and attempts;
- review validity is versioned by artifact version / PR head SHA;
- skipped external review observations are useful history but must not
  block later internal review;
- review verdicts and findings are gate inputs, not the work item
  itself.

`work_items` still participates: when the manager actually dispatches a
reviewer, it can create or schedule a review work item and link it via
`review_work_item_id`. The `review_request` row remains the durable
ledger for duplicate suppression and gate evaluation.

`workspace_resource` also participates when the reviewed artifact is a
durable resource, such as a document, repository, website, or report.
`resource_id` is nullable because some review targets, especially a PR
head SHA or one-off generated artifact, may not have been promoted to a
workspace resource yet.

## Platform Changes

### Contracts

Add `contracts/review-request.ts`:

- `ReviewRequestStateSchema`
- `ReviewVerdictSchema`
- `ReviewFindingSchema`
- `ReviewRequestSchema`
- `CreateReviewRequestSchema`

Findings should be similar to:

```typescript
type ReviewFinding = {
  severity: "info" | "warning" | "blocking";
  category:
    | "correctness"
    | "tests"
    | "scope"
    | "security"
    | "style"
    | "documentation"
    | "maintainability"
    | "unknown";
  message: string;
  file_path?: string;
  line?: number;
  suggested_action?: string;
};
```

### API / Services

Add service boundaries rather than putting GitHub logic directly in
routes:

- `PrReviewDetector`
  - checks GitHub reviews / checks / workflow runs
  - checks internal `review_request`
  - returns `missing`, `present`, or `in_flight`
- `ReviewerResolver`
  - determines authoring provider family
  - chooses a reviewer agent / execution profile
  - marks whether the choice is cross-model
- `ReviewRequestsRepository`
  - owns insert/update/list operations
  - enforces one active request per artifact version

Add runtime/manager-facing routes:

- `POST /api/work-items/:id/pr-review/check`
  - returns whether review exists / is in flight / is missing
  - includes reason and detected external review/check metadata

- `POST /api/work-items/:id/pr-review/dispatch`
  - re-runs duplicate detection transactionally
  - inserts `skipped` if external review exists
  - inserts `queued` and returns reviewer routing info if missing

- `PATCH /api/review-requests/:id`
  - runtime writes `running`, `completed`, or `failed`
  - validates verdict and findings

## Runtime Companion Work

The runtime should expose this to the manager agent as a tool, not as an
automatic hidden phase.

Tool name:

```text
manager.request_pr_review
```

Tool behavior:

1. Input: work item id or PR identity.
2. Calls platform duplicate-detection endpoint.
3. If review exists or is in flight, returns a no-op result with the
   detected review metadata.
4. If review is missing, dispatches a reviewer agent using the selected
   cross-model routing.
5. Records the review request id in the manager run transcript.

The manager prompt should instruct the manager to call this tool before
marking a PR as review-satisfied. It should also explicitly say not to
request another review when the tool reports an existing auto-review.

## Reviewer Agent Prompt

The reviewer receives:

- PR URL and head SHA.
- Original work item instructions.
- Authoring agent/provider metadata.
- Diff or repository checkout instructions.
- Review criteria from workspace policy.
- Required output schema.

The reviewer should publish review feedback in the same place a human
reviewer would consume it, preferably a GitHub PR review when credentials
allow. The platform still persists the structured verdict/findings so
gates can consume them without scraping GitHub.

## Gate Integration

This scope makes `peer-review` satisfiable. It does not merge.

A future auto-merge gate evaluator should consider `peer-review`
satisfied when any of these are true for the current PR head SHA:

- trusted GitHub auto-review completed with approval / no blocking
  findings
- internal `review_request.state = 'completed'` with verdict
  `approved` or `commented` and no blocking findings
- workspace policy explicitly waives peer review for this work item

`changes_requested` should queue the authoring agent with the review
feedback. If the author cannot continue or the review identifies a
policy issue, the runtime can escalate through the attention queue.

## Observability

Emit events:

- `pr_review.detected_existing`
- `pr_review.dispatch_requested`
- `pr_review.dispatch_skipped`
- `pr_review.started`
- `pr_review.completed`
- `pr_review.failed`

Events should include workspace id, subject work item id, review work
item id when present, artifact identity/version, author provider family,
reviewer provider family, and `cross_model`. PR-specific events should
also include repository, PR number, and head SHA.

## Acceptance Criteria

- Manager can ask for PR review through a tool using either work item id
  or PR identity.
- The tool checks for existing GitHub auto-review before dispatching.
- The tool does not dispatch a second reviewer when a review is already
  present or in flight for the same PR head SHA.
- When dispatching, the resolver prefers Anthropic for OpenAI-authored
  work and OpenAI for Anthropic-authored work.
- If cross-model review is unavailable, the fallback reviewer is recorded
  with `cross_model=false`.
- Review request/result is persisted and queryable by work item,
  artifact identity/version, and PR head SHA for GitHub PRs.
- A completed review with requested changes can be fed back into the
  authoring agent's next turn.
- Tests cover duplicate detection, cross-model selection, skipped
  requests, completed review writes, and changed-head-SHA behavior.

## Resolved Design Decisions

- V1 review is manager-orchestrated peer review, not author self-review.
- Existing GitHub auto-review wins; do not duplicate it.
- Different model family is preferred for internal review.
- Review dispatch should be a manager tool so the manager can reason
  about when to call it.

## Open Questions

1. What exact GitHub identities / check names should count as trusted
   auto-review for the default workspace config?
2. Where is the most reliable source for authoring provider family:
   broker run metadata, execution profile snapshot, PR metadata, or a
   new explicit field written when the PR is created?
3. Should the internal reviewer always publish a GitHub review, or is a
   persisted platform review enough for v1 when GitHub credentials are
   unavailable?
4. Should `peer-review` gate satisfaction require approval, or can
   `commented` with no blocking findings count?

## Rollout Plan

1. Add contracts and `review_request` persistence.
2. Implement duplicate detection against internal rows first, then
   GitHub reviews/checks.
3. Implement reviewer resolver with cross-model preference.
4. Add manager tool and runtime dispatch path.
5. Add reviewer result persistence and feedback handoff to authoring
   agent.
6. Wire read-only UI visibility on work item / plan detail.
