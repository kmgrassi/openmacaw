import { afterEach, describe, expect, it } from "vitest";

import { getSetupDefaults } from "./defaults.js";

const ORIGINAL_ENV = { ...process.env };

describe("getSetupDefaults", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("loads setup bootstrap defaults", () => {
    delete process.env.SETUP_DEFAULT_MANAGER_MODEL;
    delete process.env.SETUP_DEFAULT_WORKSPACE_NAME;

    expect(getSetupDefaults()).toMatchObject({
      agentRoles: ["planning", "coding"],
      workspaceName: "Personal Workspace",
      workspaceMemberRole: "owner",
      agentStatus: "active",
      managerModel: "openai/gpt-5.2",
      demoPlanningLocalProfile: {
        enabled: false,
        provider: "local",
        model: "qwen2.5-coder:7b",
        runnerKind: "local_relay",
      },
      defaultAgentProvisioningSource: "platform_bootstrap",
      claimedAgentProvisioningSource: "claimed_existing",
    });
  });

  it("loads environment overrides", () => {
    process.env.SETUP_DEFAULT_MANAGER_MODEL = "openai/gpt-next";
    process.env.SETUP_DEFAULT_WORKSPACE_NAME = "Workspace Seed";
    process.env.SETUP_DEMO_PLANNING_LOCAL_ENABLED = "true";
    process.env.SETUP_DEMO_PLANNING_LOCAL_MODEL = "qwen2.5-coder:14b";

    expect(getSetupDefaults()).toMatchObject({
      workspaceName: "Workspace Seed",
      managerModel: "openai/gpt-next",
      demoPlanningLocalProfile: {
        enabled: true,
        model: "qwen2.5-coder:14b",
      },
    });
  });
});
