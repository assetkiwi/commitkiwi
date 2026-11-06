import { test } from "node:test";
import assert from "node:assert/strict";
import { sideColumns, visibleSide } from "./layout.ts";

test("the four side bar layouts", () => {
  assert.deepEqual(sideColumns("tabs", true), [["locations", "commits", "files"]]);
  assert.deepEqual(sideColumns("commit_graph_as_column", true), [["locations", "files"], ["commits"]]);
  assert.deepEqual(sideColumns("locations_as_column", true), [["locations"], ["commits", "files"]]);
  assert.deepEqual(sideColumns("columns", true), [["locations"], ["commits"], ["files"]]);
  assert.deepEqual(sideColumns("bogus", true), sideColumns("locations_as_column", true));
});

test("hiding the side bar closes every column", () => {
  for (const l of ["tabs", "commit_graph_as_column", "locations_as_column", "columns", "bogus"]) assert.deepEqual(sideColumns(l, false), []);
});

test("a tabbed column falls back to Commits, then its first tab", () => {
  assert.equal(visibleSide(["commits", "files"], "files"), "files");
  assert.equal(visibleSide(["commits", "files"], "locations"), "commits");
  assert.equal(visibleSide(["locations", "files"], "commits"), "locations");
});
