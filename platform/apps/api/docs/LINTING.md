# Linting and Formatting

## Tools

| Tool | Purpose | Config File |
|------|---------|-------------|
| **ESLint** | Static analysis and code quality | `eslint.config.js` |
| **Prettier** | Code formatting | `.prettierrc.json` |

## Commands

```bash
# Lint
pnpm run lint          # Check for issues
pnpm run lint:fix      # Auto-fix what's possible

# Format
pnpm run format:check  # Check formatting
pnpm run format        # Fix formatting

# Both (part of validate)
pnpm run validate      # Runs lint + format:check + typecheck + test
```

## ESLint Configuration

We use ESLint flat config (`eslint.config.js`) with `typescript-eslint`.

Key rules:
- **No `any`**: `@typescript-eslint/no-explicit-any: "error"` — use `unknown` instead.
- **No unused variables**: `@typescript-eslint/no-unused-vars: "error"` — prefix intentionally unused params with `_`.
- **No `console.log`**: `no-console: "warn"` — use structured logging in production code. The warning is acceptable for startup messages.
- **Consistent type imports**: `@typescript-eslint/consistent-type-imports: "error"` — enforces `import type` for type-only imports.

## Prettier Configuration

Defined in `.prettierrc.json`:

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 120,
  "tabWidth": 2
}
```

Key choices:
- **Double quotes** for strings (matches JSON and is less ambiguous).
- **Semicolons** always.
- **120 char line width** — wide enough for readable code without excessive wrapping.
- **Trailing commas** everywhere — cleaner diffs.

## Integration with Editors

### VS Code

Install the ESLint and Prettier extensions, then add to `.vscode/settings.json`:

```json
{
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit"
  }
}
```

## Fixing Lint Errors

Most common issues and how to fix them:

| Error | Fix |
|-------|-----|
| `@typescript-eslint/no-explicit-any` | Replace `any` with `unknown` and add type narrowing |
| `@typescript-eslint/no-unused-vars` | Remove the variable, or prefix with `_` if it's a required callback param |
| `@typescript-eslint/consistent-type-imports` | Change `import { Foo }` to `import type { Foo }` if `Foo` is only used as a type |
| Prettier formatting | Run `pnpm run format` |
