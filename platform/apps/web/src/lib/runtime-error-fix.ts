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
 * Known runtime error identifiers that a user can resolve themselves. Keyed by
 * the stable error code or diagnostic reason:
 * - `runtime_unreachable`         — workspace diagnostic couldn't reach the runtime
 *   (most often the local runtime/relay helper isn't running).
 * - `local_runtime_not_supported` — a local-runtime agent needs the relay
 *   transport here; the relay is registered on the local runtimes page.
 */
const FIX_BY_CODE = new Map<string, RuntimeErrorFix>([
  [
    "runtime_unreachable",
    { label: "Check local runtime", to: LOCAL_RUNTIME_SETUP_PATH },
  ],
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
