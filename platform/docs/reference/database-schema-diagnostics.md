# Database Schema Diagnostics

Use the schema diagnostic when a runtime database error looks like a stale
migration, generated type drift, missing extension, or enum/check-constraint
mismatch.

```bash
pnpm run db:schema:check
```

The script emits JSON records with the same event vocabulary as platform logs:

- `database_schema_diagnostic_check` for each pass or skipped check.
- `database_schema_drift_detected` for failures.
- `database_schema_diagnostic_summary` when all required checks pass.

Every drift failure includes the owning artifact where the fix should start:
`artifact`, `owning_artifact`, `table`, `constraint`, `expected_value`, and
`offending_value` when those fields apply. The output intentionally avoids row
data, credentials, auth tokens, and SQL payload dumps.

## What It Checks

The local checks always run:

- Generated Supabase types live at
  `packages/supabase-schema/src/database.types.ts`.
- The generated file has the required header and exports `Database`.
- Source files do not import the deprecated
  `supabase/generated/database.types.ts` path.

When Supabase project auth is available, the script also regenerates live
Supabase types and compares them with the checked-in artifact. Configure
`SUPABASE_PROJECT_ID` plus either `SUPABASE_ACCESS_TOKEN` or the normal
Supabase CLI access-token file.

When `SUPABASE_DB_URL` or `DATABASE_URL` is available, the script reads the live
database catalog with `psql` and verifies expected extensions such as
`pgcrypto` are installed.

## Correlating Runtime Errors

1. Copy the Postgres/Supabase code, table, constraint, and hint from the API log
   entry. Existing query failures log these as `supabase_code`,
   `supabase_details`, and `supabase_hint`.
2. Run `pnpm run db:schema:check`.
3. Search the diagnostic output for the same `table` or `constraint`.
4. If the failure points at `packages/supabase-schema/src/database.types.ts`,
   apply the intended migration to the Supabase project and run
   `pnpm run db:schema:sync`.
5. If the failure requires a database migration, make that change in
   `harper-server/supabase/migrations/`. Platform does not own Supabase
   migrations.

For generated type guard failures in CI, the shell harness prints a
`database_schema_drift_detected` block with the owning artifact and the expected
next command.
