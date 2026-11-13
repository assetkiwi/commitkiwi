import { api } from "./api";
import type { ModelInfo } from "./types";
import { deleteModel, downloadModel, llm, refreshModels, sizeLabel } from "./llm.svelte";
import { copy } from "./clipboard";
import { cancelJob, runGit } from "./jobs.svelte";
import { hasCommand, registerCommand, registeredCommands, runCommand } from "./commands";
import { KEYMAP_FILE, currentKeymap, loadKeymap, platform } from "./keys.svelte";
import { prettyKeys } from "./keymap";
import { DEFAULT_PALETTE, paletteItems } from "./palette";
import { COMMANDS_FILE, SETTINGS_FILE, loadUserConfig, userCommands } from "./userConfig";
import { BUILTIN_THEMES, app, applyTheme, closeTab, cycleTab, getPreference, hostOf, moveTab, openRepo, restoreTab, selectTab, setActive, setAlias, setDiff, setPreference, setTheme, settingsExample, toggleTheme, type Tab, type Theme } from "./state.svelte";
import { closePreferences, hideOverlay, showAddRepos, showOverlay, showPreferences, ui, type OverlayItem } from "./ui.svelte";

const fail = (e: unknown) => { app.notice = String(e); };

function showPalette(): void {
  const km = currentKeymap();
  const keysFor = (command: string, args: Record<string, unknown>) => { const k = km.bindingFor(command, args)?.keys; return k && prettyKeys(k, platform); };
  const items: OverlayItem[] = paletteItems(DEFAULT_PALETTE, userCommands(), registeredCommands(), hasCommand, keysFor)
    .map((p) => ({ label: p.label, detail: p.detail, value: p }));
  showOverlay({
    placeholder: "Type a command",
    items,
    pick: (item) => { hideOverlay(); const p = item.value as { command: string; args: Record<string, unknown> }; runCommand(p.command, p.args); },
  });
}

// New Tab page jobs run in the console under this key (no repository tab exists yet)
const SETUP = (location: string) => ({ id: "locations", location });

/** `git init` in `path` as a console job, then open it in a tab (and the recent list). */
export async function initRepo(location: string, path: string): Promise<void> {
  const r = (await runGit(SETUP(location), `git init ${path}`, { Init: { path } })) as { Text: string };
  await openRepo(location, r.Text);
}
/** `git clone` into `parent` (`name`: the folder, else git's pick) as a console job (cancellable), then open it. */
export async function cloneRepo(location: string, url: string, parent: string, name: string | null): Promise<void> {
  const r = (await runGit(SETUP(location), `git clone --progress -- ${url}${name ? ` ${name}` : ""}`, { Clone: { url, parent, name } })) as { Text: string };
  await openRepo(location, r.Text);
}

/** New Repository: pick a folder (desktop app), init it, open it; else the New Tab page's form. */
async function promptNewRepository(): Promise<void> {
  const dir = await api.pickDir();
  if (dir) await initRepo("local", dir);
  else setActive("locations");
}
/** Clone Repository…: the New Tab page, with the URL field focused. */
function displayClonePage(): void {
  setActive("locations");
  requestAnimationFrame(() => document.getElementById("clone-url")?.focus());
}
/** Open the configuration folder (keymap, commands, settings, menu and theme files); example files are created
 *  first where missing. */
async function browsePackages(): Promise<void> {
  const file = await api.ensureConfig(SETTINGS_FILE, settingsExample());
  if (!file) { app.notice = "The configuration folder exists in the desktop app only (this is the browser preview)."; return; }
  for (const n of [KEYMAP_FILE, COMMANDS_FILE, "Main.menu.json"]) await api.ensureConfig(n);
  await api.openEditor(platform === "mac" ? "open {path}" : "xdg-open {path}", file.slice(0, file.lastIndexOf("/")), "");
}

/** The optional commit message model: pick one, confirm what it costs, download it (progress shows at the bottom). */
async function downloadCommitModel(): Promise<void> {
  await refreshModels();
  if (llm.progress) { app.notice = `${llm.progress.name} is still downloading.`; return; }
  const todo = llm.models.filter((m) => !m.installed);
  if (!todo.length) { app.notice = "Every commit message model is downloaded already."; return; }
  showOverlay({
    placeholder: "Download a commit message model",
    items: todo.map((m) => ({ label: m.name, detail: `${sizeLabel(m.bytes)} · ${m.note}`, value: m })),
    pick: (item) => {
      const m = item.value as ModelInfo;
      return {
        placeholder: `Download ${sizeLabel(m.bytes)} from huggingface.co? The model then runs on this computer only.`,
        pills: [m.name],
        items: [{ label: "Download", value: true }, { label: "Cancel" }],
        pick: (a) => { hideOverlay(); if (a.value) void downloadModel(m); },
      };
    },
  });
}
async function deleteCommitModel(): Promise<void> {
  await refreshModels();
  const have = llm.models.filter((m) => m.installed);
  if (!have.length) { app.notice = "No commit message model is downloaded."; return; }
  showOverlay({
    placeholder: "Delete a downloaded commit message model",
    items: have.map((m) => ({ label: m.name, detail: sizeLabel(m.bytes), value: m })),
    pick: (item) => {
      const m = item.value as ModelInfo;
      return {
        placeholder: `Delete ${m.name} (${sizeLabel(m.bytes)})? You can download it again later.`,
        pills: [m.name],
        items: [{ label: "Delete", value: true }, { label: "Cancel" }],
        pick: (a) => { hideOverlay(); if (a.value) void deleteModel(m); },
      };
    },
  });
}

function switchRepository(): void {
  const open = app.tabs.map((t) => ({ label: t.info.name, detail: t.path, value: { tab: t.id } }));
  const openPaths = new Set(app.tabs.map((t) => `${t.location}|${t.path}`));
  const recent = app.recent
    .filter((r) => !openPaths.has(`${r.location}|${r.path}`))
    .map((r) => ({ label: r.path.split("/").pop() || r.path, detail: r.path, value: { recent: r } }));
  showOverlay({
    placeholder: "Switch to repository",
    items: [...open, ...recent],
    pick: (item) => {
      hideOverlay();
      const v = item.value as { tab?: string; recent?: { location: string; path: string } };
      if (v.tab) setActive(v.tab);
      // in the shown repository's tab (Sublime Merge does the same); from the New Tab page or Dashboard: a new tab
      else if (v.recent) openRepo(v.recent.location, v.recent.path, app.active).catch(fail);
    },
  });
}

function promptAlias(t: Tab): void {
  showOverlay({
    placeholder: "Alias (empty for the repository name)", pills: ["Set Alias"], items: [], text: true, value: t.alias || t.info.name,
    pick: (item) => { hideOverlay(); setAlias(t, item.label === t.info.name ? "" : item.label); },
  });
}
/** A tab by `index` (a repository tab's position; -1 = the active one) */
const tabAt = (a: Record<string, unknown>): Tab | undefined =>
  typeof a.index === "number" ? (a.index < 0 ? app.tabs.find((t) => t.id === app.active) : app.tabs[a.index]) : undefined;

/** Every theme to pick: Kiwi, the user's files, then the plain Light/Dark and System (last, so Up from System
 *  reaches Dark then Light). */
export const themeChoices = (): { value: Theme; label: string; detail: string }[] => [
  ...BUILTIN_THEMES.filter((t) => t.id.startsWith("kiwi-")).map((t) => ({ value: t.id, label: t.name, detail: `green, ${t.kind}` })),
  ...app.userThemes.map((t) => ({ value: t.id, label: t.name, detail: `your theme file (${t.kind})` })),
  { value: "light", label: "Light", detail: "white and grey" },
  { value: "dark", label: "Dark", detail: "dark grey" },
  { value: "system", label: "System", detail: "Light or Dark, following the OS setting" },
];
/** Select Theme: moving through the list previews; Escape goes back to the saved theme. */
function selectTheme(): void {
  const choices = themeChoices();
  showOverlay({
    placeholder: "Select Theme",
    items: choices.map((t) => ({ label: t.label, detail: t.detail, value: t.value })),
    selected: Math.max(0, choices.findIndex((t) => t.value === app.theme)),
    preview: (item) => applyTheme((item?.value as Theme | undefined) ?? app.theme),
    pick: (item) => { setTheme(item.value as Theme); },
  });
}

async function editConfig(name: string, example?: string): Promise<void> {
  const path = await api.ensureConfig(name, example);
  if (!path) { app.notice = `Editing ${name} needs the desktop app (this is the browser preview).`; return; }
  await api.openEditor(app.diff.editorLocal, path, "");
}

/** Import from Sublime Merge…: its user folder (found, or picked), what would be copied, then a confirmation when
 *  files here would be replaced. Only that folder's key binding, command and menu files are read. */
async function importFromSublimeMerge(): Promise<void> {
  const found = await api.sublimeUserDir();
  const fromDir = async (dir: string) => {
    const plan = await api.importSublime(dir, false, false);
    const todo = plan.filter((i) => i.status !== "skipped");
    if (!todo.length) { hideOverlay(); app.notice = `Nothing to import in ${dir} (no key binding, command or menu files).`; return; }
    const replacing = plan.filter((i) => i.status === "replace");
    const list = plan.map((i) => ({ label: `${i.from} → ${i.to}`, detail: i.status === "replace" ? `replaces yours${i.note ? `; ${i.note}` : ""}` : i.status === "skipped" ? `skipped: ${i.note}` : "new", value: null }));
    const run = async (overwrite: boolean) => {
      hideOverlay();
      const done = await api.importSublime(dir, true, overwrite);
      const got = done.filter((i) => i.status === "imported").map((i) => i.to), kept = done.filter((i) => i.status === "kept").map((i) => i.to);
      app.notice = `Imported from Sublime Merge: ${got.join(", ") || "nothing"}${kept.length ? `; kept yours: ${kept.join(", ")}` : ""}.`;
      await Promise.all([loadKeymap(), loadUserConfig()]);
    };
    return {
      placeholder: `Import from ${dir}`, pills: ["Import from Sublime Merge"],
      items: [
        ...(replacing.length
          ? [{ label: "Import new files, keep mine", detail: `${replacing.length} of yours stay`, value: "keep" }, { label: "Import and replace mine", detail: replacing.map((i) => i.to).join(", "), value: "replace" }]
          : [{ label: "Import", detail: `${todo.length} file${todo.length > 1 ? "s" : ""}`, value: "keep" }]),
        { label: "Cancel", value: "cancel" },
        ...list,
      ],
      pick: (item: OverlayItem) => { if (item.value === "keep" || item.value === "replace") return run(item.value === "replace"); if (item.value === "cancel") hideOverlay(); },
    };
  };
  showOverlay({
    placeholder: "Import key bindings, commands and menus from Sublime Merge's user folder",
    pills: ["Import from Sublime Merge"],
    items: [
      ...(found ? [{ label: "Use the Sublime Merge user folder", detail: found, value: found }] : []),
      { label: "Choose a folder…", detail: "its Packages/User folder", value: "" },
    ],
    pick: async (item) => {
      const dir = (item.value as string) || await api.pickDir();
      if (!dir) { hideOverlay(); return; }
      return fromDir(dir);
    },
  });
}

/** Show Request Timings: the last 100 backend requests with where their time went (palette-style list, filterable). */
async function showRequestTimings(): Promise<void> {
  const on = await api.requestTrace();
  const rows = await api.requestTimings();
  const name = (t: (typeof rows)[number]) => `${t.repo.split("/").filter(Boolean).pop() ?? ""}${hostOf(t.location) ? ` (${hostOf(t.location)})` : ""}`;
  const items: OverlayItem[] = [
    { label: on ? "Turn request timing off" : "Turn request timing on (records from now on)", value: "toggle" },
    ...rows.map((t) => ({
      label: `${t.kind}  ${name(t)}`,
      detail: `${t.total_ms} ms · wait ${t.wait_ms} · call ${t.call_ms} · there ${t.there_ms ?? "?"}${t.ok ? "" : " · failed"}`,
      value: t,
    })),
  ];
  showOverlay({
    placeholder: on ? `Request timings: last ${rows.length} (ms; wait = connection, call = round trip, there = git in the agent/backend)` : "Request timing is off",
    items,
    pick: async (item) => {
      if (item.value === "toggle") { await api.requestTrace(!on); return showRequestTimings(); }
      hideOverlay();
      await copy(`${item.label}  ${item.detail}`);
    },
  });
}

/** Install Command Line Tool…: the `commitkiwi` link; asks before replacing something else at that path. */
async function installCommandLineTool(replace = false): Promise<void> {
  const r = await api.installCli(replace);
  if (r.replace === null) { app.notice = `Installed ${r.path}: run \`commitkiwi [path …]\` in a terminal.${r.note ? ` ${r.note}` : ""}`; return; }
  showOverlay({
    placeholder: `${r.path} already exists (${r.replace})`, pills: ["Install Command Line Tool"],
    items: [{ label: "Replace it", detail: "with a link to commit.kiwi", value: true }, { label: "Cancel", value: false }],
    pick: (item) => { hideOverlay(); if (item.value) installCommandLineTool(true).catch(fail); },
  });
}

/** Help > About commit.kiwi & Licenses…: version, licence, non-affiliation; one item opens the third-party notices. */
async function showAbout(): Promise<void> {
  const version = await api.appVersion();
  showOverlay({
    placeholder: `commit.kiwi ${version}`, pills: ["About"],
    items: [
      { label: "Open Third-Party Licenses", detail: "THIRD-PARTY-LICENSES.md", value: "open" },
      { label: "Licensed under MIT OR Apache-2.0", detail: "LICENSE-MIT, LICENSE-APACHE", value: null },
      { label: "An independent open-source project", detail: "not affiliated with, endorsed by or sponsored by Sublime HQ Pty Ltd", value: null },
    ],
    pick: async (item) => { if (item.value !== "open") return; hideOverlay(); await api.openLicenses(); },
  });
}

/** Commands that work anywhere; views register their own (refresh, navigate_to_head, ...) while they are open. */
export function registerAppCommands(): () => void {
  const offs = [
    registerCommand("hide_overlay", { run: hideOverlay }),
    // a key bound to `show_command_palette` + `{command}` opens that command's prompt directly
    registerCommand("show_command_palette", {
      run: (a) => { if (typeof a.command === "string") runCommand(a.command, (a.args as Record<string, unknown>) ?? {}); else showPalette(); },
    }),
    registerCommand("set_preference", {
      run: (a) => { if (!setPreference(String(a.setting), a.value)) throw new Error(`Unsupported preference: ${String(a.setting)}`); },
    }),
    registerCommand("toggle_preference", {
      run: (a) => {
        const name = String(a.setting);
        if (typeof getPreference(name) !== "boolean" || !setPreference(name, !getPreference(name))) throw new Error(`Not an on/off preference: ${name}`);
      },
    }),
    registerCommand("toggle_ignore_diff_whitespace", { caption: "Ignore Whitespace in Diffs: Toggle", run: () => setDiff({ ignoreWs: !app.diff.ignoreWs }) }),
    registerCommand("open_preferences", { caption: "Preferences…", run: (a) => showPreferences(typeof a.page === "string" ? a.page : undefined) }),
    registerCommand("close_preferences", { run: closePreferences }),
    registerCommand("show_keybindings", { caption: "Preferences: Key Bindings…", run: () => showPreferences("key_bindings") }),
    registerCommand("select_theme", { caption: "Select Theme", run: selectTheme }),
    registerCommand("new_tab", { caption: "New Tab", run: () => setActive("locations") }),
    registerCommand("close", { caption: "Close Tab", run: () => { if (app.active === "dashboard") setActive("locations"); else if (app.active !== "locations") closeTab(app.active); } }),
    // the keyboard way to reorder tabs (the mouse way: drag them)
    registerCommand("move_tab_left", { caption: "Move Tab Left", run: () => moveTab(app.active, app.tabs.findIndex((t) => t.id === app.active) - 1) }),
    registerCommand("move_tab_right", { caption: "Move Tab Right", run: () => moveTab(app.active, app.tabs.findIndex((t) => t.id === app.active) + 1) }),
    registerCommand("show_dashboard", { caption: "Dashboard: Show…", run: () => setActive("dashboard") }),
    registerCommand("close_by_index", { run: (a) => { const t = tabAt(a); if (t) closeTab(t.id); } }),
    registerCommand("set_alias", { run: (a) => { const t = tabAt(a); if (t) promptAlias(t); } }),
    registerCommand("copy_to_clipboard", { run: async (a) => { if (typeof a.text === "string" && !(await copy(a.text))) app.notice = "Could not copy to the clipboard."; } }),
    registerCommand("cancel_job", { run: (a) => { if (typeof a.job === "number") return cancelJob(a.job); } }),
    registerCommand("restore_tab", { caption: "Restore Closed Tab", run: restoreTab }),
    registerCommand("toggle_commit_suggestions", { caption: "Commit Message Suggestions: Toggle", run: () => { const on = !getPreference("commit_suggest"); setPreference("commit_suggest", on); app.notice = on ? "The local model suggests commit messages in the empty message box (Tab takes the suggestion)." : "Commit message suggestions are off."; } }),
    registerCommand("download_commit_model", { caption: "Download Commit Message Model…", run: downloadCommitModel }),
    registerCommand("delete_commit_model", { caption: "Delete Commit Message Model…", run: deleteCommitModel }),
    registerCommand("show_request_timings", { caption: "Show Request Timings", run: showRequestTimings }),
    registerCommand("toggle_request_timings", { caption: "Request Timings: Toggle", run: async () => { app.notice = `Request timing ${(await api.requestTrace(!(await api.requestTrace()))) ? "on: Show Request Timings lists them" : "off"}.`; } }),
    registerCommand("next_tab", { run: () => cycleTab(1) }),
    // Cmd/Ctrl+1..8; 0-based like close_by_index
    registerCommand("select_tab", { run: (a) => { if (typeof a.index === "number") selectTab(a.index); } }),
    // Preferences > Remote has the button; with `host` (or the active remote tab's host) it reinstalls right away
    registerCommand("reinstall_agent", {
      caption: "Reinstall Agent…",
      run: async (a) => {
        const host = typeof a.host === "string" ? a.host : hostOf(app.tabs.find((t) => t.id === app.active)?.location ?? "");
        if (!host) { showPreferences("remote"); return; }
        app.notice = `Agent reinstalled on ${host} (${await api.reinstallAgent(host)}); used from the next connection.`;
      },
    }),
    registerCommand("cleanup_agents", {
      caption: "Clean Up Old Agents…",
      run: async (a) => {
        const host = typeof a.host === "string" ? a.host : hostOf(app.tabs.find((t) => t.id === app.active)?.location ?? "");
        if (!host) { showPreferences("remote"); return; }
        const [n, b] = await api.cleanupAgents(host, typeof a.days === "number" ? a.days : app.prefs.agent_cleanup_days);
        app.notice = `Removed ${n} old agent ${n === 1 ? "file" : "files"} (${b.toLocaleString()} bytes) on ${host}.`;
      },
    }),
    registerCommand("prev_tab", { run: () => cycleTab(-1) }),
    registerCommand("prompt_open_repository", {
      caption: "Repository: Open…",
      run: async () => { const dir = await api.pickDir(); if (dir) await openRepo("local", dir); },
    }),
    registerCommand("prompt_new_repository", { caption: "Repository: New…", run: promptNewRepository }),
    registerCommand("display_clone_page", { caption: "Repository: Clone…", run: displayClonePage }),
    registerCommand("browse_packages", { caption: "Preferences: Open Configuration Folder…", run: browsePackages }),
    registerCommand("edit_settings", { caption: "Preferences: Edit settings.json…", run: () => editConfig(SETTINGS_FILE, settingsExample()) }),
    registerCommand("import_from_sublime_merge", { caption: "Preferences: Import from Sublime Merge…", run: importFromSublimeMerge }),
    registerCommand("add_repositories_from_folder", { caption: "Repository: Add from Folder…", run: showAddRepos }),
    registerCommand("quick_switch_repository", { caption: "Switch Repository…", run: switchRepository }),
    registerCommand("toggle_side_bar", { caption: "View: Toggle Side Bar", run: () => { ui.sidebar = !ui.sidebar; } }),
    registerCommand("toggle_theme", { caption: "View: Toggle Light/Dark Theme", run: toggleTheme }),
    registerCommand("install_command_line_tool", { caption: "Install Command Line Tool (commitkiwi)…", run: () => installCommandLineTool() }),
    registerCommand("uninstall_command_line_tool", { caption: "Uninstall Command Line Tool (commitkiwi)", run: async () => { app.notice = await api.uninstallCli(); } }),
    registerCommand("show_about", { caption: "Help: About commit.kiwi & Licenses…", run: showAbout }),
    registerCommand("edit_key_bindings", { caption: "Preferences: Edit keymap.json…", run: () => editConfig(KEYMAP_FILE) }),
  ];
  return () => offs.forEach((off) => off());
}
