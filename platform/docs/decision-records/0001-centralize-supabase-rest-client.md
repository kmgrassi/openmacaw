# DR 0001: Centralize Supabase REST client behavior

## Status

Superseded by the typed Supabase client migration. Current API database access
uses `apps/api/src/supabase-client.ts` and the official Supabase query builder.

## Context

Historical note: this decision described the former custom PostgREST wrapper.
The wrapper has since been removed.

`apps/api/src/supabase.ts` had repeated REST request logic for:

- shared headers,
- JSON body handling,
- `204` response handling,
- error payload formatting,
- service-role vs user bearer token selection.

That duplication made the file longer than necessary and raised the chance that future request paths would drift in small but meaningful ways.

## Historical Decision

Keep table-specific PostgREST helpers, but route them through a shared
low-level request helper.

The shared helper should own:

- base URL composition,
- common headers,
- conditional JSON serialization,
- uniform error text,
- empty response handling.

The table-specific helpers should remain as the stable call surface for the rest of the API code.

## Consequences

- `apps/api/src/supabase.ts` becomes easier to scan because the transport boilerplate is pushed down.
- Future Supabase calls can reuse the same behavior without copying another `fetch` block.
- Auth differences remain explicit through parameters rather than through separate, mostly duplicated implementations.
- If the low-level helper changes incorrectly, several paths can regress at once, so the shared helper is worth direct test coverage.

## Next step

Add focused tests around the shared request helper behavior:

- successful JSON response,
- `204` empty response,
- non-OK response text propagation,
- bearer token override for auth user lookup.
