# Pillar 5 — Local-Runtime-Friendly

> **Vision criterion:** A user with a local OpenClaw instance can
> register it via one command and have plan tasks dispatched to it
> transparently from the cloud.
> ([product vision](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/reference/product-vision.md))

> **Mirrored** across
> [platform](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/vision-gaps/05-local-runtime-friendly.md),
> [runtime](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/vision-gaps/05-local-runtime-friendly.md),
> [helper](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/vision-gaps/05-local-runtime-friendly.md).
> Edit all three together.

## Today

`local-runtime-helper` exists as a Go daemon with registration CLI,
config TOML parser, OpenAI-compatible runner adapter, and relay client
scaffolding. Runtime side has `SymphonyElixir.Runner.LocalRelay`
dispatching over the relay socket. The relay protocol is documented in
[`docs/local-relay-protocol.md`](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/local-relay-protocol.md).
Most of the architecture is designed; the gap is **finishing the
in-flight pieces** and **filling in the dashboard + adapter surface**.

## Progress

Tick a box when the gap area's scope has fully shipped (all PRs merged,
scope doc moved to `docs/shipped/`). See the
[umbrella README](README.md#maintenance-contract) for the maintenance
contract.

- [x] **5.1 Finish helper WSS connect/auth/register/heartbeat loop** — scope: [local-runtime-helper-pr-plan](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/local-runtime-helper-pr-plan.md), [local-helper-architecture-drift-pr-plan](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/local-helper-architecture-drift-pr-plan.md), [local-helper-relay-architecture-pr-plan](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/local-helper-relay-architecture-pr-plan.md). Helper relay client (`internal/relay/client.go`) holds a stable connection with bearer-token auth, heartbeat ACK, and exponential-backoff reconnect (1s–60s jittered).
- [x] **5.2 Local-machines dashboard view** — scope: [local-helper-page-scope](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/local-helper-page-scope.md), [local-helper-page-runtime-scope](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/local-helper-page-runtime-scope.md), [local-helper-page-helper-scope](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/local-helper-page-helper-scope.md), [multi-computer-workspace-ui-scoping](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/multi-computer-workspace-ui-scoping.md). `LocalRuntimesSection` ships with wizard, presence, install one-liner, per-machine status, and token rotation.
- [x] **5.3 OpenClaw-via-helper adapter** — scope: [local-openclaw-helper-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/local-openclaw-helper-scope.md), [(runtime)](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/local-openclaw-helper-scope.md), [(helper)](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/local-openclaw-helper-scope.md). Helper's `internal/runner/openclaw/` is implemented; UI runtime-kind discriminator selects OpenClaw; relay routes dispatches to the helper.
- [ ] **5.4 Runner SDK / documented third-party contract** — foundations only: [universal-tool-calling-plan](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/universal-tool-calling-plan.md); no external SDK doc yet

Closed: **3 / 4**.

## Gap areas

### 5.1 Finish helper WSS connect/auth/register/heartbeat loop

The helper's WSS connect → auth → register → heartbeat → reconnect
loop is partially implemented. OQ-02 PR 6 is the canonical work; until
it ships, the helper can't reliably hold a long-lived connection to
the cloud relay through network blips. Includes: token-based auth
ceremony, one-connection-per-token enforcement, exponential-backoff
reconnect, heartbeat ACK with diagnostic events on misses.

**Active scope docs:**
- [local-runtime-helper-pr-plan (helper)](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/local-runtime-helper-pr-plan.md)
  — canonical implementation plan for the helper.
- [local-helper-architecture-drift-pr-plan (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/local-helper-architecture-drift-pr-plan.md)
  — platform-side fix-ups to keep the architecture coherent.
- [local-helper-relay-architecture-pr-plan (runtime)](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/local-helper-relay-architecture-pr-plan.md)
  — runtime side of the relay architecture.
- [cloud-local-relay-pr-plan (runtime)](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/cloud-local-relay-pr-plan.md)
  — cloud → local dispatch path.
- [cloud-deployment-pr-plan (helper)](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/cloud-deployment-pr-plan.md)
  — helper-side deployment.

### 5.2 Local-machines dashboard view

There's no "your local machines" page in the web app — a user can't see
which of their machines are connected, which runners each one
advertises, helper version, last-heartbeat timestamp, etc. The vision
requires "Surface 'local agents available' in the dashboard with
health" — that page.

**Active scope docs:**
- [local-helper-page-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/local-helper-page-scope.md)
  — primary scope for the page.
- [local-helper-page-runtime-scope (runtime)](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/local-helper-page-runtime-scope.md)
  — runtime side of the page.
- [local-helper-page-helper-scope (helper)](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/local-helper-page-helper-scope.md)
  — helper side.
- [multi-computer-workspace-ui-scoping (runtime)](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/multi-computer-workspace-ui-scoping.md)
  — multi-machine UI considerations.

### 5.3 OpenClaw-via-helper adapter

The vision uses local OpenClaw as the v1 example. Today
`Runner.OpenClaw` exists in the runtime for cloud OpenClaw; a
local-OpenClaw runner adapter inside the helper does not yet ship. The
scope spans all three repos because the wire contract, the runner
selection, and the helper-side execution all need to line up.

**Active scope docs:**
- [local-openclaw-helper-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/local-openclaw-helper-scope.md)
  — platform side of the integration.
- [local-openclaw-helper-scope (runtime)](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/local-openclaw-helper-scope.md)
  — runtime side.
- [local-openclaw-helper-scope (helper)](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/local-openclaw-helper-scope.md)
  — helper side / the adapter itself.

### 5.4 Runner SDK / documented third-party contract

The vision asks for "a small runner SDK — well-documented contract a
community member could implement to add a `Runner.SomeTool` for any
tool." Today the helper has an internal `runner` interface
(`internal/runner/`) but it's not packaged or documented for external
implementers. Universal-tool-calling is the proximate foundation — a
clean, transport-agnostic tool-call contract makes a runner SDK
plausible.

**Active scope docs:**
- [universal-tool-calling-plan (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/universal-tool-calling-plan.md)
  — the universal tool-call contract.
- [universal-tool-calling-plan (runtime)](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/universal-tool-calling-plan.md)
  — runtime side.
- [universal-tool-calling-plan (helper)](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/universal-tool-calling-plan.md)
  — helper side.
- [unified-tool-contract-helper-prs (helper)](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/unified-tool-contract-helper-prs.md)
  — staged PRs implementing the contract on the helper.
- _No external-facing SDK doc / public contract spec yet._
