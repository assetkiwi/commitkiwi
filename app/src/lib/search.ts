// Search syntax: `keyword:value` tokens (value may be "quoted", with \" escapes) and free text. Pure and import-free.
// The backend gets the parsed `SearchQuery` (crates/protocol), never the raw string.

export type Field = "message" | "author" | "commit" | "file" | "content" | "branch" | "after" | "before";
export interface Keyword { name: string; field: Field; desc: string }

/** Order = suggestion order (file/from/after/before first). An alias is one more line here. */
export const KEYWORDS: Keyword[] = [
  { name: "file", field: "file", desc: "Changes this file or folder (path from the repository root)" },
  { name: "from", field: "author", desc: "Author name or email" },
  { name: "after", field: "after", desc: "Committed after a date: 2024-01-31, \"2 weeks ago\"" },
  { name: "before", field: "before", desc: "Committed before a date" },
  { name: "message", field: "message", desc: "Commit message contains" },
  { name: "author", field: "author", desc: "Author name or email" },
  { name: "commit", field: "commit", desc: "Commit hash or hash prefix" },
  { name: "contents", field: "content", desc: "Adds or removes this text (git log -S)" },
  { name: "content", field: "content", desc: "Adds or removes this text (git log -S)" },
  { name: "path", field: "file", desc: "Changes this file or folder" },
  { name: "branch", field: "branch", desc: "Reachable from this branch, remote branch or tag" },
];
const BY_NAME = new Map(KEYWORDS.map((k) => [k.name, k]));

export interface SearchQuery {
  text: string[]; message: string[]; author: string[]; commit: string[]; file: string[]; content: string[]; branch: string[];
  after: string | null; before: string | null;
}

/** Read a value at `i`: "quoted" (to the closing quote, `\x` escapes) or up to the next whitespace. */
function readValue(s: string, i: number): [string, number] {
  if (s[i] !== '"') { let j = i; while (j < s.length && !/\s/.test(s[j])) j++; return [s.slice(i, j), j]; }
  let v = "", j = i + 1;
  for (; j < s.length && s[j] !== '"'; j++) v += s[j] === "\\" && j + 1 < s.length ? s[++j] : s[j];
  return [v, j + 1];
}

export function parseSearch(input: string): SearchQuery {
  const q: SearchQuery = { text: [], message: [], author: [], commit: [], file: [], content: [], branch: [], after: null, before: null };
  let i = 0;
  while (i < input.length) {
    if (/\s/.test(input[i])) { i++; continue; }
    const m = /^([a-z-]+):/.exec(input.slice(i));
    const kw = m ? BY_NAME.get(m[1]) : undefined;
    const [v, next] = readValue(input, kw ? i + m![0].length : i);
    i = next;
    if (!v.trim()) continue; // `file:` still being typed
    if (!kw) q.text.push(v);
    else if (kw.field === "after" || kw.field === "before") q[kw.field] = v; // the last one wins
    else q[kw.field].push(v);
  }
  return q;
}

/** git reads a bare `2024-01-31` as that day at the current time of day; the search means the start of the day. */
export const forGit = (q: SearchQuery): SearchQuery => {
  const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v} 00:00` : v);
  return { ...q, after: day(q.after), before: day(q.before) };
};

export const isEmptyQuery = (q: SearchQuery): boolean =>
  !q.after && !q.before && [q.text, q.message, q.author, q.commit, q.file, q.content, q.branch].every((v) => !v.length);

/** Start of the word the caret is in, or -1 inside a quoted value. */
function wordStart(input: string, caret: number): number {
  let quotes = 0;
  for (let k = 0; k < caret; k++) if (input[k] === '"' && input[k - 1] !== "\\") quotes++;
  if (quotes % 2) return -1;
  let s = caret;
  while (s > 0 && !/\s/.test(input[s - 1])) s--;
  return s;
}

/** Keywords for the word before the caret: names starting with it first, then ones containing its letters in order. */
export function suggest(input: string, caret: number): Keyword[] {
  const s = wordStart(input, caret);
  const word = s < 0 ? "" : input.slice(s, caret).toLowerCase();
  if (!word || word.includes(":") || word.includes('"')) return [];
  const sub = (name: string) => { let j = 0; for (const c of name) if (c === word[j]) j++; return j === word.length; };
  return [...KEYWORDS.filter((k) => k.name.startsWith(word)), ...KEYWORDS.filter((k) => !k.name.startsWith(word) && sub(k.name))];
}

/** Replace the word before the caret with `keyword:`; the new text and caret. */
export function complete(input: string, caret: number, kw: Keyword): { value: string; caret: number } {
  const s = Math.max(0, wordStart(input, caret));
  const ins = `${kw.name}:`;
  return { value: input.slice(0, s) + ins + input.slice(caret), caret: s + ins.length };
}
