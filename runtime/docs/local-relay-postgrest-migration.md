# Local-relay DB access: Ecto Repo → PostgREST, and removing the Repo

_High-level summary of why we made this change. Not a line-by-line changelog —
see the two PRs for that._

## The problem

The local runtime helper (a daemon on a user's machine) connects to the cloud
orchestrator over a WebSocket so a cloud agent can use a model running on that
machine. Two things happen on that socket against Supabase:

- **Token validation** — authenticate the helper's bearer token against
  `local_runtime_token` / `local_runtime_machine`.
- **Presence recording** — refresh `last_seen_at` / advertised runner kinds so
  the platform UI can show the helper as online.

In production both were implemented with Ecto, through `SymphonyElixir.Repo`.
But `Repo` only starts when `SUPABASE_POOLER` (a direct-Postgres connection
string) is configured, and **the production launcher escript never sets it**.
So every helper connection crashed token validation with `"could not lookup
Ecto repo SymphonyElixir.Repo"`, which surfaced as `:validator_unavailable` —
and every relay connection was rejected. Presence writes failed the same way,
so even a hypothetically-authenticated helper would never show as online.

This was not a new class of bug. The manager scheduler hit the identical
`Repo`-not-started crash earlier and was fixed by going PostgREST-only. The
relay path was simply the next place the same root cause surfaced.

## Why PostgREST, not "just configure the pooler"

Provisioning `SUPABASE_POOLER` for the orchestrator would start `Repo` and make
the Ecto code work. We deliberately did not do that:

- The launcher escript talks to Supabase over **PostgREST + the service-role
  key it already holds**. That's one credential, one client, one set of
  patterns — and no pooler to provision, keep alive, or forget on the next
  deploy.
- The pooler approach is exactly the fragile env-var dependency that caused the
  outage. Adding it back trades a permanent fix for a latent foot-gun.
- It also kept drift alive: some DB paths on PostgREST, one on Ecto. Picking a
  single way to reach the database was the explicit goal.

We confirmed the design before writing code by running the exact embedded
inner-join query and the presence columns **read-only against the production
Supabase project** with the service-role key.

## What changed

- **PR1** — ported `LocalRelay.TokenValidator` and
  `LocalRelay.MachineHeartbeatRecorder` to `PostgRESTClient`. Token validation
  is a single embedded inner-join GET (token + machine, both `revoked_at`
  null); presence is an `id`-keyed PATCH. The Ecto `.DB` adapters were deleted
  (no compatibility shim).
- **PR2** — removed `SymphonyElixir.Repo` entirely (it had no remaining
  callers), along with its supervision-tree start, its health-endpoint field,
  the `ecto_repos` config, the `repo_smoke_test`, and the `ecto_sql` /
  `postgrex` dependencies. `ecto` stays only for in-memory schemas and
  changesets.

## The lasting invariant

There is no direct Postgres connection in the launcher path anymore. All DB
access is PostgREST over the service-role key. `SUPABASE_POOLER` is no longer
read by anything. See "Database Connection Conventions" in `CLAUDE.md`.

## Authorization note

The orchestrator connects as the Supabase **service role**, which bypasses RLS.
That was already true with Ecto (its pooler connection was equally privileged),
so this migration does not change the trust model. Per-workspace / per-machine
scoping is enforced at the application layer: the token lookup returns the
`workspace_id` / `machine_id` bound to the presented token, and every
subsequent relay operation is keyed off that validated identity.
