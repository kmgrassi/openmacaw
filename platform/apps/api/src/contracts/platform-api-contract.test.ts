import { describe, expect, it } from "vitest";

import {
  CreateToolDefinitionRequestSchema,
  UpdateToolDefinitionRequestSchema,
} from "../../../../contracts/tool-definition.js";
import { PlatformApiContracts } from "../../../../contracts/platform-api-contracts.js";

describe("Platform API route contracts", () => {
  it("requires workspace scope for tool listing and deletion routes", () => {
    expect(PlatformApiContracts.listTools.query.safeParse({}).success).toBe(false);
    expect(PlatformApiContracts.deleteToolDefinition.query.safeParse({}).success).toBe(false);
    expect(PlatformApiContracts.listAgentTools.query.safeParse({}).success).toBe(false);
    expect(PlatformApiContracts.deleteAgentToolGrant.query.safeParse({}).success).toBe(false);
  });

  it("requires workspace scope in tool mutation request bodies", () => {
    expect(CreateToolDefinitionRequestSchema.safeParse({ slug: "read_file", name: "Read File" }).success).toBe(false);
    expect(UpdateToolDefinitionRequestSchema.safeParse({ name: "Read File" }).success).toBe(false);
    expect(
      PlatformApiContracts.createToolDefinition.body.safeParse({
        slug: "read_file",
        name: "Read File",
      }).success,
    ).toBe(false);
    expect(PlatformApiContracts.updateToolDefinition.body.safeParse({ name: "Read File" }).success).toBe(false);
    expect(
      PlatformApiContracts.upsertAgentToolGrant.body.safeParse({
        mode: "include",
      }).success,
    ).toBe(false);
  });
});
