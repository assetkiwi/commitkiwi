import { test } from "node:test";
import assert from "node:assert/strict";
import { isBinaryPatch, parseDiff } from "./diff.ts";

const patch = `diff --git a/f.txt b/f.txt
index 111..222 100644
--- a/f.txt
+++ b/f.txt
@@ -3,4 +3,4 @@ fn
 keep
--- not a header, a deleted line starting with --
-old
+new
+++ also content
\\ No newline at end of file
@@ -20 +20,2 @@
 tail
+extra
`;

test("line numbers and kinds", () => {
  const r = parseDiff(patch);
  assert.deepEqual(r.map((x) => x.kind), ["hunk", "ctx", "del", "del", "add", "add", "meta", "hunk", "ctx", "add"]);
  assert.deepEqual([r[1].old, r[1].new], [3, 3]);
  assert.deepEqual([r[2].old, r[2].text], [4, "-- not a header, a deleted line starting with --"]);
  assert.deepEqual([r[3].old, r[4].new, r[5].new], [5, 4, 5]);
  assert.equal(r[6].text, "No newline at end of file");
  assert.deepEqual([r[8].old, r[8].new, r[9].new], [20, 20, 21]); // single-line hunk header without counts
});

test("headers before the first hunk are skipped; empty and binary patches", () => {
  assert.equal(parseDiff("diff --git a/x b/x\nsimilarity index 100%\nrename from a\nrename to b\n").length, 0);
  assert.equal(parseDiff("").length, 0);
  assert.ok(isBinaryPatch("diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n"));
  assert.ok(!isBinaryPatch(patch));
});

// ---- patch building, verified by letting real git apply the result ---------------------------------------
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPatch, type PatchMode } from "./diff.ts";
import type { DiffRow } from "./diff.ts";

function scratch(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "gm-patch-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x" };
  const g = (args: string[], input?: string) => {
    const r = spawnSync("git", args, { cwd: d, env, input, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  g(["init", "-q", "-b", "main"]);
  for (const [n, t] of Object.entries(files)) writeFileSync(join(d, n), t);
  g(["add", "."]);
  g(["commit", "-qm", "seed"]);
  const apply = (patch: string, mode: PatchMode) =>
    g(["apply", "--recount", "--whitespace=nowarn", ...(mode === "stage" ? ["--cached"] : mode === "unstage" ? ["--cached", "--reverse"] : ["--reverse"]), "-"], patch);
  return { d, g, apply, read: (n: string) => readFileSync(join(d, n), "utf8"), write: (n: string, t: string) => writeFileSync(join(d, n), t) };
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`);
const changeRows = (rows: DiffRow[], keep: (r: DiffRow, i: number) => boolean) =>
  new Set(rows.flatMap((r, i) => ((r.kind === "add" || r.kind === "del") && keep(r, i) ? [i] : [])));
const hunkStarts = (rows: DiffRow[]) => rows.flatMap((r, i) => (r.kind === "hunk" ? [i] : []));

// 30 lines: l2 -> TWO (hunk 1), a line inserted after l15 (hunk 2), l28 deleted (hunk 3)
function threeHunks() {
  const base = lines(30);
  const edited = [...base];
  edited[1] = "TWO";
  edited.splice(15, 0, "inserted");
  edited.splice(edited.indexOf("l28"), 1);
  const s = scratch({ "f.txt": base.join("\n") + "\n" });
  s.write("f.txt", edited.join("\n") + "\n");
  const patch = s.g(["diff"]);
  const rows = parseDiff(patch);
  return { s, base, patch, rows, h: hunkStarts(rows) };
}

test("stage one hunk of three: the others stay unstaged", () => {
  const { s, patch, rows, h } = threeHunks();
  assert.equal(h.length, 3);
  const p = buildPatch(patch, rows, changeRows(rows, (_, i) => i < h[1]), "stage")!;
  s.apply(p, "stage");
  const cached = s.g(["diff", "--cached"]);
  assert.match(cached, /\+TWO/);
  assert.doesNotMatch(cached, /inserted|-l28/);
  assert.match(s.g(["diff"]), /\+inserted/);
});

test("stage hunks 1 and 3, skipping the middle one (line offsets shift)", () => {
  const { s, base, patch, rows, h } = threeHunks();
  s.apply(buildPatch(patch, rows, changeRows(rows, (_, i) => i < h[1] || i > h[2]), "stage")!, "stage");
  const expected = [...base]; expected[1] = "TWO"; expected.splice(expected.indexOf("l28"), 1);
  assert.equal(s.g(["show", ":f.txt"]), expected.join("\n") + "\n");
});

test("stage only the added half of a replaced line: the old line stays in the index", () => {
  const { s, base, patch, rows, h } = threeHunks();
  s.apply(buildPatch(patch, rows, changeRows(rows, (r, i) => i < h[1] && r.kind === "add"), "stage")!, "stage");
  const idx = s.g(["show", ":f.txt"]).split("\n");
  assert.ok(idx.includes("l2") && idx.includes("TWO"), "both old and new line");
  assert.equal(idx.length - 1, base.length + 1);
});

test("stage a single line out of an inserted block", () => {
  const s = scratch({ "f.txt": "a\nb\n" });
  s.write("f.txt", "a\nx\ny\nz\nb\n");
  const patch = s.g(["diff"]);
  const rows = parseDiff(patch);
  const second = [...changeRows(rows, () => true)][1]; // "y"
  s.apply(buildPatch(patch, rows, new Set([second]), "stage")!, "stage");
  assert.equal(s.g(["show", ":f.txt"]), "a\ny\nb\n");
});

test("unstage only the deletion from a fully staged change", () => {
  const { s, patch, rows, h } = threeHunks();
  s.g(["add", "-A"]);
  const staged = s.g(["diff", "--cached"]);
  const srows = parseDiff(staged);
  const sh = hunkStarts(srows);
  s.apply(buildPatch(staged, srows, changeRows(srows, (r, i) => i > sh[2] && r.kind === "del"), "unstage")!, "unstage");
  const cached = s.g(["diff", "--cached"]);
  assert.match(cached, /\+TWO/);
  assert.match(cached, /\+inserted/);
  assert.doesNotMatch(cached, /-l28/);
  assert.match(s.g(["diff"]), /-l28/);
  void patch; void rows; void h;
});

test("discard just the middle hunk from the worktree", () => {
  const { s, patch, rows, h } = threeHunks();
  s.apply(buildPatch(patch, rows, changeRows(rows, (_, i) => i > h[1] && i < h[2]), "discard")!, "discard");
  const now = s.read("f.txt");
  assert.doesNotMatch(now, /inserted/);
  assert.match(now, /TWO/);
  assert.doesNotMatch(now, /l28/);
});

test("partial discard of a replaced line restores only that side", () => {
  const s = scratch({ "f.txt": "a\nold\nc\n" });
  s.write("f.txt", "a\nnew\nc\n");
  const patch = s.g(["diff"]);
  const rows = parseDiff(patch);
  // discard only the deletion half: "old" must NOT come back, "new" stays
  s.apply(buildPatch(patch, rows, changeRows(rows, (r) => r.kind === "del"), "discard")!, "discard");
  assert.equal(s.read("f.txt"), "a\nold\nnew\nc\n");
});

test("no newline at end of file survives", () => {
  const s = scratch({ "f.txt": "a\nb" });
  s.write("f.txt", "a\nc");
  const patch = s.g(["diff"]);
  const rows = parseDiff(patch);
  s.apply(buildPatch(patch, rows, changeRows(rows, () => true), "stage")!, "stage");
  assert.equal(s.g(["show", ":f.txt"]), "a\nc");
});

test("staged new file: unstage some lines, and nothing picked gives null", () => {
  const s = scratch({ "seed.txt": "s\n" });
  s.write("n.txt", "1\n2\n3\n");
  s.g(["add", "n.txt"]);
  const staged = s.g(["diff", "--cached", "--", "n.txt"]);
  const rows = parseDiff(staged);
  assert.equal(buildPatch(staged, rows, new Set(), "unstage"), null);
  s.apply(buildPatch(staged, rows, changeRows(rows, (r) => r.text === "3"), "unstage")!, "unstage");
  assert.equal(s.g(["show", ":n.txt"]), "1\n2\n");
});

test("stage only some deletions of a file deleted in the worktree", () => {
  const s = scratch({ "f.txt": "1\n2\n3\n" });
  spawnSync("rm", [join(s.d, "f.txt")]);
  const patch = s.g(["diff"]);
  const rows = parseDiff(patch);
  s.apply(buildPatch(patch, rows, changeRows(rows, (r) => r.text === "2"), "stage")!, "stage");
  assert.equal(s.g(["show", ":f.txt"]), "1\n3\n");
});

test("staging every line of a new file keeps it a new file", () => {
  const s = scratch({ "seed.txt": "s\n" });
  s.write("n.txt", "1\n2\n");
  s.g(["add", "-N", "n.txt"]); // intent-to-add makes the worktree diff show it as new
  const patch = s.g(["diff", "--", "n.txt"]);
  const rows = parseDiff(patch);
  s.apply(buildPatch(patch, rows, changeRows(rows, () => true), "stage")!, "stage");
  assert.equal(s.g(["show", ":n.txt"]), "1\n2\n");
});

// ---- word diff, split view, marking ----------------------------------------------------------------------
import { hunkRange, markHtml, pairChanges, splitRows, wordDiff } from "./diff.ts";
import { isImage, langFor } from "./lang.ts";

test("wordDiff marks only the changed words", () => {
  const w = wordDiff('  "php": "^8.1",', '  "php": "^8.3",')!;
  assert.deepEqual(w.a.map(([s, e]) => '  "php": "^8.1",'.slice(s, e)), ["1"]); // "8" and "." are shared
  assert.deepEqual(w.b.map(([s, e]) => '  "php": "^8.3",'.slice(s, e)), ["3"]);
});
test("wordDiff: insertion, identical, unrelated", () => {
  const a = "foo(bar)", b = "foo(bar, baz)";
  assert.deepEqual(wordDiff(a, b)!.b.map(([s, e]) => b.slice(s, e)), [", baz"]);
  assert.deepEqual(wordDiff(a, b)!.a, []);
  assert.equal(wordDiff("same", "same"), null);
  assert.equal(wordDiff("abc", "xyz"), null, "nothing shared: marking the whole line adds nothing");
  assert.equal(wordDiff("a ".repeat(500), "b ".repeat(500)), null, "very long lines are skipped");
});
test("pairChanges pairs i-th del with i-th add per block", () => {
  const rows = parseDiff("@@ -1,5 +1,5 @@\n a\n-d1\n-d2\n+a1\n+a2\n+a3\n b\n-lone\n c\n");
  const p = pairChanges(rows);
  // rows: 0 hunk, 1 ctx a, 2 del d1, 3 del d2, 4 add a1, 5 add a2, 6 add a3, 7 ctx b, 8 del lone, 9 ctx c
  assert.deepEqual([p.get(2), p.get(3), p.get(4), p.get(5)], [4, 5, 2, 3]);
  assert.equal(p.has(6), false);
  assert.equal(p.has(8), false);
});
test("splitRows aligns deletions with additions and pads the shorter side", () => {
  const rows = parseDiff("@@ -1,4 +1,4 @@\n a\n-d1\n-d2\n+a1\n b\n+only-add\n");
  const s = splitRows(rows);
  assert.deepEqual(s, [
    { hunk: 0 }, { left: 1, right: 1 },
    { left: 2, right: 4 }, { left: 3, right: null },
    { left: 5, right: 5 }, { left: null, right: 6 },
  ]);
});
test("markHtml wraps text ranges across tags and entities without breaking nesting", () => {
  const html = 'a <span class="k">if</span> (x &lt; y)';
  assert.equal(markHtml(html, [[2, 4]]), 'a <span class="k"><mark class="wd">if</mark></span> (x &lt; y)');
  assert.equal(markHtml(html, [[8, 9]]), 'a <span class="k">if</span> (x <mark class="wd">&lt;</mark> y)'); // entity = 1 char
  // a range spanning a tag boundary is closed and reopened, never interleaved
  assert.equal(markHtml('<b>ab</b>cd', [[1, 3]]), '<b>a<mark class="wd">b</mark></b><mark class="wd">c</mark>d');
  assert.equal(markHtml("plain", []), "plain");
});
test("langFor and isImage", () => {
  assert.equal(langFor("web/modules/custom/x/x.module"), "php");
  assert.equal(langFor("templates/page.html.twig"), "twig");
  assert.equal(langFor("composer.lock"), "json");
  assert.equal(langFor("Dockerfile"), "dockerfile");
  assert.equal(langFor("a/b/.htaccess"), "apache");
  assert.equal(langFor("README"), null);
  assert.equal(langFor("archive.tar.gz"), null);
  assert.ok(isImage("assets/Logo.PNG") && !isImage("logo.png.txt"));
});

test("hunkRange gives the new-side line span", () => {
  assert.deepEqual(hunkRange("@@ -12,7 +14,9 @@ fn x"), [14, 22]);
  assert.deepEqual(hunkRange("@@ -3 +3 @@"), [3, 3]);
  assert.deepEqual(hunkRange("@@ -5,2 +4,0 @@"), [4, 4]); // pure deletion: the line it sat next to
  assert.deepEqual(hunkRange("@@ -0,0 +1,24 @@"), [1, 24]);
  assert.equal(hunkRange("not a hunk"), null);
});

test("fullRows fills every gap from the files, keeping hunks and numbering aligned", async () => {
  const { fullRows, fileLines, hunkSpan } = await import("./diff.ts");
  const oldText = "1\n2\n3\nold4\n5\n6\n7\n8\n9\nold10\n11\n12\n";
  const newText = "1\n2\n3\nnew4\n5\n6\n7\n8\n9\nnew10\nins\n11\n12\n";
  const p = "@@ -3,3 +3,3 @@\n 3\n-old4\n+new4\n 5\n@@ -9,3 +9,4 @@\n 9\n-old10\n+new10\n+ins\n 11\n";
  const rows = parseDiff(p);
  const { rows: all, src } = fullRows(rows, fileLines(oldText), fileLines(newText));
  // every new line appears once, in order
  assert.deepEqual(all.filter((r) => r.new !== null).map((r) => r.new), Array.from({ length: 13 }, (_, k) => k + 1));
  assert.deepEqual(all.filter((r) => r.old !== null).map((r) => r.old), Array.from({ length: 12 }, (_, k) => k + 1));
  // first band stays on top; the gap before hunk 2 sits above its band
  assert.equal(all[0].kind, "hunk");
  const second = all.findIndex((r, i) => i > 0 && r.kind === "hunk");
  assert.deepEqual([all[second - 1].old, all[second - 1].new, all[second - 1].text], [8, 8, "8"]);
  assert.equal(src.filter((s) => s !== null).length, rows.length);
  assert.deepEqual(all.at(-1), { kind: "ctx", old: 12, new: 13, text: "12" });
  assert.deepEqual(hunkSpan("@@ -5,0 +6,2 @@"), { oldFirst: 6, oldEnd: 6, newFirst: 6, newEnd: 8 });
  // an added file: nothing to fill
  const add = parseDiff("@@ -0,0 +1,2 @@\n+a\n+b\n");
  assert.equal(fullRows(add, null, ["a", "b"]).rows.length, add.length);
});

test("rangePick takes only changes, optionally on one side", async () => {
  const { rangePick } = await import("./diff.ts");
  const rows = parseDiff("@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n-d\n+D\n");
  assert.deepEqual(rangePick(rows, 5, 1, null), [2, 3, 5]);
  assert.deepEqual(rangePick(rows, 1, 6, "add"), [3, 6]);
});

test("binarySummary", async () => {
  const { binarySummary } = await import("./diff.ts");
  assert.equal(binarySummary(5120, 6002), "Binary file: 882 bytes changed (5,120 → 6,002)");
  assert.equal(binarySummary(null, 1), "Binary file: 1 byte changed (added, 1 byte)");
});
