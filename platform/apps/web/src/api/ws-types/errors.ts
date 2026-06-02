export type GatewayError = {
  code: GatewayErrorCode | string;
  message: string;
  details?: unknown;
};

/**
 * Well-known error codes shared across client / broker / engine.
 * Add new codes here - not as inline strings.
 */
export type GatewayErrorCode =
  | "runtime_scope_required"
  | "scope_missing"
  | "onboarding_required"
  | "runtime_not_prepared"
  | "auth_failed"
  | "agent_not_found"
  | "workspace_not_found"
  | "session_not_found"
  | "invalid_session_key"
  | "rate_limited"
  | "provider_not_configured_for_agent"
  | "model_not_configured";

/**
 * Scope-specific error codes - mirrors engine `ScopeErrorCodes`.
 * Use these constants instead of inline strings for error matching.
 */
export const ScopeErrorCodes = {
  RUNTIME_SCOPE_REQUIRED: "runtime_scope_required",
  SCOPE_MISSING: "scope_missing",
  AGENT_NOT_FOUND: "agent_not_found",
  ONBOARDING_REQUIRED: "onboarding_required",
} as const satisfies Record<string, GatewayErrorCode>;

/**
 * Provider/model configuration error codes - surfaced at run-time when
 * credentials or model settings are missing. Used by the UI to show
 * actionable CTAs instead of generic error text.
 */
export const PROVIDER_ERROR_CODES = [
  "provider_not_configured_for_agent",
  "model_not_configured",
  "no_provider_credentials",
] as const;

export const LOCAL_CODING_ERROR_CODES = [
  "approval_required",
  "tool_execution_timeout",
  "workspace_policy_violation",
] as const;

/** Well-known WS close codes used by the broker / engine. */
export const WS_CLOSE_CODES = {
  /** Authentication failed (invalid token / device signature). */
  AUTH_FAILED: 4401,
  /** Runtime not prepared - client should call prepareRuntime then reconnect. */
  RUNTIME_NOT_PREPARED: 4428,
} as const;
