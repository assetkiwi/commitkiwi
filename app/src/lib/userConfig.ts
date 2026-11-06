// The user's config files besides the keymap: `commands.json` (palette entries), `<Menu>.menu.json` additions,
// `settings.json` (preferences that win over the Preferences window) and `themes/*.theme.json`. Read after the
// saved preferences load and whenever the window gets focus (an edit in an editor shows up on return). A broken
// file is reported and ignored, never fatal. Older file names are read by the backend while a new one is missing.
import { api } from "./api";
import { commandsChanged } from "./commands";
import { MENU_FILES, applyUserMenus } from "./contextMenus";
import { parseCommands, type PaletteEntry } from "./palette";
import { parseJsonc } from "./jsonc";
import { parseTheme, type ThemeDef } from "./themes";
import { BUILTIN_THEMES, app, applySettings, prefsLoaded, setUserThemes } from "./state.svelte";

export const COMMANDS_FILE = "commands.json";
export const SETTINGS_FILE = "settings.json";
const NAMES = [COMMANDS_FILE, SETTINGS_FILE, ...Object.keys(MENU_FILES)];

let commands: PaletteEntry[] = [];
/** The user's palette entries (after the defaults in the palette). */
export const userCommands = (): PaletteEntry[] => commands;

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
let last: string | null = null;

/** Theme files -> definitions; a bad file, or one named like a built-in, is reported and left out. */
export function loadThemes(files: [string, string][], problems: string[]): ThemeDef[] {
  const out: ThemeDef[] = [];
  for (const [file, text] of files) {
    try {
      const t = parseTheme(text);
      if ([...BUILTIN_THEMES, ...out].some((b) => b.name === t.name || b.id === t.id)) throw new Error(`a theme named "${t.name}" exists already`);
      out.push(t);
    } catch (e) { problems.push(`themes/${file}: ${why(e)}`); }
  }
  return out;
}

export async function loadUserConfig(): Promise<void> {
  await prefsLoaded;
  const problems: string[] = [];
  const [texts, themes] = await Promise.all([
    Promise.all(NAMES.map((n) => api.readConfig(n).catch((e) => { problems.push(`${n}: ${why(e)}`); return ""; }))),
    api.listThemes().catch((e) => { problems.push(`themes: ${why(e)}`); return [] as [string, string][]; }),
  ]);
  const all = JSON.stringify([texts, themes]);
  if (all === last && !problems.length) return; // unchanged since the last load
  last = all;
  try { commands = parseCommands(texts[0]); } catch (e) { commands = []; problems.push(`${COMMANDS_FILE}: ${why(e)}`); }
  setUserThemes(loadThemes(themes, problems)); // before settings.json, which may name one
  let settings: Record<string, unknown> = {};
  try {
    const v = texts[1].trim() ? parseJsonc(texts[1]) : {};
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("the file must contain a JSON object");
    settings = v as Record<string, unknown>;
  } catch (e) { problems.push(`${SETTINGS_FILE}: ${why(e)}`); }
  const bad = applySettings(settings);
  if (bad.length) problems.push(`${SETTINGS_FILE}: unknown setting or wrong value for ${bad.join(", ")}`);
  const menus: Record<string, unknown[]> = {};
  NAMES.slice(2).forEach((name, i) => {
    const text = texts[i + 2];
    if (!text.trim()) return;
    try {
      const v = parseJsonc(text);
      if (!Array.isArray(v)) throw new Error("the file must contain a JSON array");
      menus[name] = v;
    } catch (e) { problems.push(`${name}: ${why(e)}`); }
  });
  applyUserMenus(menus);
  if (problems.length) app.notice = `Could not read your ${problems.join("; ")}`;
  commandsChanged();
}
