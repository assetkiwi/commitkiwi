import { test } from "node:test";
import assert from "node:assert/strict";
import { filterByName, fullRef, refTree } from "./refs.ts";

test("full ref names per kind", () => {
  assert.equal(fullRef("branch", "feature/x"), "refs/heads/feature/x");
  assert.equal(fullRef("remote", "origin/main"), "refs/remotes/origin/main");
  assert.equal(fullRef("tag", "v1"), "refs/tags/v1");
});

test("slashes become nested folders, order kept", () => {
  const t = refTree([{ name: "feature/a" }, { name: "feature/deep/b" }, { name: "main" }, { name: "feature/c" }]);
  assert.deepEqual(t.map((n) => [n.label, n.path, !!n.item]), [["feature", "feature", false], ["main", "main", true]]);
  const f = t[0].children;
  assert.deepEqual(f.map((n) => n.label), ["a", "deep", "c"]);
  assert.deepEqual(f[1].children.map((n) => [n.label, n.path]), [["b", "feature/deep/b"]]);
  assert.equal(f[1].path, "feature/deep");
});

test("filter is a case-insensitive substring match", () => {
  const items = [{ name: "feature/D11-upgrade" }, { name: "main" }];
  assert.deepEqual(filterByName(items, "d11").map((i) => i.name), ["feature/D11-upgrade"]);
  assert.equal(filterByName(items, "  ").length, 2);
});
