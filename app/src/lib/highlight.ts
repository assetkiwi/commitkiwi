// Per-line syntax highlighting. shortcut: each line is highlighted on its own, so a string or comment that
// spans lines is coloured wrongly after its first line; upgrade to tree-sitter (in the agent) if that bites.
import hljs from "highlight.js/lib/core";
import apache from "highlight.js/lib/languages/apache";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nginx from "highlight.js/lib/languages/nginx";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import twig from "highlight.js/lib/languages/twig";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, def] of Object.entries({ apache, bash, css, diff, dockerfile, go, ini, javascript, json, makefile, markdown, nginx, php, python, rust, scss, sql, twig, typescript, xml, yaml }))
  hljs.registerLanguage(name, def);

const MAX_LINE = 2000; // minified bundles: not worth highlighting

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** HTML for one line. Always safe to inject: highlight.js escapes its input, and the fallback escapes too. */
export function highlightLine(text: string, lang: string | null): string {
  if (!lang || text.length > MAX_LINE) return escapeHtml(text);
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}
