// Natural-language search (the ✨ toggle in the search bar): the deterministic parts around the model. Relative dates
// are resolved here before the model is asked (it only copies them), the request carries the KEYWORDS table (the Rust
// side builds its grammar and prompt from it), and the answer is checked with the same parser as typed queries.
// Pure and import-free apart from ./search.ts (node-tested).
import { KEYWORDS, parseSearch, type SearchQuery } from "./search.ts";

export interface DateRange { after: string | null; before: string | null; phrase: string }

const DAY = 86_400_000;
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const NUM = `(\\d{1,3}|${Object.keys(NUMBERS).join("|")})`;
const UNIT = "(day|week|month|year)s?";

const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
const parseIso = (d: string): number => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
/** A real `YYYY-MM-DD` date (not 2026-02-31). */
export const isIsoDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && iso(parseIso(s)) === s;

/** `t` moved by `n` months, the day clamped to the month's length (Mar 31 - 1 month = Feb 28/29). */
function addMonths(t: number, n: number): number {
  const d = new Date(t);
  const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
  const len = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n + 1, 0)).getUTCDate();
  return first + (Math.min(d.getUTCDate(), len) - 1) * DAY;
}
function back(t: number, n: number, unit: string): number {
  if (unit === "day") return t - n * DAY;
  if (unit === "week") return t - 7 * n * DAY;
  return addMonths(t, unit === "month" ? -n : -12 * n);
}

/**
 * The first relative date phrase in `sentence` as a range of days (`after` inclusive, `before` exclusive), `today`
 * being `YYYY-MM-DD`; weeks start on Monday. "since X" keeps only the start. "N days ago" and "last N weeks" mean
 * "since then". A weekday is the latest one before today; a month without a year the latest one up to this month.
 */
export function resolveDates(sentence: string, today: string): DateRange | null {
  if (!isIsoDate(today)) return null;
  const s = sentence.toLowerCase();
  const t = parseIso(today);
  const d = new Date(t);
  const [y, m] = [d.getUTCFullYear(), d.getUTCMonth()];
  const monday = t - ((d.getUTCDay() + 6) % 7) * DAY;
  const num = (w: string) => NUMBERS[w] ?? Number(w);
  const range = (a: number, b: number | null) => [a, b] as const;
  const rules: [RegExp, (g: string[]) => readonly [number, number | null]][] = [
    [new RegExp(`\\b(?:in |during |over |within )?(?:the )?(?:last|past) ${NUM} ${UNIT}\\b`), (g) => range(back(t, num(g[1]), g[2]), null)],
    [new RegExp(`\\b${NUM} ${UNIT} ago\\b`), (g) => range(back(t, num(g[1]), g[2]), null)],
    [/\btoday\b/, () => range(t, t + DAY)],
    [/\byesterday\b/, () => range(t - DAY, t)],
    [/\bthis week\b/, () => range(monday, null)],
    [/\blast week\b/, () => range(monday - 7 * DAY, monday)],
    [/\bthis month\b/, () => range(Date.UTC(y, m, 1), null)],
    [/\blast month\b/, () => range(Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1))],
    [/\bthis year\b/, () => range(Date.UTC(y, 0, 1), null)],
    [/\blast year\b/, () => range(Date.UTC(y - 1, 0, 1), Date.UTC(y, 0, 1))],
    [new RegExp(`\\b(?:on |last )?(${WEEKDAYS.join("|")})\\b`), (g) => {
      const ago = ((d.getUTCDay() + 6) % 7) - WEEKDAYS.indexOf(g[1]);
      const day = t - (ago > 0 ? ago : ago + 7) * DAY;
      return range(day, day + DAY);
    }],
    [new RegExp(`\\b(?:in|during|from|since) (${MONTHS.join("|")})(?: (\\d{4}))?\\b`), (g) => {
      const mi = MONTHS.indexOf(g[1]);
      const year = g[2] ? +g[2] : mi > m ? y - 1 : y;
      return range(Date.UTC(year, mi, 1), Date.UTC(year, mi + 1, 1));
    }],
  ];
  for (const [re, f] of rules) {
    const g = re.exec(s);
    if (!g) continue;
    const [a, b] = f(g);
    const since = /\bsince\s*$/.test(s.slice(0, g.index)) || g[0].startsWith("since");
    return { after: iso(a), before: since || b === null ? null : iso(b), phrase: sentence.slice(g.index, g.index + g[0].length) };
  }
  return null;
}

export const dateTokens = (r: DateRange | null): string[] =>
  r ? [r.after && `after:${r.after}`, r.before && `before:${r.before}`].filter((x): x is string => !!x) : [];

export interface Hints { recent_authors: string[]; known_paths: string[]; branches: string[] }
/** What `llm_search_query` takes (crates/llm/src/search.rs `Input`). */
export interface SearchModelInput extends Hints { sentence: string; today: string; keywords: { name: string; field: string; desc: string }[]; dates: string[] }

export function searchRequest(sentence: string, today: string, hints: Hints): SearchModelInput {
  return { sentence: sentence.trim(), today, keywords: KEYWORDS.map((k) => ({ ...k })), dates: dateTokens(resolveDates(sentence, today)), ...hints };
}

/** The authors of `commits`, most frequent first (the model maps "by alex" to their spelling). */
export function topAuthors(commits: { author: string }[], max = 12): string[] {
  const n = new Map<string, number>();
  for (const c of commits) if (c.author.trim()) n.set(c.author, (n.get(c.author) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).slice(0, max).map(([a]) => a);
}

const quote = (v: string): string => (/[\s"\\]/.test(v) || v === "" ? `"${v.replace(/["\\]/g, "\\$&")}"` : v);
const FIELDS = ["author", "file", "message", "content", "branch", "commit"] as const;

/** The query as `keyword:value` tokens (one per value; the field names are keywords too), free text last. */
export function queryTokens(q: SearchQuery): string[] {
  return [
    ...FIELDS.flatMap((f) => q[f].map((v) => `${f}:${quote(v)}`)),
    ...(q.after ? [`after:${quote(q.after)}`] : []), ...(q.before ? [`before:${quote(q.before)}`] : []),
    ...q.text.map(quote),
  ];
}

const STOP = new Set(("the a an of in on at to for from by with and or about that this these those which who what when where commits commit changes change " +
  "changed show find me all any my our touching touched since before after last ago days day weeks week months month years year today yesterday " +
  "did do does made make were was is are has have had").split(" "));

/** The model's answer, checked like a typed query: unknown keywords, bad dates, a second contents:/branch: and a
 *  non-hex commit: are left out with a warning; resolved dates replace the model's. Nothing but dates left: the
 *  longest real word of the sentence is added. */
export function checkAnswer(answer: string, sentence: string, dates: DateRange | null): { query: string; warnings: string[] } {
  const q = parseSearch(answer);
  const warnings: string[] = [];
  q.text = q.text.filter((t) => {
    const unknown = /^([a-z-]+):/.exec(t);
    if (unknown) warnings.push(`Left out ${unknown[1]}: (not a search keyword).`);
    return !unknown;
  });
  // without a date phrase or a year in the request, a date from the model is made up
  const named = !!dates || /\b\d{4}\b/.test(sentence);
  for (const k of ["after", "before"] as const) {
    if (q[k] && !isIsoDate(q[k]!)) { warnings.push(`Left out ${k}:${q[k]} (not a date).`); q[k] = null; }
    else if (q[k] && !named) { warnings.push(`Left out ${k}:${q[k]} (the request names no date).`); q[k] = null; }
  }
  if (dates) { q.after = dates.after; q.before = dates.before; }
  for (const k of ["content", "branch"] as const) {
    if (q[k].length > 1) { warnings.push(`Kept the first of ${q[k].length} ${k}: terms (only one is supported).`); q[k] = q[k].slice(0, 1); }
  }
  q.commit = q.commit.filter((c) => /^[0-9a-f]{4,64}$/i.test(c) || (warnings.push(`Left out commit:${c} (not a commit hash).`), false));
  const tokens = queryTokens(q);
  if (!tokens.some((t) => !/^(after|before):/.test(t))) {
    // nothing but dates (or nothing at all) survived: one word of the request, unless it has none
    const words = sentence.replace(dates?.phrase ?? "\u0000", " ").toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu) ?? [];
    const word = words.filter((w) => !STOP.has(w)).sort((a, b) => b.length - a.length)[0];
    if (word) { tokens.push(quote(word)); warnings.push(`The model's answer was not usable; searching for "${word}" instead.`); }
    else if (!tokens.length) throw new Error("Could not turn that into a search; try other words or Edit as Keywords.");
  }
  return { query: tokens.join(" "), warnings };
}
