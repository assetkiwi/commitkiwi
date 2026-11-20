import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, baseName, fullDate, initials, splitTicket, stamp, stripComments } from "./format.ts";

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
test("stamp", () => {
  const now = new Date(2026, 10, 20, 15, 0).getTime(); // Fri 20 Nov 2026, 15:00 local
  const at = (...a: number[]) => new Date(...(a as [number, number, number, number, number])).getTime() / 1000;
  assert.equal(stamp(at(2026, 10, 20, 9, 5), "24", now), "09:05");
  assert.match(stamp(at(2026, 10, 20, 21, 5), "12", now), /^9:05\s?PM$/i);
  assert.equal(stamp(at(2026, 10, 19, 22, 39), "24", now), "Thu, 22:39");
  assert.equal(stamp(at(2026, 10, 14, 0, 1), "24", now), "Sat, 00:01");
  assert.equal(stamp(at(2026, 10, 13, 23, 0), "24", now), "13 Nov");
  assert.equal(stamp(at(2024, 2, 3, 12, 0), "24", now), "3 Mar 2024");
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
