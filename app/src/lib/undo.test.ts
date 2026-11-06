import { test } from "node:test";
import assert from "node:assert/strict";
import { movesLocal, planCaption, undoModeOf, undoPlan, undoStacks } from "./undo.ts";
import type { Job, Moved } from "./journal.ts";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const commitMove = (from: string, to: string): Moved => ({
  head_before: { branch: "refs/heads/main", oid: from }, head_after: { branch: "refs/heads/main", oid: to },
  refs: [{ name: "refs/heads/main", before: from, after: to }],
});
let n = 0;
const job = (label: string, moved: Moved | null, extra: Partial<Job> = {}): Job => ({
  id: ++n, repo: "r", label, status: "ok", queued: n, start: n, end: n, output: "", error: "", cancelling: false, moved, ...extra,
});
const now = (oid: string, branch: string | null = "main") => ({ branch, oid, busy: false, op: null });

test("undo stack: newest ref-moving entry; undo moves it to redo; a new write clears redo", () => {
  const c1 = job("git commit", commitMove(A, B)), stage = job("git add x", null), c2 = job("git commit", commitMove(B, C));
  let jobs = [c1, stage, c2];
  assert.deepEqual(undoStacks(jobs, "r").done.map((j) => j.id), [c1.id, c2.id], "staging is not an undo step");
  const u = job("Undo: commit", null, { undo: { of: c2.id, redo: false } });
  jobs = [...jobs, u];
  let s = undoStacks(jobs, "r");
  assert.deepEqual([s.done.map((j) => j.id), s.redo.map((j) => j.id)], [[c1.id], [c2.id]]);
  assert.equal(undoPlan(s, true, now(B)).caption, "Redo: commit");
  jobs = [...jobs, job("Redo: commit", null, { undo: { of: c2.id, redo: true } })];
  s = undoStacks(jobs, "r");
  assert.deepEqual([s.done.length, s.redo.length], [2, 0]);
  // undo again, then any other write that ran clears redo; failed undo jobs change nothing
  jobs = [...jobs, job("Undo: commit", null, { undo: { of: c2.id, redo: false } }), job("Undo: commit", null, { status: "failed", undo: { of: c1.id, redo: false } })];
  assert.equal(undoStacks(jobs, "r").redo.length, 1);
  jobs = [...jobs, job("git add y", null)];
  assert.equal(undoStacks(jobs, "r").redo.length, 0);
  // queued, running, never-started and other repos' jobs don't count
  const later = [job("git commit", commitMove(B, C), { status: "running" }), job("git commit", commitMove(B, C), { status: "cancelled", start: null }), job("git commit", commitMove(B, C), { repo: "other" })];
  assert.deepEqual(undoStacks([...jobs, ...later], "r").done.map((j) => j.id), [c1.id]);
});

test("undo plan: refuses with a reason", () => {
  const s = undoStacks([job("git reset --hard abc", commitMove(A, B))], "r");
  assert.deepEqual(undoPlan(s, false, now(B)), { job: s.done[0], caption: "Undo: reset --hard abc", reason: null });
  assert.equal(undoPlan(s, false, now(C)).reason, "the repository changed since");
  assert.equal(undoPlan(s, false, now(B, "other")).reason, "the repository changed since");
  assert.equal(undoPlan(s, false, now(B, null)).reason, "the repository changed since", "detached now, on main then");
  assert.equal(undoPlan(s, false, { ...now(B), busy: true }).reason, "a git command is running");
  assert.equal(undoPlan(s, false, { ...now(B), op: "rebase" }).reason, "a rebase is in progress");
  const nothing = undoPlan(s, true, now(B));
  assert.deepEqual([nothing.job, nothing.reason, planCaption(nothing)], [null, "Nothing to redo", "Redo"]);
  assert.equal(planCaption(undoPlan(s, false, now(C))), "Undo: reset --hard abc (the repository changed since)");
  // a fetch/push moves only remote-tracking refs: it blocks undo instead of being skipped
  const fetch: Moved = { head_before: { branch: "refs/heads/main", oid: B }, head_after: { branch: "refs/heads/main", oid: B }, refs: [{ name: "refs/remotes/origin/main", before: A, after: B }] };
  const s2 = undoStacks([job("git commit", commitMove(A, B)), job("git fetch", fetch)], "r");
  assert.equal(undoPlan(s2, false, now(B)).reason, "it only changed remote-tracking branches");
  assert.equal(movesLocal(fetch), false);
  // nothing moved at all (checkout of the current branch): not an undo step
  const noop: Moved = { head_before: fetch.head_before, head_after: fetch.head_before, refs: [] };
  assert.equal(undoStacks([job("git checkout main", noop)], "r").done.length, 0);
});

test("undo mode per request", () => {
  assert.equal(undoModeOf({ Commit: {} }), "soft");
  assert.equal(undoModeOf({ Reset: { mode: "soft" } }), "soft");
  assert.equal(undoModeOf({ Reset: { mode: "mixed" } }), "mixed");
  assert.equal(undoModeOf({ Reset: { mode: "hard" } }), "keep");
  assert.equal(undoModeOf({ Merge: {} }), "keep");
});
