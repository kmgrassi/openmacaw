# Testing

## Framework

We use **Vitest** for testing. It's fast, ESM-native, and has a Jest-compatible API.

## Commands

```bash
pnpm test              # Run all tests
pnpm run test:watch    # Run in watch mode (re-runs on file changes)
```

## File Conventions

- Test files live next to the code they test: `src/foo.ts` → `src/foo.test.ts`
- Use the `.test.ts` suffix (not `.spec.ts`).
- Integration tests that start the server go in `src/__tests__/`.

## Writing Tests

### Basic Structure

```typescript
import { describe, it, expect } from "vitest";

describe("parsePositiveInt", () => {
  it("parses valid positive integers", () => {
    expect(parsePositiveInt("42", 0)).toBe(42);
  });

  it("returns fallback for invalid input", () => {
    expect(parsePositiveInt("abc", 10)).toBe(10);
  });

  it("returns fallback for negative numbers", () => {
    expect(parsePositiveInt("-5", 10)).toBe(10);
  });
});
```

### Testing Express Routes

Use `supertest` for HTTP-level route testing:

```typescript
import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../app.js";

describe("GET /health", () => {
  it("returns health status", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("service", "symphony-express-server");
  });
});
```

### Mocking the Orchestrator

For proxy route tests, mock `fetch` to avoid depending on the real orchestrator:

```typescript
import { vi, describe, it, expect, beforeEach } from "vitest";

beforeEach(() => {
  vi.restoreAllMocks();
});

it("returns 504 on orchestrator timeout", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  });

  const res = await request(app).get("/api/v1/health");
  expect(res.status).toBe(504);
  expect(res.body.error.code).toBe("orchestrator_timeout");
});
```

## What to Test

| Component | What to verify |
|-----------|---------------|
| Utility functions | Input/output for edge cases |
| Route handlers | HTTP status codes, response shape, error handling |
| Proxy behavior | Timeout handling, unreachable orchestrator, successful proxy |
| Error helpers | Correct error shape for each code path |

## What NOT to Test

- Don't test Express or Vitest framework internals.
- Don't test that `dotenv` loads env vars.
- Don't write tests that only assert TypeScript types (the compiler does that).
