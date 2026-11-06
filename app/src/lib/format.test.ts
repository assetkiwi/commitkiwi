import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, baseName, fullDate, initials, splitTicket, stripComments } from "./format.ts";

test("initials", () => {
  assert.equal(initials("Jane Doe"), "JD");
  assert.equal(initials("  "), "?");
  assert.equal(initials("madonna"), "M");
});
test("ago", () => {
  const now = 1_000_000_000_000;
  assert.equal(ago(now / 1000 - 5, now), "just now");
  assert.equal(ago(now / 1000 - 600, now), "10 min ago");
  assert.equal(ago(now / 1000 - 3 * 3600, now), "3 h ago");
  assert.equal(ago(now / 1000 - 5 * 86400, now), "5 days ago");
  assert.equal(ago(now / 1000 - 400 * 86400, now), "1 y ago");
  assert.equal(ago(now / 1000 + 99, now), "just now"); // clock skew: future commits
});
test("splitTicket", () => {
  assert.deepEqual(splitTicket("[25505977]: Move DDEV"), ["[25505977]:", "Move DDEV"]);
  assert.deepEqual(splitTicket("[PVE-6] Added"), ["[PVE-6]", "Added"]);
  assert.deepEqual(splitTicket("plain subject"), ["", "plain subject"]);
});
test("baseName", () => {
  assert.equal(baseName("/a/b/repo/"), "repo");
  assert.equal(baseName("~"), "~");
});

test("fullDate", () => {
  const t = new Date(2026, 10, 4, 20, 6).getTime() / 1000; // local time, like the app
  assert.equal(fullDate(t), "Wed, 4 Nov, 2026, 20:06");
  assert.equal(fullDate(new Date(2025, 0, 9, 7, 5).getTime() / 1000), "Thu, 9 Jan, 2025, 07:05");
});
test("stripComments", () => {
  assert.equal(stripComments("Merge branch 'x'\n\n# Conflicts:\n#\ta.txt\n"), "Merge branch 'x'");
  assert.equal(stripComments("Fix\n\n #1 stays (not at line start)"), "Fix\n\n #1 stays (not at line start)");
});
