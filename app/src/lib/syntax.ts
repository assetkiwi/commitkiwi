// Whole-file syntax highlighting with Lezer (CodeMirror 6 parsers), so strings and comments that span
// lines are coloured right. Parsers load lazily per language; files over the cap, or languages without a
// Lezer parser, fall back to highlight.js per line (highlight.ts).
import type { Language } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { escapeHtml } from "./highlight";

type Parser = Language["parser"];
const MAX = 1 << 20;

// keys are the highlight.js ids from lang.ts
const LOADERS: Record<string, () => Promise<Parser>> = {
  php: async () => (await import("@codemirror/lang-php")).php().language.parser,
  javascript: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }).language.parser,
  typescript: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }).language.parser,
  json: async () => (await import("@codemirror/lang-json")).json().language.parser,
  css: async () => (await import("@codemirror/lang-css")).css().language.parser,
  scss: async () => (await import("@codemirror/lang-sass")).sass().language.parser,
  xml: async () => (await import("@codemirror/lang-xml")).xml().language.parser,
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml().language.parser,
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown().language.parser,
  python: async () => (await import("@codemirror/lang-python")).python().language.parser,
  rust: async () => (await import("@codemirror/lang-rust")).rust().language.parser,
  go: async () => (await import("@codemirror/lang-go")).go().language.parser,
  sql: async () => (await import("@codemirror/lang-sql")).sql().language.parser,
};
const parsers = new Map<string, Promise<Parser>>();

export const hasLezer = (lang: string | null): boolean => !!lang && lang in LOADERS;

/** HTML per line of `text` (same split as `fileLines`), or null: no parser, too big, or it failed. */
export async function highlightFile(text: string, lang: string | null): Promise<string[] | null> {
  if (!lang || !LOADERS[lang] || text.length > MAX) return null;
  try {
    let p = parsers.get(lang);
    if (!p) parsers.set(lang, (p = LOADERS[lang]()));
    const tree = (await p).parse(text);
    const lines: string[] = [];
    let cur = "", pos = 0;
    // text between styled ranges, split at newlines; a styled range that spans lines is re-opened per line
    const put = (to: number, cls: string) => {
      const parts = text.slice(pos, to).split("\n");
      parts.forEach((part, k) => {
        if (k) { lines.push(cur); cur = ""; }
        if (part) cur += cls ? `<span class="${cls}">${escapeHtml(part)}</span>` : escapeHtml(part);
      });
      pos = to;
    };
    highlightTree(tree, classHighlighter, (from, to, classes) => { put(from, ""); put(to, classes); });
    put(text.length, "");
    lines.push(cur);
    if (text.endsWith("\n")) lines.pop();
    return lines;
  } catch {
    return null;
  }
}
