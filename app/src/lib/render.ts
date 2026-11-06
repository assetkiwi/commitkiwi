import { markHtml, pairChanges, wordDiff, type DiffRow, type Range } from "./diff";
import { escapeHtml, highlightLine } from "./highlight";

/**
 * Per-row HTML for a parsed diff: syntax-highlighted, with changed words marked on paired -/+ lines.
 * Results are computed lazily per row (only rows that get rendered) and memoised. `hl`: whole-file
 * highlighted lines (syntax.ts) per side, used by line number when present.
 */
export function makeRenderer(
  rows: DiffRow[], lang: string | null, opts: { syntax: boolean; words: boolean },
  hl: { old: string[] | null; new: string[] | null } | null = null,
) {
  const partner = opts.words ? pairChanges(rows) : new Map<number, number>();
  const memo = new Map<number, string>();
  const pairRanges = new Map<number, { a: Range[]; b: Range[] } | null>();

  return (i: number): string => {
    const hit = memo.get(i);
    if (hit !== undefined) return hit;
    const r = rows[i];
    const whole = !opts.syntax || !hl ? undefined : r.kind === "del" ? hl.old?.[r.old! - 1] : r.new !== null ? hl.new?.[r.new - 1] : undefined;
    let html = whole ?? (opts.syntax ? highlightLine(r.text, lang) : escapeHtml(r.text));
    const other = partner.get(i);
    if (other !== undefined) {
      const del = r.kind === "del" ? i : other, add = r.kind === "del" ? other : i;
      if (!pairRanges.has(del)) pairRanges.set(del, wordDiff(rows[del].text, rows[add].text));
      const w = pairRanges.get(del);
      if (w) html = markHtml(html, r.kind === "del" ? w.a : w.b);
    }
    memo.set(i, html);
    return html;
  };
}
