import { test } from "node:test";
import assert from "node:assert/strict";
import { fillArgv, fillSelector, nextSelector } from "./customGit.ts";
import { cloneName, cloneUrlError, folderNameError, folderPathError } from "./repoSetup.ts";

test("fillArgv fills variables anywhere, keeps unknown ones and selectors", () => {
  assert.deepEqual(fillArgv(["log", "$commit", "--format=%H $short_commit", "$select_branch", "$nope"], { commit: "abc123", short_commit: "abc" }),
    ["log", "abc123", "--format=%H abc", "$select_branch", "$nope"]);
  assert.deepEqual(fillArgv(["push", "$remote", "-f"], { remote: "origin" }), ["push", "origin", "-f"]);
});

test("fillArgv refuses bad shapes and hostile values", () => {
  for (const bad of [undefined, [], "gc", [1], ["a", null]]) assert.throws(() => fillArgv(bad, {}), /argv/);
  assert.throws(() => fillArgv(["rm", "$path"], { path: "--force" }), /option/);
  assert.throws(() => fillArgv(["add", "$path"], { path: "-n" }), /option/);
  assert.throws(() => fillArgv(["log", "$path"], { path: "a\nb" }), /control/);
  assert.throws(() => fillArgv(["x", "$commits"], { commits: ["a", "b"] }), /not text/);
  // inside an argument a dash is harmless; template options stay options
  assert.deepEqual(fillArgv(["log", "--", "x$path"], { path: "-n" }), ["log", "--", "x-n"]);
});

test("selectors are asked one by one, in order", () => {
  let argv = ["rebase", "-i", "$select_branch", "--onto=$select_commit", "$select_branch"];
  assert.equal(nextSelector(argv), "select_branch");
  argv = fillSelector(argv, "select_branch", "main");
  assert.deepEqual(argv, ["rebase", "-i", "main", "--onto=$select_commit", "main"]);
  assert.equal(nextSelector(argv), "select_commit");
  argv = fillSelector(argv, "select_commit", "abc");
  assert.equal(nextSelector(argv), null);
  assert.equal(nextSelector(["x", "$select_branches", "$texts"]), null, "whole names only");
  assert.equal(nextSelector(["commit", "-m", "$text"]), "text");
});

test("clone/new repository checks mirror core", () => {
  assert.equal(cloneName("https://github.com/u/repo.git"), "repo");
  assert.equal(cloneName("git@host:u/repo.git/"), "repo");
  assert.equal(cloneName("/srv/x/repo/.git"), "repo");
  assert.equal(cloneName("host:repo"), "repo");
  assert.equal(cloneUrlError("https://x/y"), "");
  for (const u of ["", "-u x", "--upload-pack=x", "ext::sh -c x", "FD::3", "a\nb"]) assert.notEqual(cloneUrlError(u), "", u);
  assert.equal(folderNameError("repo"), "");
  for (const n of ["", ".", "..", "-x", "a/b", "a\tb"]) assert.notEqual(folderNameError(n), "", n);
  for (const p of ["~", "~/p", "/abs"]) assert.equal(folderPathError(p), "", p);
  for (const p of ["rel", "-x", "~x", "/a\nb"]) assert.notEqual(folderPathError(p), "", p);
});
