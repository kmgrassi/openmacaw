# TypeScript Guide

## Compiler Settings

The project uses strict TypeScript with ES module output. Key `tsconfig.json` settings:

- `strict: true` — enables all strict checks
- `target: ES2022` — modern JS features (top-level await, etc.)
- `module: NodeNext` — ES module output compatible with Node.js
- `moduleResolution: NodeNext` — follows Node ESM resolution rules

## Rules

### Types

- **Never use `any`.** Use `unknown` and narrow with type guards.
- **Never use `@ts-ignore` or `@ts-expect-error`** unless there is a documented compiler bug.
- Use `type` imports when importing only types: `import type { Request } from "express"`.
- Prefer `interface` for object shapes that might be extended. Use `type` for unions, intersections, function signatures, and aliases.
- Export types from the module where they are defined.

```typescript
// Good
import type { Request, Response } from "express";

interface HealthResponse {
  ok: boolean;
  service: string;
}

type ErrorCode = "orchestrator_timeout" | "orchestrator_unreachable";

// Bad
import { Request, Response } from "express"; // missing type-only import
const data: any = fetchSomething(); // any is forbidden
```

### Naming

| Thing | Convention | Example |
|-------|-----------|---------|
| Variables, functions | camelCase | `orchestratorRequest` |
| Types, interfaces | PascalCase | `HealthResponse` |
| Constants (env-derived) | UPPER_SNAKE_CASE | `ORCHESTRATOR_BASE_URL` |
| Files | kebab-case | `health-check.ts` |
| Unused params | `_` prefix | `_req` |

### Variables

- Default to `const`. Use `let` only when reassignment is needed. Never use `var`.
- Declare variables at the narrowest possible scope.

### Functions

- Prefer named functions over arrow functions at the module level for better stack traces.
- Use arrow functions for inline callbacks and Express route handlers.
- Always annotate return types on exported functions.

### Async/Await

- Always use `async/await` over raw Promises.
- Every `async` Express route handler must wrap its body in `try/catch`.
- Use `AbortController` for timeout management with `fetch`.

### Strings

- Use template literals over string concatenation.
- Use single quotes for imports (enforced by Prettier).

## Common Patterns in This Repo

### Proxy Route

```typescript
app.get("/api/v1/something", async (_req: Request, res: Response) => {
  try {
    const result = await orchestratorRequest("/api/v1/something", { method: "GET" });
    return res.status(result.status).json(result.body);
  } catch (error) {
    return handleProxyError(res, error);
  }
});
```

### Error Response

```typescript
return res.status(400).json(errorPayload("bad_request", "Missing required field"));
```

### Environment Parsing

```typescript
const SOME_VALUE = parsePositiveInt(process.env.SOME_VALUE, 5000);
```

## Adding New Code

1. Add types first — define the shape of data before writing logic.
2. Use existing helpers (`orchestratorRequest`, `errorPayload`, `handleProxyError`).
3. Run `pnpm run typecheck` to verify. Zero errors required.
