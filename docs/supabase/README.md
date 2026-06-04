# OpenMacaw Supabase Setup

This directory contains the SQL needed to bootstrap a dedicated OpenMacaw
Supabase project.

- [`openmacaw-schema.sql`](openmacaw-schema.sql) is the source SQL for the
  initial OpenMacaw schema.
- [`openmacaw-data-model-inventory.md`](openmacaw-data-model-inventory.md)
  explains which tables were included and which Harper-derived tables were
  intentionally excluded.

## Create A New Supabase Project

1. Create a new project in the Supabase Dashboard.
2. Save the project reference from the dashboard URL:
   `https://supabase.com/dashboard/project/<project-ref>`.
3. Save the generated database password somewhere secure.
4. In the project dashboard, collect the values OpenMacaw will need later:
   `SUPABASE_URL`, anon key, and service role key.

Do not create OpenMacaw tables directly in the remote Dashboard once migration
tracking starts. Supabase's migration guidance is to make schema changes through
migration files and deploy them with `supabase db push`; direct remote schema
edits can put migration history out of sync.

## Initialize Local Supabase Config

From the platform package:

```sh
cd platform
supabase init
```

This creates the `platform/supabase/` directory if it does not exist. If the CLI
reports that Supabase is already initialized, keep the existing config and
continue.

For local testing, start the local Supabase stack:

```sh
supabase start
```

The local stack requires Docker or another compatible container runtime.

## Create The Initial Migration

The initial migration is already checked in at:

```text
platform/supabase/migrations/20260604133000_openmacaw_initial_schema.sql
```

For future schema changes, generate a migration file from `platform/`:

```sh
supabase migration new openmacaw_schema
```

The CLI creates a timestamped file under `platform/supabase/migrations/`, for example:

```text
platform/supabase/migrations/20260603120000_openmacaw_schema.sql
```

For the initial migration only, the migration file should match the reference SQL:

```sh
cp ../docs/supabase/openmacaw-schema.sql supabase/migrations/20260604133000_openmacaw_initial_schema.sql
```

Commit both the migration file and the source SQL. The source SQL remains a
stable reference; the migration file is what Supabase applies.

## Test The Migration Locally

Reset the local database from migrations:

```sh
supabase db reset
```

This recreates the local database and applies all files in
`platform/supabase/migrations/` in timestamp order.

For a quicker local-only apply after the database is already running, use:

```sh
supabase migration up --local
```

## Link And Push To The New Project

Log in to the Supabase CLI:

```sh
supabase login
```

Link the repo to the new Supabase project:

```sh
supabase link --project-ref <project-ref>
```

Preview the remote migration push:

```sh
supabase db push --dry-run
```

Apply the migration to the linked remote project:

```sh
supabase db push
```

Supabase records applied migrations in
`supabase_migrations.schema_migrations`, so later pushes only apply migrations
that have not already been applied.

## Regenerate OpenMacaw Schema Artifacts

After the new project has the schema, point local environment variables at the
new Supabase project:

```sh
export SUPABASE_PROJECT_ID=<project-ref>
export SUPABASE_URL=<project-url>
export SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

Then regenerate checked-in schema artifacts:

```sh
pnpm -C platform run db:schema:sync
pnpm -C runtime run supabase:schema:sync
```

Review the generated diffs before committing. The generated platform and
runtime schema files should match the OpenMacaw project, not the reused Harper
project.

## References

- Supabase local development and CLI quickstart:
  <https://supabase.com/docs/guides/local-development>
- Supabase local development with schema migrations:
  <https://supabase.com/docs/guides/cli/local-development>
- Supabase database migrations:
  <https://supabase.com/docs/guides/deployment/database-migrations>
- Supabase CLI reference:
  <https://supabase.com/docs/reference/cli/overview>
