# OQ-04: Per-task model overrides — credentials

> Open question #4 from [docs/product-vision.md](../product-vision.md):
>
> "Per-task model overrides — credentials. If a workspace has multiple
> provider keys (Anthropic + OpenAI + a personal Llama endpoint), how
> do we route a task to a specific one without leaking credentials in
> labels? Likely answer: routing rules reference `credential_id`, not
> API keys directly. Confirm before building."

## ✅ Decision (2026-04-25)

**Confirmed:** routing rules pass `credential_id` (or a workspace-
scoped alias that resolves to one). The agent / runner reads the
credential from the database at dispatch time. Credentials are
**never** in labels, prompts, environment variables that get
echoed in logs, or runner-event payloads.

**Status of the underlying functionality:** *not yet built.* The
`credential` table exists in the schema but the resolution path —
encrypted secret storage, dispatcher-side decryption, audit
logging, and the FK from `routing_rule.credential_id` — is the
work this question implies. See *[Build sequence](#build-sequence)*
below.

The shape is now consistent with [OQ-03](./oq-03-routing-config-schema.md)'s
relational tables — `routing_rule.credential_id` is a real FK, not
a string in a JSON blob.

## What we know

- Supabase already has a `credential` table (per
  [canonical-supabase-types-audit.md](../canonical-supabase-types-audit.md)).
- A workspace can have **many** credentials of different kinds:
  - `anthropic_api_key`
  - `openai_api_key`
  - `openai_compatible_endpoint` (URL + bearer)
  - `oauth_refresh_token` (see
    [OQ-11](./oq-11-oauth-for-runners.md))
  - `aws_credentials`
  - `github_app_install`
- Labels are user-visible strings on tasks. Putting an API key —
  or even a hint — in a label is unacceptable.
- Routing rules choose runner + model + which credential. The
  credential reference must be a **stable, opaque ID**, not anything
  derivable.

## Confirmed: routing rules reference `credential_id`

`gateway_config.body.routing.rules[].dispatch.credential_ref` is the
**UUID of the `credential` row** (or a logical credential alias,
see below). At dispatch time:

1. Orchestrator resolves the rule against the task → gets
   `credential_ref`.
2. Orchestrator loads `credential` row from Supabase using the
   workspace-scoped service role.
3. Orchestrator decrypts the secret material (envelope encryption —
   see "secret storage" below) into a per-task in-memory struct.
4. Secrets are passed to the runner over the worker-bridge as part
   of the `dispatch` frame, then **forgotten**. Not logged. Not
   labelled. Not echoed in events.
5. The dispatch frame's secret fields are stripped before any
   audit-log persistence.

## Logical aliases vs raw IDs

Recommendation: support **both**, with aliases as the primary
surface.

```json
"credential_ref": "alias:default-claude"
"credential_ref": "credential:1f4a-…"
```

A workspace defines aliases in `gateway_config.body.credentials`:

```json
{
  "credentials": {
    "default-claude": "credential:1f4a-…",
    "default-openai": "credential:9c81-…",
    "personal-llama": "credential:7e22-…"
  }
}
```

Why: when a user rotates a credential, they update one alias
mapping, not every routing rule. Same pattern as DNS CNAMEs.

## Secret storage

- `credential.secret` column is encrypted with a per-workspace data
  key (envelope encryption).
- Data keys are wrapped with a KMS key.
- Plaintext only exists in orchestrator memory at dispatch time.
- Decryption requires both Supabase row access **and** KMS
  permission — defense in depth.

## Per-task overrides without leaking credentials

If a task wants to force a specific credential (rare, but supported):

- `task.metadata.dispatch.credential_alias = "personal-llama"`
- The router prefers explicit `task.metadata.dispatch.*` over
  `routing.rules[]`.
- Task labels never reference credentials — only the alias is in
  metadata, and metadata is workspace-private.

## Anti-patterns to forbid in code review

- Putting `credential_ref`, alias, or any provider hint in
  `work_item.labels`.
- Logging the resolved `credential.secret` anywhere — runner-side or
  orchestrator-side.
- Echoing credential material in the WS event stream.
- Templating credentials into prompts (this happens by accident with
  some agent frameworks — guard with a redaction pass on outbound
  prompt strings).

## Build sequence

The model is decided; the functionality is not built. This is the
order things should land:

1. **Audit the existing `credential` table.** Confirm columns:
   `id`, `workspace_id`, `kind`, `display_name`, `secret_encrypted`
   (bytea or text), `key_id` (KMS key reference), `created_at`,
   `expires_at` (nullable). Fill any gaps in a migration. (one PR
   in `parallel-agent-platform`)
2. **Envelope encryption.** Per-workspace KMS data key, per-row
   data key, plaintext only ever in orchestrator memory at dispatch
   time. Land helpers `Credentials.encrypt/2` and
   `Credentials.decrypt/2`. (one PR in `parallel-agent-platform`
   for the KMS plumbing; one PR in `parallel-agent-runtime` for
   the orchestrator-side helpers)
3. **`credential_alias` table** ([OQ-03](./oq-03-routing-config-schema.md)).
   A workspace-scoped name that resolves to a `credential.id`. (one
   PR — same migration as the `routing_rule` tables)
4. **Resolver.** `Credentials.resolve(rule_or_alias, workspace_id)`
   in the orchestrator. Loads the row, decrypts via KMS, returns a
   short-lived `%Credential.Resolved{}` struct that exists only
   for the current dispatch frame. Includes `Inspect` impl that
   redacts the secret so it never appears in logs / errors. (one
   PR in `parallel-agent-runtime`)
5. **FK from `routing_rule.credential_id` and
   `routing_rule.credential_alias` to the credential model.**
   Constraint: a rule references at most one of the two (covered
   by the check constraint in [OQ-03](./oq-03-routing-config-schema.md)).
6. **Dispatch-time wiring.** The dispatcher passes the resolved
   credential to the runner via the existing dispatch frame, in a
   `credential` field that is **stripped before audit-log
   persistence**. Update the worker-bridge frame schema to mark
   `credential` as a redacted field. (one PR in
   `parallel-agent-runtime`)
7. **Lint rules.** Credo (Elixir) and ESLint (TS) rules banning
   the strings `secret`, `api_key`, `access_token`,
   `refresh_token`, `bearer` in any field that maps to
   `work_item.labels` or any audit-log column. Run in CI. (one PR
   in each repo)
8. **Outbound prompt redaction pass.** Some agent frameworks
   accidentally template credentials into prompts. Add a final
   redaction pass on outbound prompt strings against the workspace's
   credential set (string-match the actual decrypted secret values
   and replace with `<redacted>`). Belt-and-suspenders. (one PR in
   `parallel-agent-runtime`)
9. **Audit-log table `credential_resolution`.** Write
   `(id, workspace_id, credential_id, task_id, runner_kind, resolved_at)`
   on every resolve call. No secret material — just the *fact* that
   a resolve happened. (one PR — schema in `parallel-agent-platform`,
   write site in `parallel-agent-runtime`)
10. **Credential management UI.** Create / list / rotate / revoke
    credentials and aliases in the dashboard. (one PR in
    `parallel-agent-platform`)
11. **"Test this credential" endpoint.** Pings the upstream provider
    with a 1-token call to confirm the credential is live. Used
    both at credential creation time and as a periodic
    health-check. (one PR — see also
    [OQ-11](./oq-11-oauth-for-runners.md))

## Open sub-questions

- Do we expose a "test this credential" endpoint? Recommendation:
  yes — pings the upstream provider with a 1-token call.
- How do we handle **credential expiry** for OAuth-based credentials
  (refresh tokens)? Covered in
  [OQ-11](./oq-11-oauth-for-runners.md).
