import assert from "node:assert/strict";
import { test } from "node:test";
import { countChanges, genInput, MAX_PATCHES, patchPaths, stagedFiles, statusLetter } from "./commitModel.ts";
import type { WorkFile } from "./types.ts";

const wf = (path: string, index: string, kind: WorkFile["kind"] = "changed"): WorkFile => ({ path, old_path: null, index, worktree: ".", kind });

test("only staged, changed files count", () => {
  const files = [wf("a.rs", "M"), wf("b.rs", "."), wf("c.rs", "A", "untracked"), wf("d.rs", "D"), wf("e.rs", "U", "conflicted")];
  assert.deepEqual(stagedFiles(files).map((f) => f.path), ["a.rs", "d.rs"]);
});

test("git letters become the model's vocabulary", () => {
  assert.deepEqual(["A", "C", "D", "R", "M", "T"].map(statusLetter), ["A", "A", "D", "R", "M", "M"]);
});

test("patches are asked for real files only, capped", () => {
  const staged = [wf("Cargo.lock", "M"), wf("src/a.rs", "M"), wf("pnpm-lock.yaml", "M"), wf("assets/logo.svg", "A"), wf("node_modules/x/y.js", "M")];
  assert.deepEqual(patchPaths(staged), ["src/a.rs"]);
  const many = Array.from({ length: 40 }, (_, i) => wf(`src/f${i}.rs`, "M"));
  assert.equal(patchPaths(many).length, MAX_PATCHES);
});

test("line counts skip the file headers", () => {
  const p = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n+more\n context\n";
  assert.deepEqual(countChanges(p), { adds: 2, dels: 1 });
  assert.deepEqual(countChanges(""), { adds: 0, dels: 0 });
});

test("the input keeps every file, patches only where fetched, counts only where known", () => {
  const staged = [wf("src/a.rs", "M"), wf("Cargo.lock", "M"), wf("new.txt", "A")];
  const patches = new Map([["src/a.rs", "--- a\n+++ b\n-x\n+y\n+z\n"]]);
  const i = genInput("feature/x", ["fix: a"], staged, patches);
  assert.equal(i.branch, "feature/x");
  assert.deepEqual(i.files, [
    { path: "src/a.rs", status: "M", adds: 2, dels: 1 },
    { path: "Cargo.lock", status: "M", adds: null, dels: null },
    { path: "new.txt", status: "A", adds: null, dels: null },
  ]);
  assert.deepEqual(i.patches.map(([p]) => p), ["src/a.rs"]);
});
