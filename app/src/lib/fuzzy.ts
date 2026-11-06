// Fuzzy subsequence matching for the palette. Pure and import-free.
export interface Match { score: number; positions: number[] }

const isWordStart = (t: string, i: number): boolean =>
  i === 0 || !/[a-z0-9]/i.test(t[i - 1]) || (t[i - 1] === t[i - 1].toLowerCase() && t[i] !== t[i].toLowerCase());

const DP_LIMIT = 200; // longer texts (commit hashes, paths) take the cheap greedy path

/** Best-scoring way to find `query` as a subsequence of `text` (case-insensitive), or null. */
export function fuzzy(query: string, text: string): Match | null {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase(), t = text.toLowerCase();
  const n = q.length, m = t.length;
  if (n > m) return null;

  if (m > DP_LIMIT) { // greedy leftmost: good enough for long hashes and paths
    const positions: number[] = [];
    for (let i = 0, j = 0; i < n; i++) {
      j = t.indexOf(q[i], j);
      if (j < 0) return null;
      positions.push(j++);
    }
    return { score: -positions[0], positions };
  }

  // best[i][j]: best score matching q[0..i] with q[i] placed at t[j]
  const NEG = -1e9;
  const best = Array.from({ length: n }, () => new Float64Array(m).fill(NEG));
  const from = Array.from({ length: n }, () => new Int16Array(m).fill(-1));
  for (let j = 0; j < m; j++) if (t[j] === q[0]) best[0][j] = 1 + (isWordStart(text, j) ? 4 : 0) - j * 0.01;
  for (let i = 1; i < n; i++) {
    for (let j = i; j < m; j++) {
      if (t[j] !== q[i]) continue;
      for (let k = i - 1; k < j; k++) {
        if (best[i - 1][k] === NEG) continue;
        const s = best[i - 1][k] + 1 + (k === j - 1 ? 6 : 0) + (isWordStart(text, j) ? 4 : 0) - (j - k - 1) * 0.05;
        if (s > best[i][j]) { best[i][j] = s; from[i][j] = k; }
      }
    }
  }
  let end = -1, score = NEG;
  for (let j = 0; j < m; j++) if (best[n - 1][j] > score) { score = best[n - 1][j]; end = j; }
  if (end < 0) return null;
  const positions = new Array<number>(n);
  for (let i = n - 1, j = end; i >= 0; i--) { positions[i] = j; j = from[i][j]; }
  return { score, positions };
}

/** Rank `items` by their best match on `label` (preferred) or `detail`; unmatched items drop out. */
export function rank<T>(items: T[], query: string, label: (t: T) => string, detail?: (t: T) => string | undefined)
  : { item: T; labelPositions: number[]; detailPositions: number[] }[] {
  if (!query) return items.map((item) => ({ item, labelPositions: [], detailPositions: [] }));
  const out: { item: T; score: number; labelPositions: number[]; detailPositions: number[] }[] = [];
  for (const item of items) {
    const a = fuzzy(query, label(item));
    if (a) { out.push({ item, score: a.score + 10, labelPositions: a.positions, detailPositions: [] }); continue; }
    const d = detail?.(item);
    const b = d ? fuzzy(query, d) : null;
    if (b) out.push({ item, score: b.score, labelPositions: [], detailPositions: b.positions });
  }
  return out.sort((x, y) => y.score - x.score);
}

/** Split `text` into runs, flagging the characters at `positions`, so the UI can bold them without injecting HTML. */
export function segments(text: string, positions: number[]): { t: string; hit: boolean }[] {
  const hit = new Set(positions);
  const out: { t: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const h = hit.has(i), last = out[out.length - 1];
    if (last && last.hit === h) last.t += text[i]; else out.push({ t: text[i], hit: h });
  }
  return out;
}
