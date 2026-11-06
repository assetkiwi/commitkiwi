// Parse one file's `git diff` output into display rows.
export type DiffKind = "hunk" | "ctx" | "add" | "del" | "meta";
export interface DiffRow { kind: DiffKind; old: number | null; new: number | null; text: string }

export function parseDiff(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let o = 0, n = 0, inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) { o = +m[1]; n = +m[2]; inHunk = true; }
      rows.push({ kind: "hunk", old: null, new: null, text: line });
    } else if (!inHunk) {
      continue; // `diff --git`, `index`, `---`, `+++` headers
    } else if (line.startsWith("+")) rows.push({ kind: "add", old: null, new: n++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", old: o++, new: null, text: line.slice(1) });
    else if (line.startsWith("\\")) rows.push({ kind: "meta", old: null, new: null, text: line.slice(2) });
    else if (line.startsWith(" ")) rows.push({ kind: "ctx", old: o++, new: n++, text: line.slice(1) });
  }
  return rows;
}

export const isBinaryPatch = (patch: string): boolean => /^Binary files .* differ$/m.test(patch);

// ---- partial staging: build a patch containing only the picked lines ------------------------------------

/** stage: apply forward to the index; unstage: apply in reverse to the index; discard: apply in reverse to the worktree. */
export type PatchMode = "stage" | "unstage" | "discard";

/** Everything before the first hunk (`diff --git`, mode lines, `---`/`+++`). */
export function diffHeader(patch: string): string {
  const at = patch.search(/^@@/m);
  return at < 0 ? patch : patch.slice(0, at);
}

/**
 * Patch with only `picked` change rows (indexes into `parseDiff(patch)`), or null when nothing is picked.
 * Unpicked changes must be neutral for the target file: when applying forward, an unpicked `+` is not in
 * the target (dropped) and an unpicked `-` still is (kept as context); in reverse it is the other way round.
 */
export function buildPatch(patch: string, rows: DiffRow[], picked: ReadonlySet<number>, mode: PatchMode): string | null {
  const reverse = mode !== "stage";
  const out: string[] = [];
  let delta = 0; // lines added so far by earlier hunks of this patch
  let totalOld = 0, totalNew = 0;
  for (let i = 0; i < rows.length; ) {
    if (rows[i].kind !== "hunk") { i++; continue; }
    let end = i + 1;
    while (end < rows.length && rows[end].kind !== "hunk") end++;
    const lines: string[] = [];
    let oldN = 0, newN = 0, changed = false, lastKept = false;
    for (let k = i + 1; k < end; k++) {
      const r = rows[k];
      if (r.kind === "ctx") { lines.push(" " + r.text); oldN++; newN++; lastKept = true; }
      else if (r.kind === "add" || r.kind === "del") {
        const add = r.kind === "add";
        if (picked.has(k)) {
          lines.push((add ? "+" : "-") + r.text); add ? newN++ : oldN++; changed = true; lastKept = true;
        } else if (add === reverse) { // unpicked, but present in the target file: context
          lines.push(" " + r.text); oldN++; newN++; lastKept = true;
        } else lastKept = false;
      } else if (r.kind === "meta" && lastKept) lines.push("\\ " + r.text);
    }
    if (changed) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rows[i].text);
      const [os, ns] = m ? [+m[1], +m[2]] : [1, 1];
      let [a, b] = reverse ? [ns - delta, ns] : [os, os + delta];
      if (oldN === 0) a = 0; // creating a file: git wants -0,0
      if (newN === 0) b = 0;
      out.push(`@@ -${a},${oldN} +${b},${newN} @@`, ...lines);
      delta += newN - oldN;
      totalOld += oldN;
      totalNew += newN;
    }
    i = end;
  }
  return out.length ? partialHeader(diffHeader(patch), totalOld, totalNew) + out.join("\n") + "\n" : null;
}

/**
 * A patch that creates (or deletes) a file only makes sense if it touches every line. When some lines were
 * left out the result is an edit of an existing file, so the header must stop claiming otherwise.
 */
function partialHeader(header: string, totalOld: number, totalNew: number): string {
  let h = header;
  if (/^new file mode /m.test(h) && totalOld > 0) {
    const path = /^\+\+\+ b\/(.*)$/m.exec(h)?.[1];
    if (path !== undefined) h = h.replace(/^new file mode .*\n/m, "").replace(/^index .*\n/m, "").replace(/^--- \/dev\/null$/m, `--- a/${path}`);
  }
  if (/^deleted file mode /m.test(h) && totalNew > 0) {
    const path = /^--- a\/(.*)$/m.exec(h)?.[1];
    if (path !== undefined) h = h.replace(/^deleted file mode .*\n/m, "").replace(/^index .*\n/m, "").replace(/^\+\+\+ \/dev\/null$/m, `+++ b/${path}`);
  }
  return h;
}

// ---- word-level changes, split view, and marking changed words inside highlighted HTML ------------------

export type Range = [number, number];
const TOKEN = /\w+|\s+|[^\w\s]/gu;
const MAX_TOKENS = 400; // LCS is quadratic; longer lines just get no word marks

/** Character ranges that differ between two lines (null when identical, or nothing is shared: whole line changed). */
export function wordDiff(a: string, b: string): { a: Range[]; b: Range[] } | null {
  const ta = a.match(TOKEN) ?? [], tb = b.match(TOKEN) ?? [];
  if (ta.length > MAX_TOKENS || tb.length > MAX_TOKENS) return null;
  const n = ta.length, m = tb.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  if (dp[0][0] === 0 || (dp[0][0] === n && n === m)) return null;
  const chA = new Array<boolean>(n).fill(false), chB = new Array<boolean>(m).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) chA[i++] = true;
    else chB[j++] = true;
  }
  while (i < n) chA[i++] = true;
  while (j < m) chB[j++] = true;
  const ranges = (toks: string[], changed: boolean[]): Range[] => {
    const out: Range[] = [];
    let pos = 0;
    toks.forEach((t, k) => {
      if (changed[k]) {
        const last = out[out.length - 1];
        if (last && last[1] === pos) last[1] = pos + t.length; else out.push([pos, pos + t.length]);
      }
      pos += t.length;
    });
    return out;
  };
  return { a: ranges(ta, chA), b: ranges(tb, chB) };
}

/** Pairs the i-th `del` with the i-th `add` of each change block (row index <-> row index, both directions). */
export function pairChanges(rows: DiffRow[]): Map<number, number> {
  const partner = new Map<number, number>();
  for (let i = 0; i < rows.length; ) {
    if (rows[i].kind !== "del") { i++; continue; }
    let d = i;
    while (d < rows.length && rows[d].kind === "del") d++;
    let a = d;
    while (a < rows.length && rows[a].kind === "add") a++;
    for (let k = 0; k < Math.min(d - i, a - d); k++) { partner.set(i + k, d + k); partner.set(d + k, i + k); }
    i = a;
  }
  return partner;
}

/** Two-column layout: indexes into `rows` for each side (null = blank). A hunk header spans both. */
export type SplitRow = { hunk: number } | { left: number | null; right: number | null };
export function splitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  for (let i = 0; i < rows.length; ) {
    const r = rows[i];
    if (r.kind === "hunk") { out.push({ hunk: i }); i++; }
    else if (r.kind === "ctx" || r.kind === "meta") { out.push({ left: i, right: i }); i++; }
    else {
      let d = i;
      while (d < rows.length && rows[d].kind === "del") d++;
      let a = d;
      while (a < rows.length && rows[a].kind === "add") a++;
      const dels = d - i, adds = a - d;
      for (let k = 0; k < Math.max(dels, adds); k++) out.push({ left: k < dels ? i + k : null, right: k < adds ? d + k : null });
      i = a;
    }
  }
  return out;
}

/** Wrap character ranges of the *text* in `<mark>`, skipping over tags and counting an entity as one character. */
export function markHtml(html: string, ranges: Range[]): string {
  if (!ranges.length) return html;
  let out = "", pos = 0, ri = 0, open = false;
  const want = (p: number) => {
    while (ri < ranges.length && ranges[ri][1] <= p) ri++;
    return ri < ranges.length && ranges[ri][0] <= p && p < ranges[ri][1];
  };
  const close = () => { if (open) { out += "</mark>"; open = false; } };
  for (let i = 0; i < html.length; ) {
    if (html[i] === "<") { // a tag: never inside a mark, so nesting stays valid
      const end = html.indexOf(">", i);
      close();
      out += html.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    let len = 1;
    if (html[i] === "&") { const semi = html.indexOf(";", i); if (semi > 0 && semi - i <= 8) len = semi - i + 1; }
    if (want(pos)) { if (!open) { out += '<mark class="wd">'; open = true; } } else close();
    out += html.slice(i, i + len);
    i += len;
    pos++;
  }
  close();
  return out;
}

/** `@@ -a,b +c,d @@` -> new-side line range (1-based, inclusive) for `git log -L`. */
export function hunkRange(header: string): [number, number] | null {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!m) return null;
  const start = Math.max(1, +m[1]);
  const count = m[2] === undefined ? 1 : +m[2];
  return [start, start + Math.max(count, 1) - 1];
}

// ---- context: the unchanged lines between hunks (shown with "Show entire file") --------------------------

/** A file's lines (no trailing empty line for the final newline). */
export function fileLines(text: string): string[] {
  const l = text.split("\n");
  if (l[l.length - 1] === "") l.pop();
  return l;
}

/** First line and end (exclusive) of a hunk on each side; a zero count means "after line start". */
export function hunkSpan(header: string): { oldFirst: number; oldEnd: number; newFirst: number; newEnd: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!m) return null;
  const side = (start: number, count: number) => (count === 0 ? [start + 1, start + 1] : [start, start + count]);
  const [oldFirst, oldEnd] = side(+m[1], m[2] === undefined ? 1 : +m[2]);
  const [newFirst, newEnd] = side(+m[3], m[4] === undefined ? 1 : +m[4]);
  return { oldFirst, oldEnd, newFirst, newEnd };
}

/**
 * The rows plus every unchanged line git left out, taken from the new file (`old` when there is no new
 * side). Hunk rows stay as the bands. Lines before the first hunk go under the first band (so it stays
 * right under the file header); other gaps go above the band of the next hunk. `src[i]` is the index in
 * `rows` of row i, or null for an added context line.
 */
export function fullRows(rows: DiffRow[], oldLines: string[] | null, newLines: string[] | null): { rows: DiffRow[]; src: (number | null)[] } {
  const out: DiffRow[] = [], src: (number | null)[] = [];
  const text = (o: number, n: number) => (newLines ? newLines[n - 1] : oldLines?.[o - 1]) ?? "";
  const gap = (o: number, n: number, oEnd: number) => {
    for (; o < oEnd; o++, n++) { out.push({ kind: "ctx", old: o, new: n, text: text(o, n) }); src.push(null); }
  };
  let o = 1, n = 1, first = true;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const s = r.kind === "hunk" ? hunkSpan(r.text) : null;
    if (s && !first) gap(o, n, s.oldFirst);
    out.push(r); src.push(i);
    if (s && first) gap(o, n, s.oldFirst);
    if (s) { first = false; o = s.oldEnd; n = s.newEnd; }
  }
  if (!first) {
    const total = oldLines ? oldLines.length : newLines ? newLines.length - (n - o) : 0;
    gap(o, n, total + 1);
  }
  return { rows: out, src };
}

/** Rows between `a` and `b` (inclusive, either order) that a gutter range selection picks: changes only;
 *  `side` limits it to one column of the split view. */
export function rangePick(rows: DiffRow[], a: number, b: number, side: "del" | "add" | null): number[] {
  const out: number[] = [];
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
    const k = rows[i]?.kind;
    if ((k === "add" || k === "del") && (!side || k === side)) out.push(i);
  }
  return out;
}

/** "Binary file: 882 bytes changed (5,120 → 6,002)"; sizes null when that side does not exist. */
export function binarySummary(before: number | null, after: number | null): string {
  const f = (n: number) => n.toLocaleString("en-US");
  const bytes = (n: number) => `${f(n)} byte${n === 1 ? "" : "s"}`;
  const delta = Math.abs((after ?? 0) - (before ?? 0));
  const sizes = before === null ? `added, ${bytes(after ?? 0)}` : after === null ? `deleted, ${bytes(before)}` : `${f(before)} → ${f(after)}`;
  return `Binary file: ${bytes(delta)} changed (${sizes})`;
}
