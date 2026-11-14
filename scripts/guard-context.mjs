#!/usr/bin/env node
// Keeps local scratch out of the repository. Default mode fails when a tracked or staged path sits
// under a `.context/` directory at any depth; `--history <base>` also fails when any commit since
// `<base>` contains one, even if it was removed again later. Contributors on any machine run this
// through npm scripts; nothing here depends on a local hook being installed.

import { execFileSync } from "node:child_process";

const git = (args) => execFileSync("git", args, { encoding: "utf8" });
const paths = (args) => git(args).split("\0").filter(Boolean);

// Any complete `.context` component, at any depth, as `.gitignore`'s `.context/` matches it.
const inContext = (path) => path.split("/").includes(".context");

const mode = process.argv[2];
if (mode === "--history") {
  const base = process.argv[3] ?? "origin/main";
  let shallow;
  let commits;
  try {
    // A shallow clone lists only the commits it has: `base..HEAD` succeeding there proves nothing.
    shallow = git(["rev-parse", "--is-shallow-repository"]).trim() !== "false";
    commits = git(["rev-list", `${base}..HEAD`]).split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    console.error(`guard:context: couldn't list commits since ${base}; run from a clone of the repository.`);
    process.exit(1);
  }
  if (shallow) {
    console.error("guard:context: this clone's history is incomplete (shallow); run `git fetch --unshallow` and retry.");
    process.exit(1);
  }
  const bad = new Set();
  for (const commit of commits) {
    for (const path of paths(["ls-tree", "-z", "-r", "--name-only", commit])) {
      if (inContext(path)) bad.add(path);
    }
  }
  if (bad.size > 0) {
    console.error("guard:context: .context paths exist in history since " + base + ":");
    for (const path of bad) console.error("  " + path);
    process.exit(1);
  }
  process.exit(0);
}

if (mode === undefined) {
  const bad = paths(["ls-files", "-z"]).filter(inContext); // tracked or staged: the index is the truth here
  if (bad.length > 0) {
    console.error("guard:context: .context paths are tracked or staged. Remove them from the index; never commit local scratch:");
    for (const path of bad) console.error("  " + path);
    process.exit(1);
  }
  process.exit(0);
}

console.error("usage: node scripts/guard-context.mjs [--history <base>]");
process.exit(2);
