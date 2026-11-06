// Themes as data: a name, light or dark, an optional theme it extends, and values for our CSS custom properties
// (app.css). Built-in Light and Dark are the stylesheet's own look (no variables); others set variables on top of
// their kind. User themes are `<config dir>/themes/*.theme.json`. Pure and import-free.
import { parseJsonc } from "./jsonc.ts";

export interface ThemeDef { id: string; name: string; kind: "light" | "dark"; extends?: string; variables: Record<string, string> }

/** Every variable a theme may set (docs/CONFIGURATION.md lists them with their meaning). */
export const THEME_VARIABLES = [
  "--bg", "--surface", "--surface-2", "--hover", "--sel", "--sel-ring", "--border", "--border-strong",
  "--text", "--text-2", "--muted", "--accent", "--accent-soft", "--accent-text", "--on-accent", "--danger",
  "--lane0", "--lane1", "--lane2", "--lane3", "--lane4", "--lane5", "--shadow",
  "--add-bg", "--add-gutter", "--add-fg", "--del-bg", "--del-gutter", "--del-fg", "--wd-add", "--wd-del",
  "--band-soft", "--band", "--band-conflict", "--conflict-fg",
  "--syn-kw", "--syn-str", "--syn-com", "--syn-num", "--syn-fn", "--syn-var", "--syn-attr",
  "--primary-bg", "--primary-hover", "--primary-text",
  "--font-ui", "--font-mono", "--radius-control", "--radius-card", "--radius-pill",
] as const;
const KNOWN = new Set<string>(THEME_VARIABLES);

/** A theme file's text -> its definition (`id` = its name). Throws with the reason. */
export function parseTheme(text: string): ThemeDef {
  const v = parseJsonc(text) as Record<string, unknown>;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("the file must contain a JSON object");
  if (typeof v.name !== "string" || !v.name.trim()) throw new Error("\"name\" is missing");
  if (v.kind !== "light" && v.kind !== "dark") throw new Error("\"kind\" must be \"light\" or \"dark\"");
  if (v.extends !== undefined && typeof v.extends !== "string") throw new Error("\"extends\" must be a theme name");
  const vars = v.variables ?? {};
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) throw new Error("\"variables\" must be an object");
  for (const [k, val] of Object.entries(vars)) {
    if (!KNOWN.has(k)) throw new Error(`unknown variable ${k}`);
    // a value is one declaration's value, nothing that could end it
    if (typeof val !== "string" || !val.trim() || /[;{}<>]/.test(val)) throw new Error(`bad value for ${k}`);
  }
  return { id: v.name.trim(), name: v.name.trim(), kind: v.kind, ...(v.extends ? { extends: v.extends } : {}), variables: vars as Record<string, string> };
}

/** The theme with this id or name (built-ins first), its `extends` chain merged in (base first). */
export function resolveTheme(key: string, all: ThemeDef[]): { theme: ThemeDef; variables: Record<string, string> } | null {
  const find = (k: string) => all.find((t) => t.id === k) ?? all.find((t) => t.name === k);
  const theme = find(key);
  if (!theme) return null;
  const chain: ThemeDef[] = [];
  for (let t: ThemeDef | undefined = theme; t && !chain.includes(t); t = t.extends ? find(t.extends) : undefined) chain.unshift(t);
  return { theme, variables: Object.assign({}, ...chain.map((t) => t.variables)) };
}

/** WCAG contrast ratio of two `#rrggbb` colours (1..21). */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
