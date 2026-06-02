import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const packageTypesPath = path.join(
  repoRoot,
  "node_modules",
  "@kmgrassi",
  "supabase-schema",
  "src",
  "database.types.ts",
);
const generatedTypesPath = path.join(repoRoot, "supabase", "generated", "types.ts");

try {
  await stat(packageTypesPath);
} catch {
  console.error(
    [
      "Missing @kmgrassi/supabase-schema package types.",
      "Install dependencies with NODE_AUTH_TOKEN set to a GitHub token that has read access to GitHub Packages.",
      "The Platform package must also grant Actions access to this repository in GitHub Packages settings.",
    ].join("\n"),
  );
  process.exit(1);
}

await mkdir(path.dirname(generatedTypesPath), { recursive: true });
await copyFile(packageTypesPath, generatedTypesPath);
console.log(`Copied ${packageTypesPath} to ${generatedTypesPath}`);
