import { readFile, writeFile } from "node:fs/promises";

const filePath = new URL("../supabase/generated/types.ts", import.meta.url);
const bridgePath = new URL("../supabase/generated/postgrest-schema.json", import.meta.url);
const orchestratorBridgePath = new URL(
  "../apps/orchestrator/priv/generated/postgrest-schema.json",
  import.meta.url,
);

const markerStart = "// region: jsdoc-friendly aliases";
const markerEnd = "// endregion: jsdoc-friendly aliases";

const helperBlock = [
  "",
  markerStart,
  "/**",
  " * JSDoc-friendly aliases for JavaScript and other non-TypeScript callers.",
  " *",
  " * Example:",
  " * @example",
  ' * `/** @type {import("./types").PublicTableRows["workspaces"]} *\\/`',
  " * `const workspace = {}`",
  " *",
  " * @example",
  ' * `/** @type {import("./types").AuthzTableInserts["decision_log"]} *\\/`',
  ' * `const payload = { action: "read" }`',
  " */",
  'export type PublicSchema = Database["public"]',
  'export type AuthzSchema = Database["authz"]',
  "",
  "export type PublicTableRows = {",
  '  [TableName in keyof PublicSchema["Tables"]]: PublicSchema["Tables"][TableName]["Row"]',
  "}",
  "",
  "export type PublicTableInserts = {",
  '  [TableName in keyof PublicSchema["Tables"]]: PublicSchema["Tables"][TableName]["Insert"]',
  "}",
  "",
  "export type PublicTableUpdates = {",
  '  [TableName in keyof PublicSchema["Tables"]]: PublicSchema["Tables"][TableName]["Update"]',
  "}",
  "",
  "export type AuthzTableRows = {",
  '  [TableName in keyof AuthzSchema["Tables"]]: AuthzSchema["Tables"][TableName]["Row"]',
  "}",
  "",
  "export type AuthzTableInserts = {",
  '  [TableName in keyof AuthzSchema["Tables"]]: AuthzSchema["Tables"][TableName]["Insert"]',
  "}",
  "",
  "export type AuthzTableUpdates = {",
  '  [TableName in keyof AuthzSchema["Tables"]]: AuthzSchema["Tables"][TableName]["Update"]',
  "}",
  "",
  'export type PublicEnums = PublicSchema["Enums"]',
  'export type AuthzEnums = AuthzSchema["Enums"]',
  markerEnd,
  "",
].join("\n");

const source = await readFile(filePath, "utf8");
const blockPattern = new RegExp(
  `\\n${markerStart.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}[\\s\\S]*?${markerEnd.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\n?`,
  "m",
);

const nextSource = source.replace(blockPattern, "").trimEnd() + helperBlock;

if (nextSource !== source) {
  await writeFile(filePath, `${nextSource}\n`, "utf8");
}

const BRIDGE_TABLES = [
  "agent",
  "credential",
  "gateway_config",
  "gateway_config_state",
  "work_items",
  "plan",
  "routing_rule",
  "routing_rule_match",
  "local_runtime_machine",
  "local_runtime_token",
  "tool",
  "agent_tool",
  "tool_call",
  "message",
  "planning_profile",
  "provider_failure",
  "provider_cutover",
  "routing_rule_fallback",
  "scheduled_task",
  "scheduled_task_run",
  "workspace_settings",
];

function extractRowFieldTypes(content, tableName) {
  const tablePattern = new RegExp(
    `${tableName}:\\s*\\{[\\s\\S]*?Row:\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\n\\s*Insert:`,
    "m",
  );
  const match = content.match(tablePattern);

  if (!match) {
    throw new Error(`Could not find Row schema for public.${tableName}`);
  }

  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((fields, line) => {
      const fieldMatch = line.match(/^([A-Za-z0-9_]+): (.+)$/);

      if (!fieldMatch) {
        return fields;
      }

      const [, name, tsType] = fieldMatch;
      return {
        ...fields,
        [name]: {
          ts_type: tsType.trim(),
          value_kinds: inferValueKinds(tsType.trim()),
        },
      };
    }, {});
}

function inferValueKinds(tsType) {
  if (tsType.includes("Json")) {
    const valueKinds = ["json"];

    if (tsType.split("|").some((part) => part.trim() === "null")) {
      valueKinds.push("null");
    }

    return valueKinds;
  }

  const parts = tsType.split("|").map((part) => part.trim());
  const primitiveKinds = [];

  for (const part of parts) {
    if (part === "string") {
      primitiveKinds.push("string");
    } else if (part === "number") {
      primitiveKinds.push("number");
    } else if (part === "boolean") {
      primitiveKinds.push("boolean");
    } else if (part === "null") {
      primitiveKinds.push("null");
    }
  }

  return primitiveKinds.length > 0 ? primitiveKinds : ["unknown"];
}

const bridge = {
  public: Object.fromEntries(
    BRIDGE_TABLES.map((tableName) => {
      const fields = extractRowFieldTypes(source, tableName);

      return [
        tableName,
        {
          row: {
            columns: Object.keys(fields),
            fields,
          },
        },
      ];
    }),
  ),
};

const bridgeJson = `${JSON.stringify(bridge, null, 2)}\n`;

await writeFile(bridgePath, bridgeJson, "utf8");
await writeFile(orchestratorBridgePath, bridgeJson, "utf8");
