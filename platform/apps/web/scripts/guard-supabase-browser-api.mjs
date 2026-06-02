import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const srcRoot = join(root, "src");
const approvedSupabaseImport = "src/api/supabase.ts";
const bannedPatterns = [
  /\bfromTable\s*\(/,
  /\bfromView\s*\(/,
  /\bcallRpc\s*\(/,
  /getSupabaseClient\s*\(\s*\)\s*\.\s*(from|rpc|channel)\s*\(/,
  /\bsupabase\s*\.\s*(from|rpc|channel)\s*\(/,
  /\bclient\s*\.\s*(from|rpc|channel)\s*\(/,
  /supabase-db/,
];

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* files(path);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      yield path;
    }
  }
}

const violations = [];

for await (const file of files(srcRoot)) {
  const rel = relative(root, file);
  const source = await readFile(file, "utf8");

  if (
    source.includes("@supabase/supabase-js") &&
    rel !== approvedSupabaseImport
  ) {
    violations.push(
      `${rel}: @supabase/supabase-js may only be imported by ${approvedSupabaseImport}`,
    );
  }

  for (const pattern of bannedPatterns) {
    if (pattern.test(source)) {
      violations.push(
        `${rel}: banned browser Supabase data-access pattern ${pattern}`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error("Browser Supabase guard failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}
