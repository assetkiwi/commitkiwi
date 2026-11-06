import { test } from "node:test";
import assert from "node:assert/strict";
import { positionOf, remapParents, visibleRows } from "./collapse.ts";

// 0 = merge(1, 2); 1 = main; 2 = feature commit (merged, no ref); 3 = base
const P = [[1, 2], [3], [3], []];

test("nothing collapsed: every row", () => {
  assert.equal(visibleRows(P, [0], new Set()), null);
});

test("collapsing a merge hides what only it reaches", () => {
  const rows = visibleRows(P, [0], new Set([0]))!;
  assert.deepEqual(Array.from(rows), [0, 1, 3]);
  assert.deepEqual(remapParents(P, rows), [[1], [2], []]);
  assert.equal(positionOf(rows, 3), 2);
  assert.equal(positionOf(rows, 2), -1);
});

test("a ref on the merged commit keeps it visible", () => {
  assert.equal(visibleRows(P, [0, 2], new Set([0])), null);
});

test("collapsing a non-merge changes nothing", () => {
  assert.equal(visibleRows(P, [0], new Set([1])), null);
});
