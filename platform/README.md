# Parallel Agent Platform

Monorepo for the local API gateway, web client, shared contracts, and Supabase artifacts that support the parallel agent runtime.

For shared boundary schemas and when types belong in `contracts/`, see [docs/reference/contracts-directory-guidelines.md](docs/reference/contracts-directory-guidelines.md).

For database-backed agent tool naming and required cross-repo updates, see
[docs/reference/tool-crud-conventions.md](docs/reference/tool-crud-conventions.md).

Database migrations are owned by the `harper-server` repo. Do not create or
force-apply migrations from this repo; add migration files in `harper-server`,
have them code reviewed and merged, and let that repo's CI/CD pipeline apply
them.

For a practical local startup and UI verification checklist that covers launcher/runtime dependencies, login, onboarding, and chat validation, see [docs/reference/end-to-end-local-runbook.md](docs/reference/end-to-end-local-runbook.md).
