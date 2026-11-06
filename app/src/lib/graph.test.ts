import { test } from "node:test";
import assert from "node:assert/strict";
import { IN, OUT, PASS, layoutGraph, rowMaxLane } from "./graph.ts";

const rowEdges = (g: ReturnType<typeof layoutGraph>, i: number) => {
  const out: number[][] = [];
  for (let e = g.start[i]; e < g.start[i + 1]; e++) out.push(Array.from(g.edges.slice(e * 4, e * 4 + 4)));
  return out;
};

test("linear history stays on lane 0", () => {
  const g = layoutGraph([[1], [2], []]);
  assert.deepEqual(Array.from(g.nodeLane), [0, 0, 0]);
  assert.equal(g.maxLane, 0);
  assert.deepEqual(rowEdges(g, 0).map((e) => e[2]), [OUT]);
  assert.deepEqual(rowEdges(g, 1).map((e) => e[2]), [IN, OUT]);
  assert.deepEqual(rowEdges(g, 2).map((e) => e[2]), [IN]);
});

test("merge opens a lane that joins back at the fork point", () => {
  // 0 = merge(1,2); 1 and 2 both have parent 3
  const g = layoutGraph([[1, 2], [3], [3], []]);
  assert.deepEqual(Array.from(g.nodeLane), [0, 0, 1, 0]);
  assert.equal(g.maxLane, 1);
  // row 0 splits into lane 0 and a new lane 1
  assert.deepEqual(rowEdges(g, 0).map((e) => [e[0], e[1], e[2]]), [[0, 0, OUT], [0, 1, OUT]]);
  // row 1: lane 1 passes by, lane 0 ends here and continues to 3
  assert.deepEqual(rowEdges(g, 1).map((e) => [e[0], e[1], e[2]]), [[0, 0, IN], [1, 1, PASS], [0, 0, OUT]]);
  // row 2 (on lane 1) merges into lane 0, which already waits for row 3
  assert.deepEqual(rowEdges(g, 2).map((e) => [e[0], e[1], e[2]]), [[0, 0, PASS], [1, 1, IN], [1, 0, OUT]]);
  assert.deepEqual(rowEdges(g, 3).map((e) => [e[0], e[1], e[2]]), [[0, 0, IN]]);
});

test("independent branch tips get their own lanes and colors", () => {
  const g = layoutGraph([[2], [2], []]); // two tips sharing a base
  assert.deepEqual(Array.from(g.nodeLane), [0, 1, 0]);
  assert.notEqual(g.nodeColor[0], g.nodeColor[1]);
});

test("every row's edges only touch lanes up to maxLane; 100k rows are fast", () => {
  const n = 100_000;
  const parents: number[][] = Array.from({ length: n }, (_, i) =>
    i === n - 1 ? [] : i % 50 === 0 && i + 7 < n ? [i + 1, i + 7] : [i + 1]);
  const t = performance.now();
  const g = layoutGraph(parents);
  assert.ok(performance.now() - t < 2000, "layout too slow");
  assert.ok(g.maxLane < 60, `lanes stay bounded (${g.maxLane})`);
  for (let k = 0; k < g.edges.length; k += 4) assert.ok(g.edges[k] <= g.maxLane && g.edges[k + 1] <= g.maxLane);
});

test("row width follows the lanes that row draws", () => {
  const g = layoutGraph([[1, 2], [3], [3], []]);
  assert.deepEqual([0, 1, 2, 3].map((i) => rowMaxLane(g, i)), [1, 1, 1, 0]);
  const lin = layoutGraph([[1], []]);
  assert.equal(rowMaxLane(lin, 0), 0);
});
