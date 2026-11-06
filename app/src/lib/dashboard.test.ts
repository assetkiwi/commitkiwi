import { test } from "node:test";
import assert from "node:assert/strict";
import { isOffline, pool, pullError, pullRefusal, sortRows, stateOf, withTimeout, type OverviewLike } from "./dashboard.ts";

const o = (p: Partial<OverviewLike> = {}): OverviewLike => ({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0, changed: 0, time: 100, ...p });

test("state badge: offline and error win, then diverged, dirty, behind, ahead, clean", () => {
  assert.equal(stateOf(o(), "x", true), "offline");
  assert.equal(stateOf(null, "not a git repository", false), "error");
  assert.equal(stateOf(null, null, false), "loading");
  assert.equal(stateOf(o({ ahead: 1, behind: 2, changed: 3 }), null, false), "diverged");
  assert.equal(stateOf(o({ behind: 2, changed: 3 }), null, false), "dirty");
  assert.equal(stateOf(o({ behind: 2, ahead: 0 }), null, false), "behind");
  assert.equal(stateOf(o({ ahead: 1 }), null, false), "ahead");
  assert.equal(stateOf(o(), null, false), "clean");
});

test("offline: only remote locations, only connection-type errors", () => {
  assert.equal(isOffline("ssh:box", "timed out after 15 s"), true);
  assert.equal(isOffline("ssh:box", "ssh: connect to host box port 22: Operation timed out"), true);
  assert.equal(isOffline("ssh:box", "fatal: not a git repository (or any of the parent directories): .git"), false);
  assert.equal(isOffline("local", "timed out after 15 s"), false);
});

test("pull is fast-forward only: refused without a branch or upstream, or when diverged", () => {
  assert.equal(pullRefusal(o({ behind: 3 })), null);
  assert.equal(pullRefusal(o()), null, "up to date as of the last fetch: the pull may still bring something");
  assert.match(pullRefusal(o({ branch: null }))!, /detached/);
  assert.match(pullRefusal(o({ upstream: null }))!, /main has no upstream/);
  assert.match(pullRefusal(o({ ahead: 1, behind: 1 }))!, /^Not a fast-forward: main and origin\/main have diverged/);
  assert.match(pullRefusal(null)!, /not known/);
  assert.match(pullError("fatal: Not possible to fast-forward, aborting.", o()), /^Not a fast-forward: main and origin\/main/);
  assert.equal(pullError("fatal: could not read from remote", o()), "fatal: could not read from remote");
});

test("sort by name, dirty first, last activity; ties and unknowns by name", () => {
  const rows = [
    { n: "beta", o: o({ changed: 0, time: 300 }) },
    { n: "alpha", o: o({ changed: 2, time: 100 }) },
    { n: "gamma", o: null },
    { n: "delta", o: o({ changed: 2, time: null }) },
  ];
  const s = (by: "name" | "dirty" | "activity") => sortRows(rows, by, (r) => r.n, (r) => r.o).map((r) => r.n);
  assert.deepEqual(s("name"), ["alpha", "beta", "delta", "gamma"]);
  assert.deepEqual(s("dirty"), ["alpha", "delta", "beta", "gamma"]);
  assert.deepEqual(s("activity"), ["beta", "alpha", "delta", "gamma"]);
  assert.deepEqual(rows.map((r) => r.n), ["beta", "alpha", "gamma", "delta"], "the input is left as it was");
});

test("withTimeout rejects a request that does not answer, passes one that does", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 20), (e) => e === "timed out after 0 s");
  assert.equal(await withTimeout(Promise.resolve(7), 1000), 7);
  await assert.rejects(withTimeout(Promise.reject("boom"), 1000), (e) => e === "boom");
});

test("pool: at most `limit` at once, in order, stops starting new ones when stopped", async () => {
  let running = 0, peak = 0;
  const seen: number[] = [];
  await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    seen.push(n); running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    if (n === 2) throw "a failure does not stop the others";
  });
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(peak, 3);
  const started: number[] = [];
  let stop = false;
  await pool([1, 2, 3, 4, 5, 6], 2, async (n) => { started.push(n); if (n === 2) stop = true; await new Promise((r) => setTimeout(r, 5)); }, () => stop);
  assert.deepEqual(started, [1, 2]);
});
