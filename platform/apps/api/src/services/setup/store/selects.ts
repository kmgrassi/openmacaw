export const ENGINE_INSTANCE_SELECT =
  "instance_id,agent_id,workspace_id,host,port,role,status,started_at,last_health_at,updated_at,ws_connection_id" as const;
export const GATEWAY_CONFIG_SELECT =
  "id,scope_type,scope_id,version,config_hash,config_json,updated_at,updated_by" as const;
export const GATEWAY_CONFIG_STATE_SELECT =
  "scope_type,scope_id,sync_status,sync_error,synced_at,last_applied_hash,last_applied_version,last_apply_status,last_apply_error,last_apply_at,broker_instance_id" as const;
export const WORKSPACE_SELECT = "id,name,owner_user_id,created_at" as const;
export const WORKSPACE_MEMBER_SELECT = "workspace_id,user_id,role,created_at" as const;
export const DEFAULT_ASSIGNMENT_SELECT =
  "workspace_id,user_id,agent_id,role,provisioning_source,created_at,updated_at" as const;
export const DEFAULT_AGENT_SELECT =
  "id,workspace_id,name,status,type,model_settings,tool_policy,created_by_user_id,updated_at" as const;
