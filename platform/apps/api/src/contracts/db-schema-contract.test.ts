import { describe, expect, it } from "vitest";

import type { Tables, TablesInsert, TablesUpdate } from "@kmgrassi/supabase-schema";

type ToolRowContract = Pick<
  Tables<"tool">,
  "workspace_id" | "execution_kind" | "runner_kind" | "enabled" | "slug" | "parameters" | "function_name"
>;
type ToolInsertContract = Pick<TablesInsert<"tool">, "workspace_id" | "execution_kind" | "runner_kind" | "enabled">;
type ToolUpdateContract = Pick<TablesUpdate<"tool">, "workspace_id" | "execution_kind" | "runner_kind" | "enabled">;

const rowContract = {
  workspace_id: null,
  execution_kind: null,
  runner_kind: null,
  enabled: true,
  slug: "read_file",
  parameters: { type: "object" },
  function_name: "read_file",
} satisfies ToolRowContract;

const insertContract = {
  workspace_id: "22222222-2222-4222-8222-222222222222",
  execution_kind: "filesystem_read",
  runner_kind: "local_runtime",
  enabled: true,
} satisfies ToolInsertContract;

const updateContract = {
  workspace_id: "22222222-2222-4222-8222-222222222222",
  execution_kind: "filesystem_read",
  runner_kind: "local_runtime",
  enabled: false,
} satisfies ToolUpdateContract;

describe("generated Supabase tool contract", () => {
  it("keeps Platform-consumed tool columns in the shared schema artifact", () => {
    expect(Object.keys(rowContract).sort()).toEqual([
      "enabled",
      "execution_kind",
      "function_name",
      "parameters",
      "runner_kind",
      "slug",
      "workspace_id",
    ]);
    expect(insertContract.enabled).toBe(true);
    expect(updateContract.enabled).toBe(false);
  });
});
