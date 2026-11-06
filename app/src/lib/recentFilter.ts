// The New Tab page's recent-repositories filter. Pure and import-free (the fuzzy matcher is passed in).
export interface RecentLike { location: string; path: string }

/** Entries matching `query` on name, alias or path, best first; the best of the three scores counts. Empty query: all, unchanged. */
export function filterRecent<R extends RecentLike>(
  list: R[], query: string, alias: (r: R) => string,
  fuzzy: (q: string, text: string) => { score: number } | null,
): R[] {
  const q = query.trim();
  if (!q) return list;
  const hits: { r: R; score: number }[] = [];
  for (const r of list) {
    const name = r.path.replace(/\/+$/, "").split("/").pop() ?? "";
    // name and alias outrank the path, as the palette ranks label over detail
    const s = [fuzzy(q, name)?.score, fuzzy(q, alias(r))?.score].filter((x) => x !== undefined).map((x) => x! + 10);
    const p = fuzzy(q, r.path)?.score;
    if (p !== undefined) s.push(p);
    if (s.length) hits.push({ r, score: Math.max(...s) });
  }
  return hits.sort((a, b) => b.score - a.score).map((h) => h.r);
}
