# Local Helper Page — Helper Scope

## Goal

Helper-side companion to the platform's "Local computer" wizard scope.
This doc owns the helper changes needed for the platform UI to render a
copy-pasteable install command, surface a helper version, and (later)
participate in invisible token rotation.

The wizard UX rests on three helper contracts:

1. A single `curl … | sh` install command pulls the right release binary
   onto the user's machine via `install.sh` hosted at a tagged GitHub
   release.
2. The register and heartbeat frames carry a `helper_version` field so
   the runtime can persist it and the platform UI can warn on stale
   versions.
3. The helper can atomically rewrite its config file when given a new
   token in a runtime-issued rotation hint (deferred to a later PR; this
   doc reserves the surface).

**Cross-repo companions:**
- Platform (wizard UI + manager dual-write): `parallel-agent-platform/docs/active/local-helper-page-scope.md`
- Runtime (heartbeat writes + version column): `parallel-agent-runtime/docs/local-helper-page-runtime-scope.md`

## What's already in place (do not re-scope)

| Concern | Where it lives |
| --- | --- |
| TOML config loading (`[machine]`, `[cloud]`, `[runner.*]`) | `internal/config/config.go` |
| `local-runtime-helper start` CLI entrypoint | `cmd/local-runtime-helper/main.go` |
| WebSocket register/heartbeat frames | `internal/relay/` (or equivalent — verify path) |
| OpenAI-compatible runner | `internal/runner/openai_compatible/` |
| Existing release pipeline (verify whether GitHub Releases are tagged) | `.github/workflows/release.yml` |
| Existing install docs | `docs/install.md`, `docs/launchd/`, `README.md` |

## Gaps this scope addresses

1. **No install one-liner.** Users currently `go install`, build from
   source, or manually download binaries. There's no `curl … | sh`
   that detects platform/arch and drops the right binary in a sane
   location.
2. **Heartbeat frame lacks a version.** Without
   `helper_version` in the wire frame, the runtime can't persist it
   and the platform can't surface "your helper is two versions
   behind."
3. **Config file writes aren't atomic.** Today the user hand-edits
   `~/.config/harper/runtime.toml`. For the deferred rotation flow
   (PR3 below) the helper needs to safely rewrite this file under a
   live connection. We need a safe-write helper now even though
   rotation lands later.
4. **No version string baked into builds.** The Go binary doesn't
   currently know its own version — `go build` without
   `-ldflags "-X main.version=…"` leaves the field empty. Required
   before the heartbeat frame field is useful.

## Design decisions (proposed; review before PR work)

- **`install.sh` lives at the repo root, served via
  `raw.githubusercontent.com` on a tagged release.** This matches the
  platform doc's commitment to a stable URL. The script:
  - Detects `uname -s` + `uname -m`, maps to a release asset name
    (e.g. `local-runtime-helper-darwin-arm64`).
  - Downloads from the latest release (or a `--version` flag for
    pinning).
  - Verifies the binary's checksum against the release's
    `checksums.txt`.
  - Writes to `~/.local/bin/local-runtime-helper` (creates the dir if
    missing; warns if not on `PATH`).
  - Prints next-step instructions (the platform UI also surfaces
    these, so this is a fallback).
- **Version comes from `-ldflags`.** Build script (and CI release
  workflow) pass `-ldflags "-X main.version=$VERSION"`. The CLI
  exposes a `--version` flag and includes the value in register +
  heartbeat frames.
- **`runtime.toml` rewrites are atomic.** Write to a sibling temp
  file in the same directory, fsync, then `os.Rename` over the
  original. Reject the rewrite if file ownership/perms would change.
- **Token-rotation surface is reserved, not implemented.** PR3 sketches
  the wire contract (a `token_rotation` field in the heartbeat ACK
  frame) but the rewrite logic and re-register flow ships in a later
  PR aligned with the platform's deferred PR5.

## Open questions

1. **Where do release binaries live today?** If `.github/workflows/release.yml`
   already publishes GitHub Releases with platform-arch assets, `install.sh`
   just consumes them. If not, the release workflow needs a one-time pass
   to publish `darwin-arm64`, `darwin-amd64`, `linux-arm64`, `linux-amd64`
   binaries plus a `checksums.txt`. **Verify before drafting PR1.**
2. **Heartbeat cadence.** What interval is the helper sending today?
   Both the runtime scope (presence freshness threshold) and the
   platform scope (`< 30s = online`) depend on this. Verify and align
   the docs.
3. **Config file location across platforms.** README/install docs
   imply `~/.config/harper/runtime.toml` on Linux/macOS. What about
   Windows? Is Windows in scope at all for the wizard? *Probably not
   for MVP — confirm and document.*
4. **Backwards compatibility for older helpers.** The runtime is
   adding a heartbeat write that requires `helper_version` (per
   runtime PR3). If older helpers connect without that field, the
   runtime persists `null`. Is that OK, or should the runtime reject
   helpers below a minimum version? Coordinate with runtime doc.

## PR plan

### PR1 — `install.sh` + release artifact verification

Smallest, ships first.

- Confirm GitHub Releases are already tagged with platform-arch
  binaries; if not, fix `.github/workflows/release.yml` to publish
  them with a `checksums.txt`.
- Add `install.sh` at repo root. Self-contained, no external deps
  beyond `curl`, `tar`, `shasum` / `sha256sum`.
- Add a smoke-test job in CI that runs `install.sh` in a clean
  ubuntu-latest container and confirms the binary executes
  `--version`.
- Update `README.md` and `docs/install.md` with the one-liner.

### PR2 — Version embedding + heartbeat frame

- Add a `var version = "dev"` in `main.go`. Wire `-ldflags` in
  release builds (`.github/workflows/release.yml` + a `Makefile`
  target).
- Add a `--version` CLI flag that prints the embedded value.
- Extend the register and heartbeat frame structs in
  `internal/protocol/` (or wherever the wire types live) with a
  `HelperVersion string \`json:"helper_version"\`` field. Always
  populate.
- Update unit tests for the protocol frames to assert the field is
  present and non-empty.
- This PR can ship before the runtime starts reading the field —
  it's additive on the wire.

### PR3 — Atomic config rewrite primitive (rotation prep)

Foundation for the deferred rotation flow; the rewrite logic ships
even though rotation doesn't activate yet.

- Add `internal/config/atomic_write.go` (or similar) implementing
  temp-file + fsync + rename for `runtime.toml`.
- Unit tests covering: happy path, mid-write crash leaves original
  intact, permission preservation, owner mismatch refuses to write.
- No callers wire it up yet — that's the deferred follow-up.

**Inbound rotation channel — choice required, not yet locked.** The
original draft of this PR reserved a `token_rotation` field on a
"heartbeat ACK" frame, but no such frame exists today:
`internal/protocol/protocol.go` defines `RegisterAckFrame` and
`HeartbeatFrame` only, and `internal/relay/client.go` sends
heartbeats without reading per-heartbeat acknowledgements. PR3
therefore has to pick one of:

1. **Reuse `RegisterAckFrame`.** Runtime issues rotation hints only
   at register time. Helper re-registers on a cadence (or when the
   runtime signals a forced reconnect) to receive them. Smallest
   wire change; latency for rotation is one reconnect.
2. **Add a new `HeartbeatAckFrame` inbound type** the runtime sends
   after each helper heartbeat. Helper read loop dispatches it like
   any other inbound frame. Cleanest semantically (rotation can fire
   on any heartbeat), but requires symmetric runtime changes.
3. **Add a generic `cloud_directive` push frame** the runtime sends
   ad-hoc (rotation, scheduled restart, capability re-probe, etc.).
   Most future-proof; broadest blast radius.

Locking this is a prerequisite of the deferred token-rotation PR
(not this one). PR3 in this doc still ships the atomic-write
primitive without committing to a frame choice.

## Testing notes

- PR1's CI smoke test catches install regressions automatically.
  Don't rely on manual testing.
- PR2 is wire-additive — older runtimes that don't know the field
  must still accept the frame. If they reject on unknown fields,
  coordinate a runtime change first (likely not the case given JSON
  semantics, but verify).
- PR3 atomic write tests should run on at least one CI platform that
  preserves filesystem semantics (Linux). macOS-specific paths can
  be covered locally.
