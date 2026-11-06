import { test } from "node:test";
import assert from "node:assert/strict";
import { actionForKey, firstChange, initialRows, jobLabel, moveRow, preview, publishedRewritten, setAction, toSteps, validate, type RebaseCommit } from "./rebase.ts";

const c = (n: string, published = false): RebaseCommit => ({ oid: n.repeat(40).slice(0, 40), author: "Jane Doe", time: 0, subject: `subject ${n}`, message: `subject ${n}\n\nbody ${n}`, published });
const original = [c("a", true), c("b", true), c("c"), c("d")];
const oids = (rows: { commit: RebaseCommit }[]) => rows.map((r) => r.commit.oid[0]).join("");

test("moves clamp and keep the other rows in order", () => {
  const rows = initialRows(original);
  assert.equal(oids(moveRow(rows, 3, 0)), "dabc");
  assert.equal(oids(moveRow(rows, 0, 2)), "bcad");
  assert.equal(oids(moveRow(rows, 1, 99)), "acdb");
  assert.equal(moveRow(rows, 2, 2), rows, "no move, same list");
  assert.equal(oids(moveRow(rows, 0, -1)), "abcd");
});

test("actions: keys, reword starts from the commit's message, steps carry reword messages only", () => {
  assert.deepEqual(["p", "R", "s", "f", "d", "x"].map(actionForKey), ["pick", "reword", "squash", "fixup", "drop", null]);
  let rows = setAction(initialRows(original), 2, "reword");
  assert.equal(rows[2].message, "subject c\n\nbody c");
  rows = rows.map((r, i) => (i === 2 ? { ...r, message: "better c" } : r));
  rows = setAction(setAction(rows, 2, "pick"), 2, "reword");
  assert.equal(rows[2].message, "better c", "switching back and forth keeps the edit");
  rows = setAction(rows, 3, "fixup");
  assert.deepEqual(toSteps(rows).map((s) => [s.oid[0], s.action, s.message]), [["a", "pick", null], ["b", "pick", null], ["c", "reword", "better c"], ["d", "fixup", null]]);
});

test("preview: squash and fixup join the nearest kept commit above, drops vanish", () => {
  let rows = initialRows(original);
  rows = setAction(setAction(setAction(rows, 1, "drop"), 2, "squash"), 3, "fixup");
  const p = preview(rows);
  assert.equal(p.length, 1);
  assert.equal(p[0].head.commit.oid[0], "a");
  assert.deepEqual(p[0].joined.map((r) => r.action), ["squash", "fixup"]);
  rows = setAction(initialRows(original), 0, "reword");
  rows[0] = { ...rows[0], message: "new a\nmore" };
  assert.equal(preview(rows)[0].subject, "new a");
  assert.equal(preview(setAction(initialRows(original), 0, "drop")).length, 3);
});

test("validate: first kept commit cannot join, empty reword, nothing to change", () => {
  const rows = initialRows(original);
  assert.match(validate(rows, original)!, /Nothing to change/);
  assert.match(validate(setAction(rows, 0, "squash"), original)!, /cannot be squash/);
  assert.match(validate(setAction(setAction(rows, 0, "drop"), 1, "fixup"), original)!, /cannot be fixup/);
  const empty = setAction(rows, 2, "reword");
  empty[2] = { ...empty[2], message: "  \n" };
  assert.match(validate(empty, original)!, /empty/);
  assert.equal(validate(setAction(rows, 1, "squash"), original), null);
  assert.equal(validate(moveRow(rows, 3, 2), original), null);
  assert.equal(validate(rows.map((r) => ({ ...r, action: "drop" as const })), original), null, "dropping everything resets to the base");
});

test("published commits rewritten: from the first change on", () => {
  const rows = initialRows(original);
  assert.equal(firstChange(rows, original), -1);
  assert.equal(publishedRewritten(rows, original), 0);
  assert.equal(publishedRewritten(moveRow(rows, 3, 2), original), 0, "only unpublished ones change");
  assert.equal(publishedRewritten(setAction(rows, 1, "squash"), original), 1);
  assert.equal(publishedRewritten(moveRow(rows, 0, 3), original), 2);
});

test("job label says what changes", () => {
  const rows = setAction(moveRow(initialRows(original), 3, 2), 1, "fixup");
  assert.equal(jobLabel(rows, original, "f".repeat(40)), "git rebase -i fffffff (4 commits: 1 fixup, 2 moved)");
  assert.equal(jobLabel(setAction(initialRows(original), 0, "drop"), original, null), "git rebase -i --root (4 commits: 1 drop)");
});
