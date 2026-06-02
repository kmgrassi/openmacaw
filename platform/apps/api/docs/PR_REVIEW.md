# Pull Request Guide

## Creating a PR

### Branch Naming

```
feat/short-description    # New feature
fix/short-description     # Bug fix
refactor/short-description # Refactoring
chore/short-description   # Tooling, deps, config
docs/short-description    # Documentation only
```

### PR Title

Same format as commit messages: `type: short description`

Examples:
- `feat: add /api/v1/workers proxy endpoint`
- `fix: handle null content-type in proxy response`
- `chore: upgrade typescript to 5.7`

### PR Body Template

```markdown
## Summary
- [1-3 bullet points describing what changed and why]

## Test plan
- [ ] `pnpm run validate` passes
- [ ] [specific manual or automated verification steps]
- [ ] [edge cases tested]
```

## Pre-Submit Checklist

Before requesting review, verify:

- [ ] **Validation passes**: `pnpm run validate` (lint + format + typecheck + test)
- [ ] **Scope is minimal**: Only changes relevant to the task. No drive-by refactors.
- [ ] **Types are strict**: No `any`, no `@ts-ignore`.
- [ ] **Error handling**: Proxy routes use `handleProxyError`. Custom errors use `errorPayload`.
- [ ] **Tests exist**: New code has corresponding test coverage.
- [ ] **No secrets**: `.env` is not committed. No hardcoded tokens or URLs.
- [ ] **Commit history is clean**: Meaningful commit messages in `type: description` format.

## Review Criteria

Reviewers evaluate PRs in this priority order:

### 1. Correctness
- Does the code do what the PR claims?
- Are edge cases handled (null, undefined, empty, timeout)?
- Do proxy routes correctly forward status codes and bodies?

### 2. Type Safety
- Is TypeScript strict mode satisfied with zero errors?
- Are there any `any` types or unsafe casts?
- Are type imports used correctly (`import type`)?

### 3. Error Handling
- Do new routes follow the `try/catch` + `handleProxyError` pattern?
- Are error responses using `errorPayload()` with meaningful codes?
- Are timeouts respected?

### 4. Test Coverage
- Do new routes/utilities have tests?
- Do tests cover both success and failure paths?
- Are mocks minimal and focused?

### 5. Code Quality
- Does the code follow patterns in [docs/TYPESCRIPT.md](TYPESCRIPT.md)?
- Is there unnecessary complexity or abstraction?
- Is the code readable without excessive comments?

### 6. Scope
- Are there unrelated changes mixed in?
- Are there new dependencies that weren't discussed?
- Is the diff size reasonable for the task?

## Common Review Feedback

| Issue | Resolution |
|-------|-----------|
| "Use `unknown` instead of `any`" | Replace with `unknown` and add type guard |
| "Missing error handling" | Add `try/catch` with `handleProxyError` |
| "Add test for this" | Write test covering the new code path |
| "Out of scope" | Move unrelated changes to a separate PR |
| "Use `import type`" | Change to type-only import |
| "Run formatter" | `pnpm run format` |

## After Approval

1. Squash-merge to `main` (or rebase if commits are clean).
2. Delete the feature branch.
3. Deploy per [docs/DEPLOYMENT.md](DEPLOYMENT.md).
4. Verify per [docs/OBSERVABILITY.md](OBSERVABILITY.md).
