// The merge tool's three-way merge: a line diff (Myers), diff3 chunks (base / ours / theirs), the starting Merged
// text, and line mapping between the columns (scroll sync, connector lines). Import-free (node-tested).

/** `same`: untouched; `ours`/`theirs`: only that side changed (taken automatically); `both`: the same change on
 *  both sides; `conflict`: different changes, the user picks. Lines keep their `\n` (the last may lack it). */
export type ChunkKind = "same" | "ours" | "theirs" | "both" | "conflict";
export interface Chunk { kind: ChunkKind; base: string[]; ours: string[]; theirs: string[] }
export type Side = "base" | "ours" | "theirs";

/** Lines with their terminator, so joining them gives the text back exactly. */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", start)) { out.push(text.slice(start, i + 1)); start = i + 1; }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** Differences up to this many edits are diffed exactly; past it the rest is one change (keeps memory bounded). */
const MAX_EDITS = 2000;

/** For each line of `a`, the index of its matching line in `b`, or -1 (a longest common subsequence, Myers). */
export function matchLines(a: string[], b: string[]): Int32Array {
  const ids = new Map<string, number>();
  const id = (l: string) => { let v = ids.get(l); if (v === undefined) ids.set(l, (v = ids.size)); return v; };
  const A = Int32Array.from(a, id), B = Int32Array.from(b, id);
  const out = new Int32Array(a.length).fill(-1);
  let lo = 0, hiA = A.length, hiB = B.length;
  while (lo < hiA && lo < hiB && A[lo] === B[lo]) { out[lo] = lo; lo++; }
  while (hiA > lo && hiB > lo && A[hiA - 1] === B[hiB - 1]) { hiA--; hiB--; out[hiA] = hiB; }
  const n = hiA - lo, m = hiB - lo;
  if (!n || !m) return out;
  // greedy forward search; trace[d] = V after step d for k in [-d-1, d+1]
  const max = n + m, off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, MAX_EDITS) && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[lo + x] === B[lo + y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    trace.push(v.slice(off - d - 1, off + d + 2));
  }
  if (found < 0) return out; // too different: the middle stays unmatched
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k: number) => prev[k + d];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk), py = px - pk;
    const sx = down ? px : px + 1;
    while (x > sx && y > sx - k) { x--; y--; out[lo + x] = lo + y; }
    x = px; y = py;
  }
  while (x > 0 && y > 0) { x--; y--; out[lo + x] = lo + y; }
  return out;
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((l, i) => l === y[i]);

/** diff3: walk base with both matchings; lines matched on both sides in step are stable, the rest is a chunk. */
export function diff3(base: string[], ours: string[], theirs: string[]): Chunk[] {
  const mo = matchLines(base, ours), mt = matchLines(base, theirs);
  const out: Chunk[] = [];
  const push = (b: string[], o: string[], t: string[]) => {
    const kind: ChunkKind = same(b, o) && same(b, t) ? "same" : same(b, o) ? "theirs" : same(b, t) ? "ours" : same(o, t) ? "both" : "conflict";
    const last = out.at(-1);
    if (kind === "same" && last?.kind === "same") { last.base.push(...b); last.ours.push(...o); last.theirs.push(...t); return; }
    out.push({ kind, base: b, ours: o, theirs: t });
  };
  let i = 0, a = 0, t = 0;
  while (i < base.length || a < ours.length || t < theirs.length) {
    let k = 0;
    while (i + k < base.length && mo[i + k] === a + k && mt[i + k] === t + k) k++;
    if (k) { push(base.slice(i, i + k), ours.slice(a, a + k), theirs.slice(t, t + k)); i += k; a += k; t += k; continue; }
    let j = i;
    while (j < base.length && (mo[j] < 0 || mt[j] < 0)) j++;
    const [ea, et] = j < base.length ? [mo[j], mt[j]] : [ours.length, theirs.length];
    push(base.slice(i, j), ours.slice(a, ea), theirs.slice(t, et));
    [i, a, t] = [j, ea, et];
  }
  return out;
}

/** What Merged starts with for a chunk: the change for one-sided ones, null for a conflict (the user decides). */
export function autoLines(c: Chunk): string[] | null {
  return c.kind === "conflict" ? null : c.kind === "theirs" ? c.theirs : c.kind === "same" ? c.base : c.ours;
}

/** An unresolved conflict's placeholder in Merged: one empty line (marked CONFLICT). */
export const PLACEHOLDER = "\n";

/** The starting Merged text and each chunk's start offset (`bounds[c]..bounds[c + 1]`). */
export function buildMerged(chunks: Chunk[]): { text: string; bounds: number[] } {
  let text = "";
  const bounds = [0];
  for (const c of chunks) { text += autoLines(c)?.join("") ?? PLACEHOLDER; bounds.push(text.length); }
  return { text, bounds };
}

/** What Take Ours / Take Theirs / Take Both puts in Merged for a chunk. */
export function takeLines(c: Chunk, take: "ours" | "theirs" | "both"): string {
  const end = (ls: string[]) => { const s = ls.join(""); return s && !s.endsWith("\n") ? s + "\n" : s; };
  return take === "ours" ? c.ours.join("") : take === "theirs" ? c.theirs.join("") : end(c.ours) + c.theirs.join("");
}

/** The file to save: every still-unresolved conflict (`open`: chunk indexes) written back as git conflict markers. */
export function withMarkers(text: string, chunks: Chunk[], bounds: number[], open: number[]): string {
  const end = (ls: string[]) => { const s = ls.join(""); return s && !s.endsWith("\n") ? s + "\n" : s; };
  let out = text;
  for (const c of [...open].sort((x, y) => y - x)) {
    const ch = chunks[c];
    out = out.slice(0, bounds[c]) + `<<<<<<< ours\n${end(ch.ours)}=======\n${end(ch.theirs)}>>>>>>> theirs\n` + out.slice(bounds[c + 1]);
  }
  return out;
}

/** Each chunk's line range [start, end) in one column (they tile the column). */
export function segments(chunks: Chunk[], side: Side): [number, number][] {
  let at = 0;
  return chunks.map((c) => { const s: [number, number] = [at, (at += c[side].length)]; return s; });
}

/** A (fractional) line of one column at the matching place in another: same chunk, same proportion. */
export function mapLine(src: [number, number][], dst: [number, number][], line: number): number {
  if (!src.length) return line;
  let c = src.findIndex(([s, e]) => line < e && line >= s);
  if (c < 0) c = line < src[0][0] ? 0 : src.length - 1;
  const [s, e] = src[c], [ds, de] = dst[c];
  if (e === s) return ds;
  return ds + Math.min(1, Math.max(0, (line - s) / (e - s))) * (de - ds);
}
