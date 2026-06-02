#!/usr/bin/env node
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    yes: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    "delete-branches": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (opts.help) {
  process.stdout.write(`Usage: pnpm worktrees:prune [options]

  Audit git worktrees and remove stale ones. By default this is a dry run —
  pass --yes to actually remove anything.

  A worktree is considered safe to remove when:
    - git itself marks it prunable (the working tree was deleted on disk)
    - its branch is fully merged into main and the working tree is clean

  Options:
    --yes               Actually remove worktrees flagged REMOVE (default: dry run)
    --force             Also remove worktrees with uncommitted/untracked changes
    --delete-branches   After removing a worktree, also delete its branch
    -h, --help          Show this help
`);
  process.exit(0);
}

function git(args, opts = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function tryGit(args) {
  try {
    return git(args).trim();
  } catch {
    return "";
  }
}

function parseWorktreeList() {
  const raw = git(["worktree", "list", "--porcelain"]);
  const entries = [];
  let current = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = {
        path: line.slice("worktree ".length),
        branch: null,
        prunable: false,
        locked: false,
        detached: false,
      };
    } else if (!current) {
      continue;
    } else if (line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.detached = true;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    } else if (line.startsWith("locked")) {
      current.locked = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

function mergedBranches(base) {
  const out = tryGit([
    "branch",
    "--list",
    "--merged",
    base,
    "--format=%(refname:short)",
  ]);
  return new Set(
    out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function worktreeIsDirty(path) {
  // Status from the perspective of the worktree itself.
  try {
    const out = execFileSync("git", ["-C", path, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().length > 0;
  } catch {
    // Worktree path missing or unreadable — treat as not-dirty so the
    // prunable path can remove it.
    return false;
  }
}

function classify(entry, mainPath, merged) {
  if (entry.path === mainPath) return { status: "main", action: "keep" };
  if (entry.locked) return { status: "locked", action: "keep" };
  if (entry.prunable) return { status: "prunable", action: "REMOVE" };

  const branch = entry.branch;
  const exists = existsSync(entry.path);
  if (!exists) return { status: "missing", action: "REMOVE" };

  if (branch && merged.has(branch)) {
    const dirty = worktreeIsDirty(entry.path);
    if (dirty)
      return { status: "merged+dirty", action: opts.force ? "REMOVE" : "keep" };
    return { status: "merged", action: "REMOVE" };
  }

  return { status: "active", action: "keep" };
}

function pad(s, n) {
  s = String(s ?? "");
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function shortPath(p, home) {
  if (home && p.startsWith(home + "/")) return "~/" + p.slice(home.length + 1);
  return p;
}

function main() {
  // Resolve repo root and main worktree path.
  const repoRoot = tryGit(["rev-parse", "--show-toplevel"]);
  if (!repoRoot) {
    console.error("Not inside a git repository.");
    process.exit(1);
  }

  // Parse BEFORE running `git worktree prune`. Prune drops stale entries
  // from git's records, which would also drop the branch metadata we need
  // for --delete-branches. We run `git worktree prune` later, after we've
  // captured each prunable row's branch name.
  const entries = parseWorktreeList();
  if (entries.length === 0) {
    console.log("No worktrees found.");
    return;
  }
  const mainPath = entries[0].path;
  const merged = mergedBranches("main");

  const home = process.env.HOME ?? "";
  const rows = entries.map((e) => ({
    entry: e,
    ...classify(e, mainPath, merged),
  }));

  const pathW = Math.max(
    20,
    ...rows.map((r) => shortPath(r.entry.path, home).length),
  );
  const branchW = Math.max(
    10,
    ...rows.map(
      (r) => (r.entry.branch ?? (r.entry.detached ? "(detached)" : "?")).length,
    ),
  );

  console.log(
    pad("STATUS", 14) +
      pad("PATH", pathW + 2) +
      pad("BRANCH", branchW + 2) +
      "ACTION",
  );
  console.log("-".repeat(14 + pathW + 2 + branchW + 2 + 6));
  for (const r of rows) {
    const branchLabel =
      r.entry.branch ?? (r.entry.detached ? "(detached)" : "?");
    console.log(
      pad(r.status, 14) +
        pad(shortPath(r.entry.path, home), pathW + 2) +
        pad(branchLabel, branchW + 2) +
        r.action,
    );
  }

  const toRemove = rows.filter((r) => r.action === "REMOVE");
  if (toRemove.length === 0) {
    console.log("\nNothing to remove.");
    return;
  }

  console.log(`\n${toRemove.length} worktree(s) flagged REMOVE.`);
  if (!opts.yes) {
    console.log("Dry run — pass --yes to actually remove them.");
    if (!opts.force && rows.some((r) => r.status === "merged+dirty")) {
      console.log(
        "Some merged worktrees have uncommitted changes; pass --force to include them.",
      );
    }
    return;
  }

  let prunePending = false;

  for (const r of toRemove) {
    let removed = false;
    if (r.status === "prunable" || r.status === "missing") {
      // The working tree directory is gone, so `git worktree remove` can't
      // act on it by path. Defer cleanup to a single `git worktree prune`
      // after the loop; record the branch now so --delete-branches still
      // works.
      prunePending = true;
      console.log(`will prune: ${r.entry.path}`);
      removed = true;
    } else {
      const args = ["worktree", "remove"];
      if (opts.force) args.push("--force");
      args.push(r.entry.path);
      try {
        git(args);
        console.log(`removed: ${r.entry.path}`);
        removed = true;
      } catch (err) {
        const msg =
          err && err.stderr ? err.stderr.toString().trim() : String(err);
        console.error(`failed:  ${r.entry.path} — ${msg}`);
      }
    }

    if (
      removed &&
      opts["delete-branches"] &&
      r.entry.branch &&
      r.entry.branch !== "main"
    ) {
      try {
        git(["branch", "-D", r.entry.branch]);
        console.log(`  branch deleted: ${r.entry.branch}`);
      } catch (err) {
        const msg =
          err && err.stderr ? err.stderr.toString().trim() : String(err);
        console.error(`  branch delete failed: ${r.entry.branch} — ${msg}`);
      }
    }
  }

  if (prunePending) {
    try {
      execSync("git worktree prune --verbose", { stdio: "inherit" });
    } catch (err) {
      const msg =
        err && err.stderr ? err.stderr.toString().trim() : String(err);
      console.error(`git worktree prune failed: ${msg}`);
    }
  }
}

main();
