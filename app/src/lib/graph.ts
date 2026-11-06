// Commit graph lanes from parent row indices (topo order: parents always have a larger index).
// Pure and import-free so node can test it. Output is flat typed arrays: ~100k rows cost a few MB.

export const LANE_COLORS = 6;
export const PASS = 0; // lane continues through the row: from == to
export const IN = 1; //   lane from the top ends at this row's node
export const OUT = 2; //  line from this row's node down to a lane

export interface GraphLayout {
  rows: number;
  maxLane: number;
  nodeLane: Int16Array;
  nodeColor: Uint8Array;
  /** row i owns edges [start[i], start[i+1]); each edge is 4 numbers in `edges`: from, to, type, color */
  start: Uint32Array;
  edges: Int16Array;
}

const FREE = -1;

export function layoutGraph(parents: number[][]): GraphLayout {
  const n = parents.length;
  const lanes: number[] = []; // lane -> row it is waiting for, or FREE
  const laneColor: number[] = [];
  let nextColor = 0;
  let maxLane = 0;
  const edges: number[] = [];
  const nodeLane = new Int16Array(n);
  const nodeColor = new Uint8Array(n);
  const start = new Uint32Array(n + 1);

  const push = (a: number, b: number, type: number, color: number) => {
    edges.push(a, b, type, color);
    maxLane = Math.max(maxLane, a, b);
  };
  const alloc = (): number => {
    let k = lanes.indexOf(FREE);
    if (k < 0) { k = lanes.length; lanes.push(FREE); laneColor.push(0); }
    return k;
  };
  const freshColor = () => nextColor++ % LANE_COLORS;

  for (let i = 0; i < n; i++) {
    start[i] = edges.length / 4;
    const waiting: number[] = [];
    for (let l = 0; l < lanes.length; l++) if (lanes[l] === i) waiting.push(l);

    let nl: number, nc: number;
    if (waiting.length) { nl = waiting[0]; nc = laneColor[nl]; }
    else { nl = alloc(); nc = freshColor(); laneColor[nl] = nc; } // a branch tip starts a new lane

    for (let l = 0; l < lanes.length; l++) {
      if (lanes[l] === FREE) continue;
      if (lanes[l] === i) push(l, nl, IN, laneColor[l]);
      else push(l, l, PASS, laneColor[l]);
    }
    for (const l of waiting) lanes[l] = FREE;

    parents[i].forEach((p, idx) => {
      const existing = lanes.indexOf(p); // another child already waits for p: join its lane
      if (existing >= 0) push(nl, existing, OUT, laneColor[existing]);
      else if (idx === 0) { lanes[nl] = p; laneColor[nl] = nc; push(nl, nl, OUT, nc); }
      else { const k = alloc(); const c = freshColor(); lanes[k] = p; laneColor[k] = c; push(nl, k, OUT, c); }
    });

    while (lanes.length && lanes[lanes.length - 1] === FREE) { lanes.pop(); laneColor.pop(); }
    nodeLane[i] = nl;
    nodeColor[i] = nc;
    maxLane = Math.max(maxLane, nl);
  }
  start[n] = edges.length / 4;
  return { rows: n, maxLane, nodeLane, nodeColor, start, edges: Int16Array.from(edges) };
}

/** Widest lane row `i` draws in (its node and every edge through it): the row's text starts after it. */
export function rowMaxLane(g: GraphLayout, i: number): number {
  let m = g.nodeLane[i];
  for (let e = g.start[i]; e < g.start[i + 1]; e++) m = Math.max(m, g.edges[e * 4], g.edges[e * 4 + 1]);
  return m;
}
