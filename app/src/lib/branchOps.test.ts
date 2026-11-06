import { test } from "node:test";
import assert from "node:assert/strict";
import { MERGE_FLAGS, PULL_OPTIONS, PUSH_OPTIONS, hardResetLoss, isUnmerged, pushTarget, refNameError, remainingFlags, remoteUrlError, splitRemote } from "./branchOps.ts";

test("ref names follow git's rules and are never option-like", () => {
  for (const ok of ["main", "feature/x", "v1.2.3", "a-b_c", "üñí"]) assert.equal(refNameError(ok), null, ok);
  for (const bad of ["", "--force", "-D", "a b", "a\tb", "x\ny", "a..b", "bad~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "@", "HEAD",
    "a@{1}", "/a", "a/", "a.", "a//b", ".hidden", "x/.y", "x.lock", "a/b.lock"]) {
    assert.notEqual(refNameError(bad), null, JSON.stringify(bad));
  }
});

test("merge flags drop the ones git refuses together", () => {
  const names = (chosen: string[]) => remainingFlags(MERGE_FLAGS, chosen).map((f) => f.flag);
  assert.deepEqual(names([]), ["--no-ff", "--ff-only", "--squash", "--no-commit"]);
  assert.deepEqual(names(["--no-ff"]), ["--no-commit"]);
  assert.deepEqual(names(["--no-commit"]), ["--no-ff", "--ff-only", "--squash"]);
  assert.deepEqual(names(["--squash", "--no-commit"]), []);
});

test("remote branches split at the longest remote", () => {
  assert.deepEqual(splitRemote(["origin", "up"], "origin/feature/x"), ["origin", "feature/x"]);
  assert.deepEqual(splitRemote(["a", "a/b"], "a/b/c"), ["a/b", "c"]);
  assert.equal(splitRemote(["origin"], "origin/"), null);
  assert.equal(splitRemote(["origin"], "other/x"), null);
});

test("unmerged delete and hard reset texts", () => {
  assert.ok(isUnmerged("error: the branch 'side' is not fully merged."));
  assert.ok(!isUnmerged("error: branch 'x' not found."));
  assert.equal(hardResetLoss("main", 2, 1), "2 commits will leave main; 1 uncommitted file change will be discarded.");
  assert.equal(hardResetLoss("main", 1, 0), "1 commit will leave main.");
  assert.match(hardResetLoss("main", 0, 0), /Nothing is lost/);
});

test("pull/push options and the push target", () => {
  assert.deepEqual(PULL_OPTIONS.map((o) => o.label), ["pull", "pull --ff-only", "pull --rebase", "pull --rebase --autostash", "fetch", "fetch --tags", "fetch --prune"]);
  assert.deepEqual(PUSH_OPTIONS.filter((o) => o.confirm).map((o) => o.label), ["push --force"], "only --force asks again");
  assert.deepEqual(pushTarget("main", "origin/main", ["origin", "up"]), { branch: "main", remote: "origin" });
  assert.deepEqual(pushTarget("x", "my/fork/x", ["my/fork", "my"]), { branch: "x", remote: "my/fork" }, "longest remote name");
  assert.deepEqual(pushTarget("x", null, ["origin"]), { branch: "x", remote: "origin" }, "one remote: no question");
  assert.deepEqual(pushTarget("x", null, ["a", "b"]), { branch: "x", remote: null }, "several: ask");
  assert.deepEqual(pushTarget(null, null, []), { branch: null, remote: null });
});

test("remote URLs", () => {
  for (const ok of ["git@github.com:me/r.git", "https://example.com/r.git", "/srv/repos/r.git", "../r", "ssh://host/~/r"]) assert.equal(remoteUrlError(ok), null, ok);
  for (const bad of ["", "  ", "--upload-pack=x", "-u", "ext::sh -c x", "EXT::x", "a\nb", "a\u0007b"]) assert.notEqual(remoteUrlError(bad), null, JSON.stringify(bad));
});
