# OQ-11: OAuth authentication for cloud-running agents

> Open question (added 2026-04-25):
>
> "How could we do OAuth authentication for the agents that are
> running in the cloud? For Codex, you can authenticate with the API
> key, or you can authenticate with OAuth. It would be great to be
> authenticated with OAuth, because that uses the SaaS tool, as
> opposed to pay per token."

## ✅ Decision (2026-04-25): Option B with first-class frontend tooling

We're going with **Option B** — user-pasted (well, dashboard-
captured) refresh token, stored encrypted in the existing
`credential` table. The credential row is the system of record;
cloud agents mint short-lived access tokens from it at dispatch
time.

**But we don't make the user run a CLI and paste a token.** The
dashboard ships a **"Connect <Provider>" button** for each
supported OAuth provider. Clicking it walks the user through the
provider's OAuth flow and lands a new `credential` row
automatically. See *[Frontend OAuth tooling](#frontend-oauth-tooling)*
below.

The original concern about "local-only by default to escape TOS
risk" is preserved — `credential.runtime_binding` stays in the
schema (`local-only` | `cloud-allowed`). Connect-buttons default
new credentials to `cloud-allowed` only when the provider's TOS
allows it; otherwise they default to `local-only` and require
the local-runtime connector ([OQ-02](./oq-02-local-runtime-connector.md)).

## Why this matters

A user running Codex (or Claude Code, ChatGPT, etc.) on their own
laptop typically signs in via OAuth and uses their existing **flat-
rate subscription** (ChatGPT Plus, Claude Pro, Cursor Pro, …). The
LLM call is "free" at the margin from their perspective.

The same user, running the same agent in our cloud orchestrator, is
forced into **API key billing** today — pay per token. For heavy
fan-out workloads this is wildly more expensive than the
subscription they're already paying for.

If we want users to comfortably run real workloads, we need to get
their subscription-backed OAuth identity into the cloud-side
runner.

## The hard part

OAuth was designed around a *human-in-the-browser* finishing the
authorization redirect. Cloud-Fargate-running agents do not have
browsers and do not have a user sitting at the keyboard.
Additionally:

- **Refresh tokens are bearer credentials.** Whoever holds them can
  use the subscription. We need to treat them with the same care as
  API keys.
- **Token rotation.** Refresh tokens may rotate on use; we must
  persist the rotated value.
- **Provider Terms of Service.** Many SaaS subscriptions explicitly
  prohibit "shared use" or programmatic access via the
  subscription endpoint. We must surface that risk to the user (it
  is *their* subscription and *their* TOS — not ours to violate on
  their behalf, but we can warn them and let them choose).
- **Provider lock-in.** Each provider's OAuth flow is different and
  their token formats / refresh semantics differ.

## Options

### Option A: API key only (status quo)

Don't support OAuth at all. Document that the cloud uses pay-per-
token billing and direct users to API keys.

- **Pros:** Simplest. Avoids the TOS minefield.
- **Cons:** Wastes the user's existing subscription. Makes us
  expensive vs. local equivalents. Loses a real differentiator.

### Option B: User-pasted refresh token (cloud-stored)

User performs the OAuth flow on *their own machine* (using the
provider's CLI or our helper), then pastes the resulting
**refresh token** into the dashboard. We store it, encrypted, in
the `credential` table. Cloud agents use it to mint short-lived
access tokens.

- **Pros:** Works today with any OAuth provider that issues a
  long-lived refresh token. No new infra.
- **Cons:** UX friction (user must run a CLI). We hold a long-lived
  bearer credential — meaningful blast radius if breached. Some
  providers explicitly bind refresh tokens to "this machine"
  fingerprints; tokens stop working when used from a different IP.

### Option C: Headless OAuth in cloud with user-on-phone confirmation

Spin up a transient browser inside our cloud (Playwright in a
sandboxed container) to perform the OAuth flow, push the
verification step to the user's phone (push notification or email
with a one-time code).

- **Pros:** Self-service in-product. Looks professional.
- **Cons:** Significant engineering for a feature we can punt on.
  Brittle when providers change OAuth UI. Doesn't escape the TOS
  question.

### Option D: Local-runtime forwarding (recommended for OAuth-bound providers)

Cloud orchestrator dispatches to the user's **local runtime** (see
[OQ-02](./oq-02-local-runtime-connector.md)) for any task whose
routing rule resolves to an OAuth credential. The local box already
has the OAuth login (because the user did it in their normal
provider client). The cloud never sees the refresh token.

- **Pros:** Cleanest security story — refresh tokens never leave
  the user's machine. Side-steps provider TOS concerns about
  "shared use" — it's the user's machine running the user's
  client. Reuses infrastructure we're already building.
- **Cons:** Requires the user's local box to be online. The
  parallelism ceiling is bounded by the user's local concurrency,
  not the cloud.

### Option E: Hybrid of B and D (recommended overall)

- Default to **D** when a routing rule references an OAuth
  credential — work runs on the user's local runtime.
- Allow **B** as an explicit opt-in for users who understand the
  risk and want cloud-side execution (e.g., overnight runs while
  their laptop is closed). Surface a clear warning at credential-
  creation time about TOS / blast radius.
- Both are surfaced as `credential.kind = oauth_subscription`; the
  routing rule just declares "use this credential" and the
  dispatcher decides where to run the task based on
  `credential.runtime_binding` (`local-only` vs `cloud-allowed`).

## Recommendation

**Option E — hybrid, defaulting to D.** Concretely:

1. Add `credential.kind = oauth_subscription` and store
   `provider`, `runtime_binding` (`local-only` | `cloud-allowed`),
   `refresh_token_encrypted`, `expires_at`, `scope`.
2. When `runtime_binding = local-only` (the default), the
   orchestrator's dispatcher routes tasks for that credential to
   any online local runtime owned by the credential's workspace.
   No refresh token leaves the user's machine.
3. When `runtime_binding = cloud-allowed`, refresh token lives
   encrypted in `credential.secret` (envelope encryption per
   [OQ-04](./oq-04-per-task-model-overrides-credentials.md)) and
   cloud agents may use it. Big yellow warning at credential
   creation: *"Cloud-stored OAuth tokens may violate your
   subscription's terms of service and represent a wider blast
   radius than API keys. Consider keeping local-only."*
4. We ship a tiny CLI (`harper-cli oauth login --provider=codex`)
   that does the OAuth dance on the user's machine and writes the
   token to the local runtime config (for `local-only`) or POSTs
   it encrypted to the platform (for `cloud-allowed`). User never
   pastes raw tokens.

## Provider-specific notes

- **Codex / OpenAI subscription** — OAuth flow exists; refresh
  tokens issued. TOS unclear about programmatic re-use; default to
  `local-only`.
- **Claude Code / Anthropic subscription** — OAuth via the desktop
  client; tokens are machine-bound. **Probably local-only forever.**
- **Cursor / Continue / etc.** — Each has its own auth surface;
  treat each as a `credential.provider` and grow the supported
  list as users ask.
- **API keys remain a first-class credential kind** for users who
  want pay-per-token billing or whose provider doesn't offer
  OAuth.

## Frontend OAuth tooling

Per-provider **"Connect <Provider>" buttons** in the Credentials
page of the dashboard. Each button:

1. Fires a server-initiated OAuth flow against that provider.
2. Opens the provider's auth UI in a popup (or iframe where
   allowed).
3. On callback, our server exchanges the auth code for tokens,
   encrypts via KMS (per [OQ-04](./oq-04-per-task-model-overrides-credentials.md)),
   and inserts a `credential` row.
4. Surfaces a success state with: provider, account email/name,
   `runtime_binding` (default decided by provider — see table
   below), `expires_at`, and a "Test" button that pings the
   provider with a 1-token call.
5. Adds "Rotate" and "Revoke" buttons for the row's lifetime.

### Per-provider flow notes

| Provider     | OAuth flow shape                              | Default `runtime_binding` | Notes |
|--------------|-----------------------------------------------|---------------------------|-------|
| OpenAI       | Standard OAuth2 authorization code (PKCE) against the OpenAI auth server. Scopes: subscription LLM access. | `cloud-allowed` (subscription terms allow programmatic agent use as of doc date — confirm with legal before launch) | Refresh tokens rotate on use; we persist the rotated value. |
| Anthropic / Claude | OAuth flow currently exists only via the desktop client; tokens are machine-bound. | `local-only` (cannot reliably move tokens off the machine that issued them) | Connect button installs the `harper-runtime` daemon and triggers the local OAuth flow there, then registers a `credential` row pointing at the local machine. |
| Google (Vertex AI / OAuth-bound Gemini access) | Standard Google OAuth2. | `cloud-allowed` | Standard Google flow, refresh tokens stable. |
| Cursor / Continue / etc. | Each has its own auth surface. | TBD per provider | Add when a customer asks. |
| GitHub (App install for repo access) | GitHub App installation flow. | `cloud-allowed` (orgs grant install scope explicitly) | Different shape — installs an App, not a personal OAuth. Same `credential` row, `kind = github_app_install`. |

### UI sketch

```
Credentials  +  [Connect ▼]
                   • Connect OpenAI
                   • Connect Anthropic (local-only)
                   • Connect Google
                   • Connect GitHub
                   • Add API key…

┌─────────────────────────────────────────────────────────────┐
│ ✓ OpenAI — kevingrassi@…   cloud-allowed   exp Apr 30        │
│   [Test] [Rotate] [Revoke]                                   │
├─────────────────────────────────────────────────────────────┤
│ ✓ Anthropic — Claude Pro    local-only     no expiry        │
│   Connected via `harper-runtime` on `kevin-mbp`              │
│   [Test] [Reconnect on machine] [Revoke]                     │
├─────────────────────────────────────────────────────────────┤
│ ✓ GitHub App: harper-orchestrator   2 repos                 │
│   [Manage in GitHub] [Revoke]                                │
└─────────────────────────────────────────────────────────────┘
```

### Server-side OAuth callback flow

```
browser pops /oauth/<provider>/start
   │
   ▼
backend redirects to provider's authorize URL
with state = signed(workspace_id + nonce)
   │
   ▼  user authorizes
   ▼
provider redirects to /oauth/<provider>/callback?code=…&state=…
   │
   ▼
backend:
   1. validates state signature → workspace_id
   2. exchanges code for tokens
   3. envelope-encrypts refresh token via KMS
   4. inserts credential row
   5. fetches account display name (for the UI)
   6. closes popup with postMessage to opener
```

### Edge cases the buttons must handle

- **Reconnect after expiry.** If a token's refresh fails (user
  revoked on the provider side, scope changed, etc.), the
  credential row's row is marked `expired` and the dashboard
  shows a single-click "Reconnect" — same flow as initial
  connect, updates the existing row instead of inserting a new
  one.
- **Multi-account.** A user with two ChatGPT accounts (personal +
  work) should be able to add both. The credential row's
  `display_name` distinguishes them; routing rules
  ([OQ-03](./oq-03-routing-config-schema.md)) reference the
  specific `credential_id`.
- **OAuth flow abandoned.** If the user closes the popup without
  finishing, we do not create a row; the `state` token expires
  after 10 minutes.
- **Concurrent connect attempts.** Idempotent on `(workspace_id,
  provider, account_external_id)` — connecting the same provider
  account twice updates the existing row, doesn't duplicate.

This UI is what users actually interact with. The rest of this
doc is the security model that backs it.

## Concrete next step

- [ ] Add `credential.kind = 'oauth_subscription'` migration with
      `provider`, `runtime_binding`, `expires_at`, `scope`. (one PR
      in `parallel-agent-platform`)
- [ ] Implement `harper-cli oauth login --provider=...` for the
      first provider we want to support (recommendation: Codex).
      (one PR in `parallel-agent-runtime` or a new CLI package)
- [ ] Add dispatcher logic: if resolved credential is
      `oauth_subscription` and `runtime_binding == local-only`,
      route to the workspace's local runtime; if no local runtime
      online, escalate. (one PR in `parallel-agent-runtime`)
- [ ] Add token-refresh worker that re-mints short-lived access
      tokens from refresh tokens for cloud-allowed credentials.
      (one PR — only after the local-only path is shipped)
- [ ] Document the TOS-risk language in the credential creation
      flow. Get legal review on the warning copy. (one PR in
      `parallel-agent-platform`)

## Open sub-questions

- Do we **ever** allow a workspace to use *another user's*
  OAuth-subscription credential? Recommendation: no. Subscription
  credentials are per-user, never shared at workspace level. The
  credential row is owned by a `user`, not a `workspace`, and the
  routing rule references a user-scoped credential.
- How do we surface "your OAuth credential expired and your
  workspace's tasks are queueing up"? Recommendation: an
  escalation kind `credential_expired` that fires the moment a
  refresh fails.
- Provider rate-limit awareness: subscriptions have rate limits
  that API keys don't (or vice versa). Should the orchestrator
  back off automatically? Recommendation: yes, but model it as
  generic provider-side `429` handling, not OAuth-specific.
