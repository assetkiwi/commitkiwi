// Collapsing merge commits in the commit list (Left/Right). Pure and import-free (node-tested).

/**
 * Rows still listed when the merges in `collapsed` hide what they merged in: everything reachable from a ref
 * tip (or a childless row) through first parents, and through other parents of merges that are not collapsed.
 * Ascending row indices, or null when nothing is hidden. Relies on topo order (parents after children).
 */
export function visibleRows(parents: number[][], tips: number[], collapsed: Set<number>): Int32Array | null {
  if (!collapsed.size) return null;
  const n = parents.length;
  const reach = new Uint8Array(n);
  const hasChild = new Uint8Array(n);
  for (const ps of parents) for (const p of ps) hasChild[p] = 1;
  for (const t of tips) if (t < n) reach[t] = 1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!hasChild[i]) reach[i] = 1;
    if (!reach[i]) continue;
    out.push(i);
    const ps = parents[i];
    const last = collapsed.has(i) ? Math.min(1, ps.length) : ps.length;
    for (let k = 0; k < last; k++) reach[ps[k]] = 1;
  }
  return out.length === n ? null : Int32Array.from(out);
}

/** Parents restated as positions in `rows` (hidden parents dropped), for the graph layout. */
export function remapParents(parents: number[][], rows: Int32Array): number[][] {
  const pos = new Map<number, number>();
  rows.forEach((r, k) => pos.set(r, k));
  return Array.from(rows, (r) => parents[r].flatMap((p) => (pos.has(p) ? [pos.get(p)!] : [])));
}

/** Position of row `real` in the ascending `rows`, or -1 when it is hidden. */
export function positionOf(rows: Int32Array, real: number): number {
  let lo = 0, hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid] === real) return mid;
    if (rows[mid] < real) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}
