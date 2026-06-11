# OpenMacaw Platform

Web app, API gateway, shared contracts, and Supabase artifacts that support the OpenMacaw runtime.

To run the platform as part of the full local stack, use `./openmacaw run` from the repository root (see the [root README](../README.md) for prerequisites and environment setup). To run just the platform, copy `platform/.env.example` to `platform/.env`, fill in the Required section, then `pnpm install && pnpm run dev` from this directory.

For shared boundary schemas and when types belong in `contracts/`, see [docs/reference/contracts-directory-guidelines.md](docs/reference/contracts-directory-guidelines.md).

For database-backed agent tool naming and required cross-repo updates, see
[docs/reference/tool-crud-conventions.md](docs/reference/tool-crud-conventions.md).

Historical pre-OpenMacaw database migrations are owned by the private
`harper-server` repo and are not accepted here. OpenMacaw-owned schema changes
live under `platform/supabase/migrations/` with the companion reference SQL in
`../docs/supabase/openmacaw-schema.sql`; follow `../docs/supabase/README.md`
for the reviewed Supabase migration workflow.

For a practical local startup and UI verification checklist that covers launcher/runtime dependencies, login, onboarding, and chat validation, see [docs/reference/end-to-end-local-runbook.md](docs/reference/end-to-end-local-runbook.md).
