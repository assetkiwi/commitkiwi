import { test } from "node:test";
import assert from "node:assert/strict";
import { autoLines, buildMerged, chunkText, diff3, initialSides, mapLine, matchLines, resolveSimple, segments, splitLines, takeLines, withMarkers } from "./merge3.ts";

const L = (s: string) => splitLines(s);

test("splitLines keeps terminators and a last line without one", () => {
  assert.deepEqual(splitLines("a\nb\n"), ["a\n", "b\n"]);
  assert.deepEqual(splitLines("a\nb"), ["a\n", "b"]);
  assert.deepEqual(splitLines(""), []);
  assert.equal(splitLines("x\n\ny").join(""), "x\n\ny");
});

test("matchLines finds a longest common subsequence", () => {
  const a = L("a\nb\nc\nd\ne\n"), b = L("a\nx\nc\ny\ne\nf\n");
  assert.deepEqual([...matchLines(a, b)], [0, -1, 2, -1, 4]);
  assert.deepEqual([...matchLines([], L("a\n"))], []);
  assert.deepEqual([...matchLines(L("a\n"), [])], [-1]);
  // matches are increasing and point at equal lines, on random inputs
  for (let seed = 1; seed < 40; seed++) {
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) % 5);
    const x = Array.from({ length: 30 }, () => `${rnd()}\n`), y = Array.from({ length: 25 }, () => `${rnd()}\n`);
    const m = matchLines(x, y);
    let last = -1, n = 0;
    m.forEach((j, i) => { if (j >= 0) { assert.ok(j > last); assert.equal(x[i], y[j]); last = j; n++; } });
    // LCS length by DP
    const dp = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    assert.equal(n, dp[0][0], `seed ${seed}`);
  }
});

test("diff3 sorts changes into one-sided, identical and conflicting chunks", () => {
  const base = L("1\n2\n3\n4\n5\n6\n7\n");
  const ours = L("1\nO2\n3\n4\nX5\n6\n7\n");
  const theirs = L("1\n2\n3\nT4\nX5\n6\nT7\n");
  const kinds = diff3(base, ours, theirs).map((c) => [c.kind, c.base.join(""), c.ours.join(""), c.theirs.join("")]);
  assert.deepEqual(kinds, [
    ["same", "1\n", "1\n", "1\n"],
    ["ours", "2\n", "O2\n", "2\n"],
    ["same", "3\n", "3\n", "3\n"],
    ["conflict", "4\n5\n", "4\nX5\n", "T4\nX5\n"],
    ["same", "6\n", "6\n", "6\n"],
    ["theirs", "7\n", "7\n", "T7\n"],
  ]);
  const both = diff3(L("a\nb\n"), L("a\nc\n"), L("a\nc\n"));
  assert.deepEqual(both.map((c) => c.kind), ["same", "both"]);
  // add/add (no base): the whole file is one conflict
  assert.deepEqual(diff3([], L("x\n"), L("y\n")).map((c) => c.kind), ["conflict"]);
  // each column's lines come back in order
  const cs = diff3(base, ours, theirs);
  for (const side of ["base", "ours", "theirs"] as const) assert.equal(cs.flatMap((c) => c[side]).join(""), { base, ours, theirs }[side].join(""));
});

test("Merged starts with the automatic changes and a placeholder per conflict", () => {
  const cs = diff3(L("a\nb\nc\n"), L("a\nB\nc\n"), L("a\nb2\nc\n"));
  const { text, bounds } = buildMerged(cs);
  assert.equal(text, "a\n\nc\n");
  assert.deepEqual(bounds, [0, 2, 3, 5]);
  assert.equal(autoLines(cs[1]), null);
  assert.equal(takeLines(cs[1], "ours"), "B\n");
  assert.equal(takeLines(cs[1], "both"), "B\nb2\n");
  assert.equal(takeLines({ kind: "conflict", base: [], ours: ["x"], theirs: ["y"] }, "both"), "x\ny");
  // unresolved conflicts are saved as git markers
  assert.equal(withMarkers(text, cs, bounds, [1]), "a\n<<<<<<< ours\nB\n=======\nb2\n>>>>>>> theirs\nc\n");
});

test("mapLine follows chunks between columns", () => {
  const cs = diff3(L("1\n2\n3\n"), L("1\nA\nB\nC\n3\n"), L("1\n2\n3\n"));
  const o = segments(cs, "ours"), t = segments(cs, "theirs");
  assert.deepEqual(o, [[0, 1], [1, 4], [4, 5]]);
  assert.equal(mapLine(o, t, 0), 0);
  assert.equal(mapLine(o, t, 4), 2);
  assert.equal(mapLine(o, t, 2.5), 1.5);
  assert.equal(mapLine(t, o, 1.5), 2.5);
  assert.equal(mapLine(o, t, 99), 3);
});

test("hunk sides: one-sided changes start applied, conflicts pending; Merged follows the sides", () => {
  const [, ours, , conflict, , theirs] = diff3(L("1\n2\n3\n4\n5\n6\n7\n"), L("1\nO2\n3\n4\nX5\n6\n7\n"), L("1\n2\n3\nT4\nX5\n6\nT7\n"));
  assert.deepEqual(initialSides(ours), { ours: "applied", theirs: "none" });
  assert.deepEqual(initialSides(theirs), { ours: "none", theirs: "applied" });
  assert.deepEqual(initialSides(conflict), { ours: "pending", theirs: "pending" });
  assert.deepEqual(initialSides(diff3(L("a\n"), L("b\n"), L("b\n"))[0]), { ours: "applied", theirs: "applied" });
  // the starting text matches buildMerged
  for (const c of [ours, conflict, theirs]) assert.equal(chunkText(c, initialSides(c)), autoLines(c)?.join("") ?? "\n");
  assert.equal(chunkText(ours, { ours: "ignored", theirs: "none" }), "2\n", "× on an auto-applied change: back to base");
  assert.equal(chunkText(conflict, { ours: "applied", theirs: "pending" }), "4\nX5\n");
  assert.equal(chunkText(conflict, { ours: "applied", theirs: "applied" }), "4\nX5\nT4\nX5\n");
  assert.equal(chunkText(conflict, { ours: "ignored", theirs: "pending" }), "\n", "still undecided");
  assert.equal(chunkText(conflict, { ours: "ignored", theirs: "ignored" }), "4\n5\n");
  assert.equal(chunkText(conflict, { ours: "ignored", theirs: "applied" }), "T4\nX5\n");
});

test("resolveSimple merges changes to different words of the same lines, not overlapping ones", () => {
  const c = diff3(L("const a = 1, b = 2;\n"), L("const a = 10, b = 2;\n"), L("const a = 1, b = 20;\n"))[0];
  assert.equal(c.kind, "conflict");
  assert.equal(resolveSimple(c), "const a = 10, b = 20;\n");
  // adjacent lines changed by each side
  const d = diff3(L("x\na\nb\ny\n"), L("x\nA\nb\ny\n"), L("x\na\nB\ny\n")).find((k) => k.kind === "conflict")!;
  assert.equal(resolveSimple(d), "A\nB\n");
  // the same word changed differently: a real conflict
  assert.equal(resolveSimple(diff3(L("v = 1;\n"), L("v = 2;\n"), L("v = 3;\n"))[0]), null);
  assert.equal(resolveSimple(diff3(L("\"version\": \"1.0\",\n"), L("\"version\": \"1.1\",\n"), L("\"version\": \"2.0\",\n"))[0]), null, "1.1 vs 2.0 is not 2.1");
  // add/add with different text
  assert.equal(resolveSimple(diff3([], L("x\n"), L("y\n"))[0]), null);
  assert.equal(resolveSimple(diff3(L("a\n"), L("b\n"), L("a\n"))[0]), null, "not a conflict");
});
