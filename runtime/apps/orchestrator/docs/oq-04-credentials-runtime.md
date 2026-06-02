# OQ-04 — Runtime-side: `Credentials` resolution + redaction + lints

Runtime-scoped companion to the canonical multi-repo plan in
`parallel-agent-platform/docs/oq-04-credentials-pr-plan.md`.

This doc is for runtime engineers picking up **PR 6** of the
OQ-04 plan without crossing repos. It restates only the runtime
work — the new `Credentials` module, the prompt-redactor
middleware, the Credo lint guard, and the per-runner migration.

The other PRs in OQ-04 (harper-server migrations, platform
service / API / UI, audit log) live elsewhere; they're
referenced here only as dependencies.

## Why this matters

Today's runtime reads raw API keys out of config maps:

```elixir
# apps/orchestrator/lib/symphony_elixir/runner/openclaw.ex
api_key = Map.get(config, "api_key")
```

Plaintext gets passed around the runtime, no redaction on
outbound prompts, no audit. OQ-04 closes those gaps with a
proper resolution API + a redaction middleware + a CI lint that
fails the build if a secret string lands in any audit-bound
column.

## Dependencies before runtime work starts

| Dep | Lives in | Status |
|---|---|---|
| Encrypted columns (`credential.secret_encrypted`, `key_id`) | harper-server | OQ-04 PR 1 (harper-server #488) — schema baseline; PR 2 — encryption helpers (`pgsodium` AEAD functions). |
| `decrypt_credential(secret_encrypted, key_id, workspace_id, user_id)` SQL function | harper-server | OQ-04 PR 2 |
| `credential_alias` table + scope-immutability trigger | harper-server | OQ-04 PR 1 |
| `credential_resolution` audit table | harper-server | OQ-04 PR 7 |

PR 6 starts when at minimum OQ-04 PR 2 is merged.

## PR 6 (this doc's focus) — `feat/credentials-resolution`

### Files to create

- `apps/orchestrator/lib/symphony_elixir/credentials.ex` — the resolution API
- `apps/orchestrator/lib/symphony_elixir/credentials/resolved.ex` — the struct
- `apps/orchestrator/lib/symphony_elixir/credentials/prompt_redactor.ex` — outbound-prompt scrub
- `apps/orchestrator/lib/symphony_elixir/credentials/credo_check.ex` (or in `priv/credo/credo.exs` config) — Credo lint rule

### Files to modify

- `apps/orchestrator/lib/symphony_elixir/runner/codex.ex`
- `apps/orchestrator/lib/symphony_elixir/runner/openclaw.ex`
- `apps/orchestrator/lib/symphony_elixir/runner/computer_use.ex`
- `apps/orchestrator/lib/symphony_elixir/runner/planner.ex`
- `apps/orchestrator/lib/symphony_elixir/runner/manager.ex`

### `ResolvedCredential` struct

```elixir
defmodule SymphonyElixir.Credentials.Resolved do
  @moduledoc """
  Resolved credential. The plaintext field is intentional and explicit;
  callers must access via `secret/1` or `with_secret/2`, never via
  string interpolation or `Kernel.inspect/1`.
  """
  @enforce_keys [:id, :kind, :display_name, :user_id]
  defstruct [:id, :kind, :display_name, :workspace_id, :user_id, :_plaintext]

  @type t :: %__MODULE__{
          id: binary(),
          kind: String.t(),
          display_name: String.t(),
          workspace_id: binary() | nil,
          user_id: binary(),
          _plaintext: String.t()
        }

  @doc "Yields the plaintext to the given function and discards it."
  def with_secret(%__MODULE__{_plaintext: pt}, fun) when is_function(fun, 1), do: fun.(pt)

  @doc "Direct accessor — use sparingly; prefer with_secret/2."
  def secret(%__MODULE__{_plaintext: pt}), do: pt

  defimpl Inspect do
    def inspect(c, _opts), do: "#ResolvedCredential<id=#{c.id} kind=#{c.kind} REDACTED>"
  end

  defimpl String.Chars do
    def to_string(c), do: "<ResolvedCredential id=#{c.id} kind=#{c.kind} REDACTED>"
  end
end
```

### `Credentials.resolve/2`

```elixir
defmodule SymphonyElixir.Credentials do
  alias SymphonyElixir.Credentials.Resolved

  @type resolve_input ::
          {:credential_id, binary()}
          | {:alias, alias :: String.t(), workspace_id :: binary()}
          | {:kind, kind :: String.t(), workspace_id :: binary(), user_id :: binary()}

  @type resolve_error ::
          :cross_workspace
          | :not_found
          | {:no_default_credential_for_kind, kind :: String.t()}

  @spec resolve(resolve_input(), ctx :: %{acting_user_id: binary()}) ::
          {:ok, Resolved.t()} | {:error, resolve_error()}
  def resolve({:credential_id, id}, ctx), do: resolve_by_id(id, ctx)
  def resolve({:alias, alias, ws}, ctx), do: resolve_by_alias(alias, ws, ctx)
  def resolve({:kind,  kind, ws, uid}, ctx), do: resolve_by_kind(kind, ws, uid, ctx)

  # Each resolver:
  #   1. Calls the harper-server SQL via the existing service-role
  #      Supabase connection
  #   2. Selects credential row + decrypts via
  #      public.decrypt_credential(secret_encrypted, key_id,
  #                                workspace_id, user_id)
  #   3. Wraps in Resolved struct
  #   4. Registers the plaintext with PromptRedactor (see below)
  #   5. Emits an audit row to public.credential_resolution
  #      (fire-and-forget; PR 8)
end
```

**Three-tier lookup precedence** (mirrors the platform spec — if you change one side, change the other):

1. By explicit `credential_id` — direct lookup, gated on `(workspace match) OR (workspace_id IS NULL AND user_id = acting user)`.
2. By alias — resolve `(workspace_id, alias)` first; on miss, fall back to user-scoped alias `(user_id, alias)`. Workspace-precedence.
3. By kind — workspace's `default-<kind>` alias first; on miss, the user's single user-only credential of that kind. Workspace-precedence.

Errors:
- `{:error, {:no_default_credential_for_kind, kind}}` — kind-only resolve with no default
- `{:error, :cross_workspace}` — credential exists but not in the dispatch workspace
- `{:error, :not_found}`

### Outbound prompt redaction

```elixir
defmodule SymphonyElixir.Credentials.PromptRedactor do
  @moduledoc """
  Per-process registry of plaintext credential values seen during a turn.
  Outbound LLM-call helpers run prompts through `redact/1` before the wire,
  replacing each registered value with `<redacted>`. Belt-and-suspenders
  against accidental credential leakage in prompts.
  """

  def register(plaintext) when is_binary(plaintext) and byte_size(plaintext) > 0,
    do: Process.put({:credential_redact, plaintext}, true)

  def redact(prompt) when is_binary(prompt) do
    Process.get_keys()
    |> Enum.flat_map(fn
      {:credential_redact, pt} when is_binary(pt) -> [pt]
      _ -> []
    end)
    |> Enum.reduce(prompt, fn pt, acc -> String.replace(acc, pt, "<redacted>") end)
  end

  def redact(other), do: other
end
```

**Where to call `redact/1`:** in the runner's HTTP-call helper, immediately before serializing the request body. Apply to the entire serialized body (string or map → JSON) so it catches plaintexts anywhere in the structure.

**Registration point:** each runner's `start_session/2` calls `PromptRedactor.register(Resolved.secret(credential))` after a successful resolve.

### Credo lint rule

`apps/orchestrator/priv/credo/checks/banned_secret_strings.ex` (or wherever the project keeps custom Credo checks).

Banned substrings in any string literal that lands in an audit-bound column:

- `"secret"`
- `"api_key"`
- `"access_token"`
- `"refresh_token"`
- `"bearer"`

Targets — fail the build if any of those substrings appears in:
- A map literal whose key is `:label`, `:labels`, `:metadata`, or `:payload` and whose context is a `WorkItem`, `RunnerEvent`, or `Escalation` write
- An `Ecto.insert!` / `Repo.insert!` call to those tables

Allowlist — explicitly tag fixtures and docstrings that legitimately contain these substrings with `# credo:disable-for-next-line BannedSecretStrings`.

### Per-runner migration

One example — `runner/openclaw.ex`. Repeat the same shape for each.

```elixir
# Before:
def start_session(config, _workspace) do
  base_url = Map.fetch!(config, "base_url")
  api_key  = Map.get(config, "api_key")
  {:ok, %{base_url: base_url, api_key: api_key, ...}}
end

# After:
def start_session(config, _workspace) do
  with {:ok, cred} <- SymphonyElixir.Credentials.resolve(
         resolve_input_from(config),
         %{acting_user_id: config["user_id"]}
       ) do
    SymphonyElixir.Credentials.PromptRedactor.register(
      SymphonyElixir.Credentials.Resolved.secret(cred)
    )

    base_url = Map.fetch!(config, "base_url")
    {:ok, %{base_url: base_url, credential: cred, ...}}
  end
end

# Helper translates the runner's config into a resolve_input tuple:
defp resolve_input_from(%{"credential_id" => id}) when is_binary(id),
  do: {:credential_id, id}
defp resolve_input_from(%{"credential_alias" => alias, "workspace_id" => ws}),
  do: {:alias, alias, ws}
defp resolve_input_from(%{"workspace_id" => ws, "user_id" => uid}),
  do: {:kind, "openclaw", ws, uid}  # falls back to workspace's default-openclaw / user's default
```

After this PR, **no runner reads `Map.get(config, "api_key")` directly.** Grep should return zero hits in the five touched runner files.

### Caching

None in v1. The service-role Supabase connection is fast enough that 50 work_items in one manager batch making 50 resolve calls is fine. Add caching only if profiling shows a hot spot, and explicitly document the TTL so a leaked plaintext can't outlive its credential row.

### Testing

- ExUnit: `Credentials.resolve/2` round-trips against a fixture DB seeded with encrypted credentials. All three input shapes covered.
- ExUnit: `Resolved` struct's `Inspect` and `String.Chars` impls render the redacted form. **Adversarial test:** wrap the resolved credential in `Jason.encode!(%{cred: cred, error: %{cred: cred}})` and assert the plaintext does NOT appear in the output.
- ExUnit: `PromptRedactor.redact/1` substitutes `<redacted>` for any registered plaintext, even if it appears multiple times or inside nested JSON.
- Outbound HTTP test: stub the runner's HTTP client and verify the wire-level body never contains the plaintext for a successfully-registered credential.
- Credo: artificial test fixture file with `[api_key: "sk-…"]` in a `WorkItem.labels` write fails the build.
- Cross-workspace resolve: requesting a credential by id from a workspace the user isn't a member of returns `{:error, :cross_workspace}`.
- All five existing runners migrated; CI green; integration tests pass; `git grep -nE 'Map.get\(config, "api_key"\)' apps/orchestrator/lib/symphony_elixir/runner/` returns zero matches.

## What's deliberately out of scope for this runtime PR

- Schema changes (PRs 1, 2, 7 in harper-server)
- Platform-side `Credentials.resolve` (PR 3 in `parallel-agent-platform`)
- API endpoints (PR 4 in `parallel-agent-platform`)
- UI (PR 5 in `parallel-agent-platform`)
- Audit-log writes from the runtime side (PR 8 — runtime half — separate follow-up)

## Cross-references

- Canonical multi-repo plan: `parallel-agent-platform/docs/oq-04-credentials-pr-plan.md` (PR [#113](https://github.com/kmgrassi/parallel-agent-platform/pull/113))
- The OQ-04 decision: `parallel-agent-platform/docs/open-questions/oq-04-per-task-model-overrides-credentials.md`
- Schema baseline (PR 1, in flight): [harper-server#488](https://github.com/harper-hq/harper-server/pull/488)
- Runner abstraction this hooks into: `apps/orchestrator/lib/symphony_elixir/runner.ex`
- Existing reference runners alongside the credential migration: `runner/{codex,planner,openclaw,computer_use,mock}.ex`
- Manager-agent PR plan (its own `dispatch_runner` tool also needs `Credentials.resolve`): `apps/orchestrator/docs/manager-agent-pr-plan.md`
