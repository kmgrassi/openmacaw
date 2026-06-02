import type {
  DefaultAgentMissingRequirement,
  SetupConfigurationChecklistItem,
} from "../../../../../contracts/setup.js";
import type { ExecutionProfileResolution } from "../../../../../contracts/execution-profile.js";
import type { Tables } from "@kmgrassi/supabase-schema";
import type { SetupAgentRow } from "../../repositories/agents.js";

export type AgentRow = SetupAgentRow;
export type BrokerRunRow = Tables<"broker_run">;
export type BrokerTaskRow = Tables<"broker_task">;
export type EngineInstanceRow = Tables<"engine_instance">;
export type GatewayConfigRow = Tables<"gateway_config">;
export type GatewayConfigStateRow = Tables<"gateway_config_state">;
export type DefaultAssignmentRow = Tables<"agent_default_assignment">;
export type WorkspaceRow = Tables<"workspaces">;
export type WorkspaceMemberRow = Tables<"workspace_members">;

export type DefaultAgentStatus = {
  agentId: string | null;
  configured: boolean;
  missing: DefaultAgentMissingRequirement[];
  checklist?: SetupConfigurationChecklistItem[];
  executionProfile?: ExecutionProfileResolution;
};
