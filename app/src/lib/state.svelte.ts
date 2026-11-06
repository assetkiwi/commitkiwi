import { api } from "./api";
import { dropCache } from "./commitCache";
import { addRecents, touchRecent, isGoneError, RECENT_MAX, type Recent } from "./recent";
import { failQueued } from "./jobs.svelte";
import type { Refs, RepoChange, RepoInfo } from "./types";
import { resolveTheme, type ThemeDef } from "./themes";
import kiwiLight from "./themes/kiwi-light.theme.json";
import kiwiDark from "./themes/kiwi-dark.theme.json";

export type { Recent };

/** "system" (Light or Dark by the OS setting), a built-in theme's id, or a user theme's name. */
export type Theme = string;
/** Light and Dark are the stylesheet's own look (app.css); the Kiwi themes are data (lib/themes/). */
export const BUILTIN_THEMES: ThemeDef[] = [
  { id: "light", name: "Light", kind: "light", variables: {} },
  { id: "dark", name: "Dark", kind: "dark", variables: {} },
  { ...(kiwiLight as Omit<ThemeDef, "id" | "kind">), id: "kiwi-light", kind: "light" },
  { ...(kiwiDark as Omit<ThemeDef, "id" | "kind">), id: "kiwi-dark", kind: "dark" },
];
export interface Tab {
  id: string; location: string; path: string; info: RepoInfo; refs: Refs; total: number;
  /** bumped when history changed under the tab (commit/amend) so views remount with fresh data */
  rev: number;
  /** uncommitted changes at the last status poll: the tab shows a dot instead of the close button */
  dirty: boolean;
  /** Set Alias: shown instead of the repo name */
  alias: string;
  /** full ref names hidden from the commit graph (the eye in Locations), persisted per repo */
  hidden: string[];
  /** live updates: undefined = asking, null = file events, a string = why it polls instead */
  watching?: string | null;
}
/** `side_bar_layout` values */
export type SideBarLayout = "tabs" | "commit_graph_as_column" | "locations_as_column" | "columns";
export const LAYOUTS: { value: SideBarLayout; caption: string }[] = [
  { value: "tabs", caption: "One Column" },
  { value: "commit_graph_as_column", caption: "Two Columns, Files on Left" },
  { value: "locations_as_column", caption: "Two Columns, Files on Right" },
  { value: "columns", caption: "Three Columns" },
];
export interface DiffSettings {
  mode: "unified" | "split";
  context: number;
  ignoreWs: boolean;
  words: boolean;
  syntax: boolean;
  /** unified view wraps long lines instead of scrolling (split always wraps) */
  wrap: boolean;
  /** `{path}` and `{host}` are filled in after the command is split into arguments (no shell) */
  editorLocal: string;
  editorRemote: string;
}
const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
export const DIFF_DEFAULTS: DiffSettings = {
  mode: "split", context: 3, ignoreWs: false, words: true, syntax: true, wrap: false,
  editorLocal: isMac ? "open -t {path}" : "xdg-open {path}",
  editorRemote: "code --remote ssh-remote+{host} {path}",
};

/** Stored under these names: Sublime Merge's where it has one (ignore_diff_white_space, word_wrap), ours otherwise. */
const DIFF_KEYS: Record<keyof DiffSettings, string> = {
  mode: "diff_style", context: "diff_context_lines", ignoreWs: "ignore_diff_white_space", words: "word_diff",
  syntax: "diff_syntax_colors", wrap: "word_wrap", editorLocal: "editor_command", editorRemote: "editor_command_remote",
};
/** The rest of the Preferences window, by setting name (the compatible names where one exists). */
export interface Prefs {
  ui_font_size: number;
  /** the diff/file text */
  font_size: number;
  expand_merge_commits_by_default: boolean;
  /** Open in Terminal; `{path}` is the repository folder, no shell */
  terminal_command: string;
  /** ask before discarding, force pushing, hard resets, dropping commits/stashes */
  confirm_destructive: boolean;
  /** remote agent builds unused this long are deleted after a connection (at most daily per host); 0: never */
  agent_cleanup_days: number;
  /** self-hosted forges: host -> which one it is (asked once in Create Pull/Merge Request) */
  /** the commit message model to use (crates/llm catalog id); empty: the first one downloaded */
  commit_model: string;
  /** the local model suggests a commit message in the empty message box (Tab takes it) */
  commit_suggest: boolean;
  /** the search bar takes a sentence and the local model turns it into keywords (the ✨ toggle) */
  natural_search: boolean;
  forge_hosts: Record<string, "github" | "gitlab">;
  /** where gh / glab are on this computer (empty: PATH and the usual folders) */
  gh_path: string;
  glab_path: string;
  /** open a new pull/merge request in the browser once it is created */
  open_request_after_create: boolean;
  /** "default" (ours, docs/KEYMAP.md) or "sublime-style"; the user's keymap file goes on top of either */
  keymap_preset: "default" | "sublime-style";
  /** Clean Up Branches: a branch without a commit for this many days is stale (0: off) */
  cleanup_stale_days: number;
  /** Clean Up Branches never offers these (`*` globs, matched without the remote name) */
  cleanup_protected_branches: string[];
}
export const PREF_DEFAULTS: Prefs = {
  ui_font_size: 13, font_size: 12, expand_merge_commits_by_default: true,
  terminal_command: isMac ? "open -a Terminal {path}" : "gnome-terminal --working-directory={path}",
  confirm_destructive: true, agent_cleanup_days: 30,
  commit_model: "", commit_suggest: true, natural_search: false, forge_hosts: {}, gh_path: "", glab_path: "", open_request_after_create: true,
  keymap_preset: "default",
  cleanup_stale_days: 90, cleanup_protected_branches: ["main", "master", "develop", "trunk", "release/*"],
};
/** Allowed values where a type check is not enough. */
const PREF_CHOICES: Partial<Record<keyof Prefs, unknown[]>> = { keymap_preset: ["default", "sublime-style"] };

export const app = $state({
  prefs: { ...PREF_DEFAULTS } as Prefs,
  /** Set Alias names by repository (tab id), kept for repositories without an open tab too */
  aliases: {} as Record<string, string>,
  diff: { ...DIFF_DEFAULTS } as DiffSettings,
  tabs: [] as Tab[],
  active: "locations", // "locations" (the New Tab page), "dashboard" or a tab id
  theme: "system" as Theme,
  recent: [] as Recent[],
  messages: [] as string[], // recent commit messages, newest first
  notice: "",
  ready: false,
  layout: "locations_as_column" as SideBarLayout,
  hiddenRefs: {} as Record<string, string[]>, // tab id -> Tab.hidden, kept for closed tabs too
  /** remote locations whose link dropped: why (reconnecting meanwhile) */
  links: {} as Record<string, string>,
  /** themes from `<config dir>/themes/*.theme.json` */
  userThemes: [] as ThemeDef[],
  /** setting names that settings.json sets (read-only in Preferences) */
  fromSettings: [] as string[],
});

// ---- live updates (M8): every open tab is watched; the open RepoView takes its changes, others refresh in place
type TabChange = { refs: boolean; work: boolean };
const tabListeners = new Map<string, (c: TabChange) => void>();
/** The repo view for tab `id` handles its changes while it is open. Returns the unsubscribe function. */
export function onTabChange(id: string, fn: (c: TabChange) => void): () => void {
  tabListeners.set(id, fn);
  return () => { if (tabListeners.get(id) === fn) tabListeners.delete(id); };
}
function watchTab(t: Tab): void {
  api.watchRepo(t.location, t.path).then((polling) => { t.watching = polling; }, (e) => { t.watching = String(e); });
}
function deliver(t: Tab, c: TabChange): void {
  const fn = tabListeners.get(t.id);
  if (fn) { fn(c); return; }
  // a tab in the background: keep its dot and refs current
  if (c.refs) void reloadTab(t).catch(() => {});
  if (c.work) void api.status(t.location, t.path).then((s) => setDirty(t, s.files.length > 0), () => {});
}
function onChange(c: RepoChange): void {
  for (const t of app.tabs.filter((x) => x.location === c.location && x.path === c.repo)) {
    if (c.polling) t.watching = c.polling;
    deliver(t, { refs: c.refs, work: c.work });
  }
}
/** host -> when its old agent builds were last swept (ms); saved so a restart does not sweep again the same day */
const agentCleanupAt: Record<string, number> = {};
function sweepAgents(location: string): void {
  const host = hostOf(location), days = app.prefs.agent_cleanup_days;
  if (!host || days < 1 || Date.now() - (agentCleanupAt[host] ?? 0) < 864e5) return;
  agentCleanupAt[host] = Date.now();
  persist();
  // in the background, never delays the tab; a failure only shows in the console (and is tried again tomorrow)
  api.cleanupAgents(host, days).then(([n, b]) => console.debug(`agent cleanup on ${host}: ${n} files, ${b} bytes`), (e) => console.debug(`agent cleanup on ${host} failed: ${e}`));
}
async function onConnection(location: string, lost: string | null): Promise<void> {
  if (lost !== null) {
    app.links[location] = lost;
    failQueued(location, lost);
    return;
  }
  delete app.links[location];
  sweepAgents(location);
  // back: reload what may have changed while it was down (the backend re-subscribed the watchers)
  for (const t of app.tabs.filter((x) => x.location === location)) {
    await reloadTab(t).catch(() => {});
    deliver(t, { refs: false, work: true });
  }
}
let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  void api.onRepoChanged(onChange);
  void api.onConnection((l, lost) => void onConnection(l, lost));
}

const tabId = (location: string, root: string) => `${location}|${root}`;
export const hostOf = (location: string) => (location.startsWith("ssh:") ? location.slice(4) : "");

async function loadTab(location: string, path: string, opened?: RepoInfo): Promise<Tab> {
  const info = opened ?? await api.open(location, path);
  const id = tabId(location, info.root);
  const hidden = app.hiddenRefs[id] ?? [];
  const [refs, total] = await Promise.all([api.refs(location, info.root), api.count(location, info.root, hidden)]);
  return { id, location, path: info.root, info, refs, total, rev: 0, dirty: false, alias: app.aliases[id] ?? "", hidden };
}

/** Open (or focus) a repo. Rejects with the backend's message, shown by the caller. */
export async function openRepo(location: string, path: string): Promise<void> {
  const info = await api.open(location, path).catch((e) => {
    if (isGoneError(e) && app.recent.some((r) => r.location === location && r.path === path)) {
      removeRecent({ location, path });
      app.notice = `Removed ${path} from recent repositories: it no longer exists or is not a git repository.`;
    }
    throw e;
  });
  const id = tabId(location, info.root);
  if (!app.tabs.some((t) => t.id === id)) {
    app.tabs.push(await loadTab(location, info.root, info)); // reuse the Open answer: one round trip less on a remote
    watchTab(app.tabs[app.tabs.length - 1]);
  }
  app.active = id;
  app.recent = touchRecent(app.recent, { location, path: info.root });
  persist();
}

/** Bulk add (Add Repositories from Folder…): list repos in the switcher without opening tabs. */
export function addRecentRepos(location: string, paths: string[]): void {
  app.recent = addRecents(app.recent, location, paths);
  persist();
}

const closed: Recent[] = []; // most recently closed first, for restore_tab

export function closeTab(id: string): void {
  const i = app.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  closed.unshift({ location: app.tabs[i].location, path: app.tabs[i].path });
  closed.length = Math.min(closed.length, 20);
  void api.unwatchRepo(app.tabs[i].location, app.tabs[i].path).catch(() => {});
  app.tabs.splice(i, 1);
  dropCache(id);
  if (app.active === id) app.active = app.tabs[Math.min(i, app.tabs.length - 1)]?.id ?? "locations";
  persist();
}

/** Re-read HEAD, refs and the commit count after history changed (commit, amend), and drop cached pages. */
export async function reloadTab(tab: Tab): Promise<void> {
  const fresh = await loadTab(tab.location, tab.path);
  dropCache(tab.id);
  tab.info = fresh.info;
  tab.refs = fresh.refs;
  tab.total = fresh.total;
  tab.hidden = fresh.hidden;
  tab.rev++;
}

/** Hide/show refs in the commit graph (persisted per repo), then reload the list. */
export async function setHidden(tab: Tab, hidden: string[]): Promise<void> {
  if (hidden.length) app.hiddenRefs[tab.id] = [...new Set(hidden)].sort();
  else delete app.hiddenRefs[tab.id];
  persist();
  await reloadTab(tab);
}

/** Mutated here, not in the view: the tab belongs to `app`. */
export function setDirty(t: Tab, dirty: boolean): void { t.dirty = dirty; }

export const tabName = (t: Tab): string => t.alias || t.info.name;

export function setAlias(t: Tab, alias: string): void {
  setRepoAlias(t.id, alias);
}

/** Alias for a repository by id (`location|path`), open in a tab or not; "" removes it. */
export function setRepoAlias(id: string, alias: string): void {
  const a = alias.trim();
  if (a) app.aliases[id] = a; else delete app.aliases[id];
  const t = app.tabs.find((x) => x.id === id);
  if (t) t.alias = a;
  persist();
}

/** Forget one repository from Switch Repository (all with null). Open tabs stay open. */
export function removeRecent(r: Recent | null): void {
  app.recent = r ? app.recent.filter((x) => x.location !== r.location || x.path !== r.path) : [];
  persist();
}

/** Show every hidden branch again for a repository (open or not). */
export function resetHidden(id: string): Promise<void> | void {
  const t = app.tabs.find((x) => x.id === id);
  if (t) return setHidden(t, []);
  delete app.hiddenRefs[id];
  persist();
}

/** settings.json sets it: UI changes are ignored (except while settings.json itself is applied) */
const locked = (name: string) => !applying && overridden.has(name);
let applying = false;

export function setLayout(layout: SideBarLayout): void {
  if (locked("side_bar_layout")) return;
  app.layout = layout;
  persist();
}

export function setDiff(patch: Partial<DiffSettings>): void {
  Object.assign(app.diff, Object.fromEntries(Object.entries(patch).filter(([k]) => !locked(DIFF_KEYS[k as keyof DiffSettings]))));
  persist();
}

/** set_preference / toggle_preference by stored setting name; false when the name or value type is unknown, or
 *  settings.json sets it. */
export function setPreference(name: string, value: unknown): boolean {
  return !overridden.has(name) && assignPreference(name, value);
}
function assignPreference(name: string, value: unknown): boolean {
  if (name === "side_bar_layout") return LAYOUTS.some((l) => l.value === value) && (setLayout(value as SideBarLayout), true);
  if (name === "theme") return typeof value === "string" && (value === "system" || !!findTheme(value)) && (setTheme(value), true);
  const dk = (Object.keys(DIFF_KEYS) as (keyof DiffSettings)[]).find((k) => DIFF_KEYS[k] === name);
  if (dk) return typeof value === typeof DIFF_DEFAULTS[dk] && (setDiff({ [dk]: value }), true);
  if (name in PREF_DEFAULTS) return validPref(name as keyof Prefs, value) && (setPrefs({ [name]: value }), true);
  return false;
}
const validPref = (k: keyof Prefs, v: unknown) => typeof v === typeof PREF_DEFAULTS[k] && v !== null && (PREF_CHOICES[k]?.includes(v) ?? true);

/** settings.json: name -> the value it hides (what the UI saved), restored when the key leaves the file. */
const overridden = new Map<string, unknown>();
/** Apply settings.json (parsed): its keys win over preferences.json and are read-only in the UI. Returns the keys
 *  it could not use (unknown name or wrong type). preferences.json keeps the UI's own values. */
export function applySettings(settings: Record<string, unknown>): string[] {
  applying = true;
  try { return applyAll(settings); } finally { applying = false; }
}
function applyAll(settings: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const [name, hidden] of [...overridden]) {
    if (name in settings) continue;
    overridden.delete(name);
    assignPreference(name, hidden);
  }
  for (const [name, value] of Object.entries(settings)) {
    const hidden = overridden.has(name) ? overridden.get(name) : getPreference(name);
    overridden.delete(name); // so the assignment below is allowed
    if (assignPreference(name, value)) overridden.set(name, hidden);
    else { bad.push(name); if (hidden !== undefined && getPreference(name) !== hidden) assignPreference(name, hidden); }
  }
  app.fromSettings = [...overridden.keys()];
  persist();
  return bad;
}
export function getPreference(name: string): unknown {
  if (name === "side_bar_layout") return app.layout;
  if (name === "theme") return app.theme;
  const dk = (Object.keys(DIFF_KEYS) as (keyof DiffSettings)[]).find((k) => DIFF_KEYS[k] === name);
  return dk ? app.diff[dk] : app.prefs[name as keyof Prefs];
}

export function setPrefs(patch: Partial<Prefs>): void {
  Object.assign(app.prefs, Object.fromEntries(Object.entries(patch).filter(([k]) => !locked(k))));
  applyPrefs();
  persist();
}

/** Font sizes: the diff text through a CSS variable, the whole interface as a zoom (13 px = 100%). */
function applyPrefs(): void {
  const root = document.documentElement;
  root.style.setProperty("--diff-size", `${app.prefs.font_size}px`);
  void api.setZoom(app.prefs.ui_font_size / PREF_DEFAULTS.ui_font_size).catch(() => {});
}

/** Open a working-tree file (path relative to the repo root) in the configured editor. */
export async function openInEditor(tab: Tab, relPath: string): Promise<void> {
  const host = hostOf(tab.location);
  const template = host ? app.diff.editorRemote : app.diff.editorLocal;
  try {
    await api.openEditor(template, `${tab.path}/${relPath}`, host);
  } catch (e) {
    app.notice = String(e);
  }
}

export function addMessage(message: string): void {
  app.messages = [message, ...app.messages.filter((m) => m !== message)].slice(0, 20);
  persist();
}

/** Reopen the most recently closed repository tab. */
export async function restoreTab(): Promise<void> {
  const last = closed.shift();
  if (last) await openRepo(last.location, last.path);
}

/** Select repo tab `index` (0-based; Cmd+1 = 0). Out of range: nothing happens. */
export function selectTab(index: number): void {
  const t = app.tabs[index];
  if (t) setActive(t.id);
}

/** Move repo tab `id` to position `to` (clamped). The order is saved, and Cmd/Ctrl+1..9 follow it. */
export function moveTab(id: string, to: number): void {
  const from = app.tabs.findIndex((t) => t.id === id);
  const at = Math.max(0, Math.min(to, app.tabs.length - 1));
  if (from < 0 || from === at) return;
  const [t] = app.tabs.splice(from, 1);
  app.tabs.splice(at, 0, t);
  persist();
}

/** Cycle through [Locations, ...repo tabs]. */
export function cycleTab(step: 1 | -1): void {
  const ids = ["locations", ...app.tabs.map((t) => t.id)];
  const at = Math.max(0, ids.indexOf(app.active));
  setActive(ids[(at + step + ids.length) % ids.length]);
}

/** A built-in (by id or name) or user theme (by name). */
export const findTheme = (key: string) => resolveTheme(key, [...BUILTIN_THEMES, ...app.userThemes]);
let themed: string[] = []; // variables the current theme set on <html>
/** Show `theme` (Select Theme previews with this) without saving it. An unknown one (a user theme file that went
 *  away) looks like System. */
export function applyTheme(theme: Theme = app.theme): void {
  const root = document.documentElement;
  for (const k of themed) root.style.removeProperty(k);
  const t = theme === "system" ? null : findTheme(theme);
  themed = t ? Object.keys(t.variables) : [];
  if (!t) { root.removeAttribute("data-theme"); return; }
  root.dataset.theme = t.theme.kind; // the kind's stylesheet rules (dark syntax colours, ...), then the theme's values
  for (const [k, v] of Object.entries(t.variables)) root.style.setProperty(k, v);
}

/** The user's theme files changed (loaded, edited, removed): re-apply, the current one may be among them. */
export function setUserThemes(list: ThemeDef[]): void {
  app.userThemes = list;
  applyTheme();
}

export function setTheme(theme: Theme): void {
  if (locked("theme")) { applyTheme(); return; } // a preview may be showing
  app.theme = theme;
  applyTheme();
  persist();
}

export function toggleTheme(): void {
  const kind = app.theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : findTheme(app.theme)?.theme.kind;
  const kiwi = app.theme.startsWith("kiwi-");
  setTheme(kind === "dark" ? (kiwi ? "kiwi-light" : "light") : (kiwi ? "kiwi-dark" : "dark"));
}

/** The saved tabs while `init` reopens them: a save meanwhile (settings.json applied at start-up) keeps them
 *  instead of writing the few that have loaded so far. */
let restoring: Recent[] | null = null;

// Tab/theme changes are rare, so save immediately: a debounce would lose them if the app quits right after.
function persist(): void {
  const prefs = {
    theme: app.theme,
    recent: app.recent,
    messages: app.messages,
    ...Object.fromEntries(Object.entries(DIFF_KEYS).map(([k, name]) => [name, app.diff[k as keyof DiffSettings]])),
    ...app.prefs,
    aliases: app.aliases,
    tabs: restoring ?? app.tabs.map((t) => ({ location: t.location, path: t.path })),
    side_bar_layout: app.layout,
    hidden_refs: app.hiddenRefs,
    active: app.active,
    agent_cleanup_at: agentCleanupAt,
  } as Record<string, unknown>;
  for (const [name, hidden] of overridden) prefs[name] = hidden; // settings.json's values stay out of preferences.json
  api.savePrefs(JSON.stringify(prefs)).catch(() => {});
}

export function setActive(id: string): void {
  app.active = id;
  persist();
}

/** Open what the command line asked for (`commitkiwi a b`): a tab per repository, problems in the banner. */
async function openFromCli(): Promise<void> {
  const { open, errors } = await api.cliTake();
  for (const p of open) {
    await openRepo("local", p).catch((e) => errors.push(/not a git repository/i.test(String(e)) ? `Not a git repository: ${p}` : `${p}: ${e}`));
  }
  if (errors.length) app.notice = errors.join(" · ");
}

/** What settings.json can set, with a one-line note each (the example file lists them all with their defaults). */
const SETTING_NOTES: Record<string, string> = {
  theme: `"system" (Light/Dark by the OS), "light", "dark", "kiwi-light", "kiwi-dark" or a theme file's name`,
  side_bar_layout: LAYOUTS.map((l) => `"${l.value}"`).join(", "),
  diff_style: `"split" (side by side) or "unified"`, diff_context_lines: "lines of context around each change",
  ignore_diff_white_space: "hide whitespace-only changes", word_diff: "highlight the changed words",
  diff_syntax_colors: "syntax colours in diffs", word_wrap: "wrap long lines in unified diffs",
  editor_command: "Open in Editor; {path} is filled in, no shell", editor_command_remote: "the same for remote repositories; {host} too",
  ui_font_size: "interface size in px (13 = 100%)", font_size: "diff and file text in px",
  expand_merge_commits_by_default: "merges start expanded in the commit graph", terminal_command: "Open in Terminal; {path} is the folder",
  confirm_destructive: "ask before discarding, hard resets, force pushes, drops", agent_cleanup_days: "remove remote agents unused this long (0: never)",
  commit_model: "commit message model id (empty: the first downloaded)", commit_suggest: "suggest commit messages in the empty box",
  natural_search: "the search bar takes a sentence for the local model (the ✨ toggle)",
  forge_hosts: `self-hosted forges, e.g. { "git.example.com": "gitlab" }`, gh_path: "path to gh (empty: search PATH)", glab_path: "path to glab (empty: search PATH)",
  open_request_after_create: "open a new pull/merge request in the browser", keymap_preset: `"default" or "sublime-style"; keymap.json goes on top`,
  cleanup_stale_days: "Clean Up Branches: stale after this many days without a commit (0: off)",
  cleanup_protected_branches: "Clean Up Branches never offers these (* matches anything, e.g. release/*)",
};
/** settings.json's first content: every setting commented out, with its default and a note. */
export function settingsExample(): string {
  const defaults: Record<string, unknown> = {
    theme: "system", side_bar_layout: "locations_as_column",
    ...Object.fromEntries(Object.entries(DIFF_KEYS).map(([k, name]) => [name, DIFF_DEFAULTS[k as keyof DiffSettings]])), ...PREF_DEFAULTS,
  };
  const lines = Object.entries(defaults).map(([k, v]) => `\t// ${SETTING_NOTES[k] ?? ""}\n\t// ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  return `{\n\t// Preferences set here win over the Preferences window, which then shows them read-only. Remove the // in\n\t// front of a line to set it; the values shown are the defaults. Saved changes apply when the window gets focus.\n${lines.join("\n")}\n}\n`;
}

let markLoaded = () => {};
/** Resolves once the saved preferences are applied (settings.json goes on top of them, so it waits for this). */
export const prefsLoaded = new Promise<void>((r) => { markLoaded = r; });

export async function init(): Promise<void> {
  const p = await api.loadPrefs();
  if (typeof p.theme === "string" && p.theme) app.theme = p.theme; // a user theme may load later
  applyTheme();
  if (p.diff && typeof p.diff === "object") Object.assign(app.diff, DIFF_DEFAULTS, p.diff); // before M7: one `diff` object
  for (const [k, name] of Object.entries(DIFF_KEYS) as [keyof DiffSettings, string][]) {
    if (typeof p[name] === typeof DIFF_DEFAULTS[k]) (app.diff as unknown as Record<string, unknown>)[k] = p[name];
  }
  for (const k of Object.keys(PREF_DEFAULTS) as (keyof Prefs)[]) {
    if (validPref(k, p[k])) (app.prefs as unknown as Record<string, unknown>)[k] = p[k];
  }
  // only well-formed entries survive a hand-edited file
  app.prefs.forge_hosts = Object.fromEntries(Object.entries(p.forge_hosts && typeof p.forge_hosts === "object" ? p.forge_hosts : {})
    .filter(([, v]) => v === "github" || v === "gitlab")) as Prefs["forge_hosts"];
  if (p.agent_cleanup_at && typeof p.agent_cleanup_at === "object") {
    for (const [h, t] of Object.entries(p.agent_cleanup_at)) if (typeof t === "number") agentCleanupAt[h] = t;
  }
  if (app.diff.mode !== "unified") app.diff.mode = "split";
  applyPrefs();
  if (p.aliases && typeof p.aliases === "object") {
    for (const [id, a] of Object.entries(p.aliases)) if (typeof a === "string" && a) app.aliases[id] = a;
  }
  if (Array.isArray(p.messages)) app.messages = p.messages.filter((m: unknown) => typeof m === "string").slice(0, 20);
  if (LAYOUTS.some((l) => l.value === p.side_bar_layout)) app.layout = p.side_bar_layout;
  if (p.hidden_refs && typeof p.hidden_refs === "object") {
    for (const [id, refs] of Object.entries(p.hidden_refs)) {
      if (Array.isArray(refs)) app.hiddenRefs[id] = refs.filter((r): r is string => typeof r === "string" && r.startsWith("refs/"));
    }
  }
  if (Array.isArray(p.recent)) app.recent = p.recent.filter((r: Recent) => r?.location && r?.path).slice(0, RECENT_MAX);
  const wanted: (Recent & { alias?: unknown })[] = Array.isArray(p.tabs) ? p.tabs.filter((t: Recent) => t?.location && t?.path) : [];
  restoring = wanted.map((t) => ({ location: t.location, path: t.path }));
  app.ready = true; // show the UI now; tabs fill in as their repos answer
  markLoaded();

  const results = await Promise.allSettled(wanted.map(async (t) => {
    const tab = await loadTab(t.location, t.path);
    if (typeof t.alias === "string" && t.alias && !app.aliases[tab.id]) app.aliases[tab.id] = tab.alias = t.alias; // before M7: aliases lived on tabs
    return tab;
  }));
  listen();
  for (const r of results) {
    if (r.status === "fulfilled" && !app.tabs.some((t) => t.id === r.value.id)) { app.tabs.push(r.value); watchTab(app.tabs[app.tabs.length - 1]); }
  }
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed) app.notice = `Could not reopen ${failed} tab${failed > 1 ? "s" : ""} (repo moved or host unreachable).`;
  if (app.tabs.some((t) => t.id === p.active)) app.active = p.active;
  else if (app.active === "locations" && app.tabs.length) app.active = app.tabs[0].id;
  restoring = null;
  persist(); // the reopened tabs in their order, plus any opened meanwhile
  void api.onCliOpen(() => void openFromCli());
  await openFromCli();
}
