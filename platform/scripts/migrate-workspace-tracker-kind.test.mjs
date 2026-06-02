import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearTrackerConfig,
  deriveWorkspaceTrackerDecisions,
  extractTrackerKind,
  parseArgs,
} from "./migrate-workspace-tracker-kind.mjs";

const workspace = { id: "workspace-1", name: "Acme" };

function agent(id, type, workspaceId = workspace.id) {
  return {
    id,
    workspace_id: workspaceId,
    type,
    is_active: true,
  };
}

function gatewayConfig(id, agentId, kind) {
  return {
    id,
    scope_type: "agent",
    scope_id: agentId,
    config_json: {
      tracker: { kind },
      runners: [],
    },
  };
}

test("extractTrackerKind only accepts supported legacy tracker kinds", () => {
  assert.equal(extractTrackerKind({ tracker: { kind: "linear" } }), "linear");
  assert.equal(extractTrackerKind({ tracker: { kind: "unknown" } }), null);
  assert.equal(extractTrackerKind({ tracker: null }), null);
});

test("deriveWorkspaceTrackerDecisions hoists agreeing agent tracker kind", () => {
  const result = deriveWorkspaceTrackerDecisions({
    workspaces: [workspace],
    agents: [
      agent("agent-planning", "planning"),
      agent("agent-coding", "coding"),
    ],
    gatewayConfigs: [
      gatewayConfig("gateway-planning", "agent-planning", "database"),
      gatewayConfig("gateway-coding", "agent-coding", "database"),
    ],
  });

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].action, "upsert");
  assert.equal(result.decisions[0].trackerKind, "database");
  assert.equal(result.decisions[0].reason, "all_agents_agree");
  assert.equal(result.decisions[0].warning, null);
});

test("deriveWorkspaceTrackerDecisions chooses planning value on disagreement", () => {
  const result = deriveWorkspaceTrackerDecisions({
    workspaces: [workspace],
    agents: [
      agent("agent-planning", "planning"),
      agent("agent-coding", "coding"),
    ],
    gatewayConfigs: [
      gatewayConfig("gateway-planning", "agent-planning", "github"),
      gatewayConfig("gateway-coding", "agent-coding", "linear"),
    ],
  });

  assert.equal(result.decisions[0].action, "upsert");
  assert.equal(result.decisions[0].trackerKind, "github");
  assert.equal(result.decisions[0].reason, "agents_disagree");
  assert.equal(result.decisions[0].warning.code, "tracker_kind_disagreement");
  assert.deepEqual(result.decisions[0].warning.observedKinds, [
    "github",
    "linear",
  ]);
});

test("deriveWorkspaceTrackerDecisions skips workspaces without agent tracker kinds", () => {
  const result = deriveWorkspaceTrackerDecisions({
    workspaces: [workspace],
    agents: [agent("agent-planning", "planning")],
    gatewayConfigs: [
      {
        id: "gateway-planning",
        scope_type: "agent",
        scope_id: "agent-planning",
        config_json: { runners: [] },
      },
    ],
  });

  assert.equal(result.decisions[0].action, "skip");
  assert.equal(result.decisions[0].reason, "no_agent_tracker_kind");
  assert.equal(result.decisions[0].trackerKind, null);
});

test("clearTrackerConfig nulls tracker while preserving the rest of config_json", () => {
  assert.deepEqual(
    clearTrackerConfig({
      tracker: { kind: "database" },
      workflow_template: { id: "planning-default" },
    }),
    {
      tracker: null,
      workflow_template: { id: "planning-default" },
    },
  );
});

test("parseArgs defaults to dry-run and supports explicit apply", () => {
  assert.equal(parseArgs([]).dryRun, true);
  assert.equal(parseArgs(["--apply"]).dryRun, false);
  assert.equal(parseArgs(["--dry-run", "--clear-agent-tracker"]).dryRun, true);
  assert.equal(
    parseArgs(["--workspace-id", "workspace-1", "--page-size", "50"]).pageSize,
    50,
  );
});
