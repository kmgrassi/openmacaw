/**
 * Maps runtime error codes / diagnostic reasons to a remediation link, so the
 * UI can point the user straight at the page that fixes the problem instead of
 * dead-ending on an error message.
 *
 * Today every recognized code resolves on the local runtimes setup page
 * (`/settings/local-runtimes`), where the user can register, start, or verify
 * their local runtime (or relay) helper.
 */
export type RuntimeErrorFix = {
  /** Call-to-action label, e.g. "Set up local runtime". */
  label: string;
  /** React Router path the CTA navigates to. */
  to: string;
};

const LOCAL_RUNTIME_SETUP_PATH = "/settings/local-runtimes";

/**
 * Known runtime error identifiers that a user can resolve themselves, keyed by
 * the stable error code:
 * - `local_runtime_not_supported` — a local-runtime agent needs the relay
 *   transport here; the relay is registered on the local runtimes page.
 *
 * Deliberately NOT mapped: `runtime_unreachable`. The workspace diagnostic
 * returns that for ANY failure to reach the runtime (orchestrator outage,
 * non-2xx, invalid body) — not just local runtimes — so a global "check your
 * local runtime" CTA would mislead every user during a general outage and
 * point them at a page that can't fix it. Only map codes that unambiguously
 * identify a local-runtime/relay problem.
 */
const FIX_BY_CODE = new Map<string, RuntimeErrorFix>([
  [
    "local_runtime_not_supported",
    { label: "Set up local runtime", to: LOCAL_RUNTIME_SETUP_PATH },
  ],
]);

/**
 * Returns the remediation link for the first recognized code, or `null` when
 * none of the supplied codes map to a self-serve fix. Accepts any mix of error
 * code, launcher error code, and diagnostic reason so callers can pass whatever
 * they have.
 */
export function runtimeErrorFix(
  ...codes: Array<string | null | undefined>
): RuntimeErrorFix | null {
  for (const code of codes) {
    const fix = code ? FIX_BY_CODE.get(code) : undefined;
    if (fix) return fix;
  }
  return null;
}
