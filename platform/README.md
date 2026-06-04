# Parallel Agent Platform

Monorepo for the local API gateway, web client, shared contracts, and Supabase artifacts that support the parallel agent runtime.

For shared boundary schemas and when types belong in `contracts/`, see [docs/reference/contracts-directory-guidelines.md](docs/reference/contracts-directory-guidelines.md).

For database-backed agent tool naming and required cross-repo updates, see
[docs/reference/tool-crud-conventions.md](docs/reference/tool-crud-conventions.md).

Historical Harper/Parallel Agent database migrations are owned by the
`harper-server` repo. OpenMacaw-owned schema changes live under
`platform/supabase/migrations/` with the companion reference SQL in
`../docs/supabase/openmacaw-schema.sql`; follow `../docs/supabase/README.md`
for the reviewed Supabase migration workflow.

For a practical local startup and UI verification checklist that covers launcher/runtime dependencies, login, onboarding, and chat validation, see [docs/reference/end-to-end-local-runbook.md](docs/reference/end-to-end-local-runbook.md).
