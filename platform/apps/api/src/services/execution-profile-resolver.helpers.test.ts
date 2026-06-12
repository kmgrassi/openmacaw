import { describe, expect, it } from "vitest";

import { planningAgentId, workspaceId } from "../../test-support/execution-profile-resolver-shared.js";
import { firstGatewayRunner, matchValue } from "./execution-profile-resolver.js";

describe("matchValue", () => {
  const agent = {
    id: planningAgentId,
    workspace_id: workspaceId,
    type: "planning",
    model_settings: {},
    tool_policy: {},
  };
  const input = {
    agent,
    role: "planning" as const,
    intent: null,
    intentKey: null,
  };

  it('accepts key: "agent_id" for kind: "agent_id" matches', () => {
    const match = {
      rule_id: "r1",
      kind: "agent_id",
      key: "agent_id",
      value: planningAgentId,
    };
    expect(matchValue(input, match)).toBe(true);
  });

  it('accepts key: "id" for kind: "agent_id" matches', () => {
    const match = {
      rule_id: "r1",
      kind: "agent_id",
      key: "id",
      value: planningAgentId,
    };
    expect(matchValue(input, match)).toBe(true);
  });

  it("accepts null key for kind: agent_id matches", () => {
    const match = {
      rule_id: "r1",
      kind: "agent_id",
      key: null,
      value: planningAgentId,
    };
    expect(matchValue(input, match)).toBe(true);
  });

  it("rejects agent_id match when value does not match the agent id", () => {
    const match = {
      rule_id: "r1",
      kind: "agent_id",
      key: "agent_id",
      value: "wrong-id",
    };
    expect(matchValue(input, match)).toBe(false);
  });

  it('skips kind: "local_endpoint" (returns true, does not block)', () => {
    const match = {
      rule_id: "r1",
      kind: "local_endpoint",
      key: "url",
      value: "http://localhost:8080",
    };
    expect(matchValue(input, match)).toBe(true);
  });

  it('skips kind: "local_model_capability" (returns true, does not block)', () => {
    const match = {
      rule_id: "r1",
      kind: "local_model_capability",
      key: "tool_call",
      value: "native_tools",
    };
    expect(matchValue(input, match)).toBe(true);
  });
});

describe("firstGatewayRunner", () => {
  it("returns the first array entry for default-agent configs", () => {
    const config = {
      runners: [
        { kind: "codex", provider: "openai", model: "openai/gpt-5.2" },
        {
          kind: "claude_code",
          provider: "anthropic",
          model: "anthropic/claude-sonnet-4-6",
        },
      ],
    };
    expect(firstGatewayRunner(config)).toEqual({
      kind: "codex",
      provider: "openai",
      model: "openai/gpt-5.2",
    });
  });

  it("returns the manager entry for object-shaped manager configs", () => {
    const config = {
      runners: {
        manager: {
          kind: "llm_tool_runner",
          provider: "openai",
          model: "openai/gpt-5.2",
        },
      },
    };
    expect(firstGatewayRunner(config)).toEqual({
      kind: "llm_tool_runner",
      provider: "openai",
      model: "openai/gpt-5.2",
    });
  });

  it("falls back to the first record-valued entry when manager key is absent", () => {
    const config = {
      runners: {
        coding: {
          kind: "codex",
          provider: "openai",
          model: "openai/gpt-5.2",
        },
      },
    };
    expect(firstGatewayRunner(config)).toEqual({
      kind: "codex",
      provider: "openai",
      model: "openai/gpt-5.2",
    });
  });

  it("returns null for empty / missing / non-record runners", () => {
    expect(firstGatewayRunner(null)).toBeNull();
    expect(firstGatewayRunner({})).toBeNull();
    expect(firstGatewayRunner({ runners: [] })).toBeNull();
    expect(firstGatewayRunner({ runners: {} })).toBeNull();
    expect(firstGatewayRunner({ runners: { manager: "not a record" } })).toBeNull();
  });
});
