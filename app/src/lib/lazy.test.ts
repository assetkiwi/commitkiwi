import { test } from "node:test";
import assert from "node:assert/strict";
import { SKIPPED, anchorShift, estimateHeight, estimateRows, limiter } from "./lazy.ts";

test("estimates", () => {
  assert.equal(estimateRows(10, 4, 3, false), 21);
  assert.equal(estimateRows(10, 4, 3, true), 17);
  assert.equal(estimateRows(null, null, 3, true), 3);
  assert.equal(estimateHeight(10, 600, 20, false), 212);
  assert.equal(estimateHeight(5000, 600, 20, false), 600 * 20 + 48 + 12, "capped at the shown rows plus the button");
  assert.ok(estimateHeight(10, 600, 20, true) > estimateHeight(10, 600, 20, false));
});

test("anchorShift only for bodies wholly above the view", () => {
  assert.equal(anchorShift(-500, 300, 800), 500);
  assert.equal(anchorShift(-500, 500, 200), -300);
  assert.equal(anchorShift(-100, 300, 800), 0, "straddles the top edge, user-sized: grows downwards");
  assert.equal(anchorShift(-100, 300, 800, true), 500, "straddles the top edge while turning from placeholder into the diff");
  assert.equal(anchorShift(0, 300, 800, true), 0, "starts in the view: content below it moves, as when it rendered");
  assert.equal(anchorShift(50, 300, 800), 0);
});

test("limiter caps concurrency and drops unwanted queued tasks", async () => {
  const run = limiter(2);
  let active = 0, peak = 0;
  const started: number[] = [];
  const task = (i: number) => () => { started.push(i); active++; peak = Math.max(peak, active); return new Promise<number>((r) => setTimeout(() => { active--; r(i); }, 5)); };
  let want3 = true;
  const ps = [0, 1, 2, 3, 4].map((i) => run(task(i), i === 3 ? () => want3 : undefined).catch((e) => e));
  want3 = false;
  const out = await Promise.all(ps);
  assert.equal(peak, 2);
  assert.deepEqual(out, [0, 1, 2, SKIPPED, 4]);
  assert.deepEqual(started, [0, 1, 2, 4]);
});

test("limiter frees the slot on failure", async () => {
  const run = limiter(1);
  const a = run(() => Promise.reject(new Error("x"))).catch((e) => e.message);
  const t = run((): Promise<number> => { throw new Error("sync"); }).catch((e) => e.message);
  const b = run(() => Promise.resolve(2));
  assert.deepEqual(await Promise.all([a, t, b]), ["x", "sync", 2]);
});
