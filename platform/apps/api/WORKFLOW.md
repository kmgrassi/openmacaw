# Workflow — Task Policy

This document defines how work flows from assignment to production in the symphony-server repo.

## 1. Understand the Task

- Read the issue or request fully before writing code.
- Check [AGENTS.md](AGENTS.md) for relevant docs.
- If the task touches proxy routes, read `src/index.ts` and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- If requirements are ambiguous, ask before coding.

## 2. Set Up Locally

```bash
cp .env.example .env        # first time only
pnpm install
pnpm run dev                  # starts server with hot reload on :3100
```

Verify with: `curl http://localhost:3100/health`

See [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md) for detailed setup.

## 3. Write Code

Follow these rules strictly:

- **TypeScript strict mode** — no `any`, no `@ts-ignore`. See [docs/TYPESCRIPT.md](docs/TYPESCRIPT.md).
- **Express patterns** — use `errorPayload()` for errors, `orchestratorRequest()` for proxying. See [CLAUDE.md](CLAUDE.md).
- **Tests required** — every new route or utility must have tests. See [docs/TESTING.md](docs/TESTING.md).
- **No unrelated changes** — don't refactor, clean up, or add features beyond the task scope.

## 4. Validate Before Committing

Run the full validation suite:

```bash
pnpm run validate
```

This runs, in order:
1. `pnpm run lint` — ESLint checks
2. `pnpm run format:check` — Prettier formatting
3. `pnpm run typecheck` — TypeScript compiler (no emit)
4. `pnpm test` — Vitest test suite

All four must pass. Do not skip steps or use `--no-verify`.

Alternatively, run the script directly: `./scripts/validate.sh`

## 5. Commit

- Write a concise commit message: imperative mood, under 72 chars.
- Format: `type: short description` where type is one of: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`.
- Examples: `feat: add /api/v1/workers proxy endpoint`, `fix: handle null body in orchestrator response`.

## 6. Create a Pull Request

- Branch naming: `feat/short-description`, `fix/short-description`.
- PR title matches the commit convention.
- PR body must include:
  - **Summary**: 1-3 bullet points of what changed and why.
  - **Test plan**: how to verify the change works.
- See [docs/PR_REVIEW.md](docs/PR_REVIEW.md) for the full checklist.

## 7. Review Criteria

PRs are reviewed against these criteria (in order of priority):

1. **Correctness** — does it do what it claims?
2. **Types** — strict TypeScript, no `any`, proper narrowing?
3. **Error handling** — proxy errors use standard helpers?
4. **Tests** — new code has test coverage?
5. **Lint/format** — `pnpm run validate` passes?
6. **Scope** — no unrelated changes?

## 8. Deploy

After merge to `main`:

1. Build: `pnpm run build`
2. Verify build output in `dist/`.
3. Deploy according to [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
4. Run health check: `curl https://<deployed-url>/health`

## 9. Post-Deploy Verification

- Check `/health` returns `{ ok: true }`.
- Check upstream connectivity via `/api/v1/health`.
- Monitor logs for errors in the first 15 minutes.
- See [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) for monitoring details.
