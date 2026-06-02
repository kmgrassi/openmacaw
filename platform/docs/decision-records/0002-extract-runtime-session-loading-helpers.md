# DR 0002: Extract runtime session loading helpers from settings UI

## Status

Proposed

## Context

`apps/web/src/components/settings/RuntimeSection.tsx` owns several responsibilities at once:

- formatting runtime timestamps,
- loading orchestrator session summaries,
- loading worker bridge session details,
- handling stop-session actions,
- rendering all runtime cards.

The worker session loading path already had repeated asynchronous detail-fetch fallback logic and was a good candidate for extraction.

## Decision

Move runtime data-loading paths toward small helpers that can be reused and tested independently of the UI tree.

The immediate boundary is:

- keep rendering in `RuntimeSection`,
- move worker session detail resolution into a helper,
- continue splitting read-only formatting or query helpers when they simplify the component.

This is intentionally a staged refactor, not a large component rewrite.

## Consequences

- The component becomes easier to read because async transport logic no longer competes with render structure.
- The same loading rules can be reused if runtime data appears elsewhere in the UI.
- The first extraction is small and low risk, but it also signals a path toward a dedicated runtime hook if the section keeps growing.

## Next step

If the settings area grows further, introduce a `useRuntimeDiagnostics` hook that owns:

- orchestrator summary loading,
- worker session loading,
- loading/error state,
- refresh and stop-session actions.
