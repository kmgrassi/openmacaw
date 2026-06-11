import type { Tables } from "@kmgrassi/supabase-schema";

import type { ModelTier, RegisteredProvider } from "../../../../../contracts/model-tiers.js";

export type AgentProfileRow = Pick<Tables<"agent">, "id" | "workspace_id" | "type" | "model_settings" | "tool_policy">;

export type GatewayConfigProfileRow = Pick<Tables<"gateway_config">, "config_json">;

export type CredentialProfileRow = Pick<Tables<"credential">, "id" | "key_value">;

export type RoutingRuleRow = Pick<
  Tables<"routing_rule">,
  "id" | "workspace_id" | "priority" | "runner_kind" | "provider" | "model" | "credential_id" | "credential_alias"
> & {
  model_tier_floor: ModelTier;
};

export type RoutingRuleFallbackRow = {
  routing_rule_id: string;
  position: number;
  provider: RegisteredProvider;
  model: string;
  credential_id: string | null;
  credential_alias: string | null;
};

export type RoutingRuleMatchRow = Pick<Tables<"routing_rule_match">, "rule_id" | "kind" | "key" | "value">;

export type CredentialAliasRow = Pick<Tables<"credential_alias">, "alias" | "credential_id">;

export type ResolveExecutionProfileInput = {
  agentId: string;
  intent?: string | null;
  intentKey?: string | null;
  accessToken?: string;
  requesterUserId?: string;
  skipCredentialCheck?: boolean;
};
