import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupSettings, deletePlan, filterBranches, groupOf, initialSelection, jobLabel, localCaption, remoteBranchName, remoteCaption, shortName, tagsOf, type CleanupBranch } from "./cleanup.ts";

const b = (name: string, r: Partial<CleanupBranch> = {}): CleanupBranch => ({
  name, remote: name.startsWith("refs/remotes/") ? name.split("/")[2] : null, oid: "0".repeat(40), time: 0, author: "Jane Doe", subject: `work on ${name}`,
  ahead: 0, behind: 0, merged: false, stale: false, gone: false, ...r,
});
const list = [
  b("refs/heads/done", { merged: true, stale: true }),
  b("refs/heads/old", { stale: true, ahead: 2 }),
  b("refs/heads/gone", { gone: true, stale: true, ahead: 1 }),
  b("refs/remotes/origin/done", { merged: true }),
  b("refs/remotes/up/stale/x", { stale: true }),
];

test("groups by the strongest reason; tags show every reason", () => {
  assert.deepEqual(list.map(groupOf), ["merged", "stale", "gone", "remote-merged", "remote-stale"]);
  assert.deepEqual(tagsOf(list[0]), ["merged", "stale"]);
  assert.deepEqual(tagsOf(list[2]), ["stale", "upstream gone"]);
  assert.deepEqual(list.map(shortName), ["done", "old", "gone", "origin/done", "up/stale/x"]);
  assert.equal(remoteBranchName(list[4]), "stale/x");
});

test("only merged branches start selected", () => {
  assert.deepEqual([...initialSelection(list)], ["refs/heads/done", "refs/remotes/origin/done"]);
});

test("filter: every word in the name, subject or author", () => {
  assert.deepEqual(filterBranches(list, "").length, 5);
  assert.deepEqual(filterBranches(list, " DONE ").map(shortName), ["done", "origin/done"]);
  assert.deepEqual(filterBranches(list, "work origin").map(shortName), ["origin/done"]);
  assert.deepEqual(filterBranches(list, "jane x").map(shortName), ["up/stale/x"]);
});

test("delete plan: merged -d, unmerged -D (confirmed), remote by remote", () => {
  const p = deletePlan(list, new Set(list.map((x) => x.name)));
  assert.deepEqual(p.merged, ["done"]);
  assert.deepEqual(p.unmerged.map(shortName), ["old", "gone"]);
  assert.deepEqual(p.remote.map(shortName), ["origin/done", "up/stale/x"]);
  assert.deepEqual(p.remotes, ["origin", "up"]);
  const none = deletePlan(list, new Set());
  assert.deepEqual([none.merged, none.unmerged, none.remote], [[], [], []]);
});

test("captions and job labels", () => {
  assert.equal(localCaption(7), "Delete 7 local branches");
  assert.equal(localCaption(1), "Delete 1 local branch");
  assert.equal(remoteCaption(2), "Delete 2 remote branches…");
  assert.equal(jobLabel("git branch -d", ["a", "b"]), "git branch -d a b");
  assert.equal(jobLabel("git branch -d", ["a", "b", "c", "d", "e"]), "git branch -d a b c … (5 branches)");
});

test("settings from a hand-edited file", () => {
  assert.deepEqual(cleanupSettings(90, ["main", "release/*"]), { stale_days: 90, protected: ["main", "release/*"] });
  assert.deepEqual(cleanupSettings(-3, "main"), { stale_days: 0, protected: [] });
  assert.deepEqual(cleanupSettings("x", [" a ", "", 4, "a", "b\nc"]), { stale_days: 90, protected: ["a"] });
  assert.equal(cleanupSettings(12.7, []).stale_days, 12);
});
