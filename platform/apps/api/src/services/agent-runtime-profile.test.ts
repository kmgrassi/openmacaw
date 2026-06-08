import { describe, expect, it } from "vitest";

import { localHelperRunnerKindForAgentRunnerKind } from "./agent-runtime-profile.js";

describe("localHelperRunnerKindForAgentRunnerKind", () => {
  it("maps the manager runner kind to the relay target the helper advertises", () => {
    // A manager (`llm_tool_runner`) on a local model dispatches over the
    // relay to the helper's `openai_compatible` runner; the helper never
    // advertises `llm_tool_runner`, so the presence check must look for the
    // relay target instead.
    expect(localHelperRunnerKindForAgentRunnerKind("llm_tool_runner")).toBe("openai_compatible");
  });

  it("leaves runner kinds the helper advertises directly unchanged", () => {
    // `openai_compatible` registrations advertise these directly
    // (see local-runtime/machines.ts), so no remapping is needed.
    expect(localHelperRunnerKindForAgentRunnerKind("local_model_coding")).toBe("local_model_coding");
    expect(localHelperRunnerKindForAgentRunnerKind("planner")).toBe("planner");
  });

  it("passes through unknown runner kinds untouched", () => {
    expect(localHelperRunnerKindForAgentRunnerKind("openclaw")).toBe("openclaw");
  });
});
