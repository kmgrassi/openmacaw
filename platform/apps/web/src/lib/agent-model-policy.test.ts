import { describe, expect, it } from "vitest";

import { localRelayTargetForAgent } from "./agent-model-policy";

describe("localRelayTargetForAgent", () => {
  it("uses savedProvider once the credential reference loads", () => {
    // Regression: when reopening an agent saved with runnerKind = local_relay,
    // savedProvider comes from the credential-reference rule and must override
    // the agent record's provider (which is derived from agent.model and may
    // be null when the local-relay model is null).
    expect(
      localRelayTargetForAgent({
        savedProvider: "openclaw",
        agentProvider: null,
      }),
    ).toBe("openclaw");
  });

  it("falls back to agent.provider until the credential reference loads", () => {
    expect(
      localRelayTargetForAgent({
        savedProvider: undefined,
        agentProvider: "openclaw",
      }),
    ).toBe("openclaw");
  });

  it("returns the empty string when neither source has a value", () => {
    expect(
      localRelayTargetForAgent({
        savedProvider: null,
        agentProvider: null,
      }),
    ).toBe("");
  });
});
