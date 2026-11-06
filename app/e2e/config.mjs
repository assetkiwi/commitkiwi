// Config files against the mock backend (browser preview: the config folder is localStorage `commitkiwi.cfg.<name>`):
// the default keymap's main keys, switching to the sublime-style preset, an older keymap file still honoured,
// settings.json over the Preferences window, theme files (Kiwi built-ins, a user theme, a broken one) and the
// Import from Sublime Merge flow.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, colorScheme: "light" });
const page = await ctx.newPage();
const shots = process.env.SHOTS_DIR;
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("http://127.0.0.1:1420");
const openDemo = async () => {
  await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();
  await page.getByPlaceholder("~/projects/my-repo").fill("/work/demo-repo");
  await page.getByRole("button", { name: "Open Repository", exact: true }).click();
  await page.locator(".row .rb .s", { hasText: "Move DDEV" }).first().waitFor();
};
await openDemo();

const prefs = () => page.evaluate(() => JSON.parse(localStorage.getItem("commitkiwi.prefs") || "{}"));
const setCfg = (name, text) => page.evaluate(([n, t]) => { if (t === null) localStorage.removeItem(`commitkiwi.cfg.${n}`); else localStorage.setItem(`commitkiwi.cfg.${n}`, t); }, [name, text]);
const cfg = (name) => page.evaluate((n) => localStorage.getItem(`commitkiwi.cfg.${n}`), name);
const refocus = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
const overlay = page.locator(".overlay");
const placeholder = () => page.locator(".overlay input").getAttribute("placeholder");
const escape = async () => { await page.keyboard.press("Escape"); await overlay.waitFor({ state: "detached" }); };
const sidebar = () => page.locator(".tabview:not(.off) button[aria-label='Toggle side bar']").getAttribute("aria-pressed");
const css = (v) => page.evaluate((v) => document.documentElement.style.getPropertyValue(v), v);
const dataTheme = () => page.evaluate(() => document.documentElement.dataset.theme ?? "system");
const dialog = page.getByRole("dialog", { name: "Preferences" });
const nav = (name) => dialog.getByRole("navigation").getByRole("button", { name, exact: true });
const menuDetail = async (menu, item) => {
  await page.locator(".menubar button", { hasText: menu }).click();
  const row = page.locator(".popup button", { has: page.locator(".l", { hasText: new RegExp(`^${item}$`) }) }).first();
  await row.waitFor();
  const d = await row.locator(".d").count() ? (await row.locator(".d").innerText()).trim() : "";
  await page.keyboard.press("Escape");
  await page.locator(".popup").waitFor({ state: "detached" });
  return d;
};
async function palette(caption) {
  await page.keyboard.press("Meta+Shift+p");
  await page.locator(".overlay input").fill(caption);
  await page.locator(".overlay li.on .l", { hasText: caption }).waitFor();
  await page.keyboard.press("Enter");
}

// ================= the default keymap =================
assert.equal((await prefs()).keymap_preset ?? "default", "default");
await page.keyboard.press("Meta+Shift+p");
assert.equal(await placeholder(), "Type a command", "⇧⌘P: command palette");
await escape();
await page.keyboard.press("Meta+p");
assert.equal(await placeholder(), "Switch to repository", "⌘P: switch repository");
await escape();
assert.equal(await sidebar(), "true");
await page.keyboard.press("Meta+b");
assert.equal(await sidebar(), "false", "⌘B: side bar");
await page.keyboard.press("Meta+b");
assert.equal(await sidebar(), "true");
await page.keyboard.press("Meta+Shift+c");
assert.equal(await placeholder(), "Branch or Tag Name", "⇧⌘C: check out a branch");
await escape();
await page.keyboard.press("Meta+,");
await dialog.waitFor();
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
assert.equal(await menuDetail("View", "Toggle Side Bar"), "⌘B");
assert.equal(await menuDetail("View", "Command Palette…"), "⇧⌘P");
assert.equal(await menuDetail("Changes", "Commit Staged Changes"), "⌘↵");
await page.keyboard.press("Meta+w");
await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();
await page.keyboard.press("Meta+Shift+t");
await page.locator(".tab.on .tab-main", { hasText: "demo-repo" }).waitFor();

// ================= switching the preset (live, saved) =================
await page.keyboard.press("Meta+,");
await nav("Key Bindings").click();
const presetSel = dialog.getByLabel("Key binding preset");
await presetSel.selectOption("sublime-style");
await page.waitForFunction(() => JSON.parse(localStorage.getItem("commitkiwi.prefs")).keymap_preset === "sublime-style");
await dialog.getByLabel("Search key bindings").fill("toggle side bar");
await dialog.locator("li[data-command=toggle_side_bar] .kb-key", { hasText: "⌘K ⌘B" }).waitFor(); // the editor shows the preset's keys
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
assert.equal(await menuDetail("View", "Toggle Side Bar"), "⌘K ⌘B");
await page.keyboard.press("Meta+p");
assert.equal(await placeholder(), "Type a command", "sublime-style: ⌘P is the palette");
await escape();
await page.keyboard.press("Meta+,");
await nav("Key Bindings").click();
await presetSel.selectOption("default");
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
assert.equal(await menuDetail("View", "Toggle Side Bar"), "⌘B");

// ================= an older keymap file is honoured until keymap.json exists =================
await setCfg("Default.sublime-keymap", `[{ "keys": ["super+shift+x"], "command": "toggle_side_bar" }]`);
await refocus();
await page.waitForFunction(() => true);
await page.keyboard.press("Meta+Shift+x");
await page.waitForFunction(() => document.querySelector(".tabview:not(.off) button[aria-label='Toggle side bar']")?.getAttribute("aria-pressed") === "false");
await page.keyboard.press("Meta+Shift+x");
await setCfg("keymap.json", "[]");
await refocus();
await page.waitForTimeout(200);
await page.keyboard.press("Meta+Shift+x");
await page.waitForTimeout(200);
assert.equal(await sidebar(), "true", "keymap.json exists: the older file is no longer read");
await setCfg("keymap.json", null);
await setCfg("Default.sublime-keymap", null);
await refocus();

// ================= settings.json =================
const before = await prefs();
await setCfg("settings.json", `{
  // mine
  "theme": "kiwi-dark",
  "font_size": 16,
  "keymap_preset": "sublime-style",
  "bogus_setting": 1,
}`);
await refocus();
await page.waitForFunction(() => document.documentElement.dataset.theme === "dark" && document.documentElement.style.getPropertyValue("--bg") === "#0c0f09");
assert.equal(await css("--diff-size"), "16px");
await page.locator(".banner", { hasText: "bogus_setting" }).waitFor();
await page.keyboard.press("Meta+p");
assert.equal(await placeholder(), "Type a command", "settings.json chose the sublime-style preset");
await escape();
// preferences.json keeps the UI's own values
let p = await prefs();
assert.deepEqual([p.theme, p.font_size, p.keymap_preset], [before.theme, before.font_size, before.keymap_preset]);
// read-only in Preferences, and the UI cannot change them
await page.keyboard.press("Meta+,");
await dialog.waitFor();
await nav("Appearance").click();
assert.ok(await dialog.getByRole("radio", { name: "Light" }).isDisabled());
assert.ok(await dialog.getByLabel("Diff font size").isDisabled());
assert.ok(await dialog.locator(".from-file", { hasText: "set in settings.json" }).count() >= 2);
await dialog.getByLabel("UI font size").selectOption("15"); // not in settings.json: still editable
await page.waitForFunction(() => JSON.parse(localStorage.getItem("commitkiwi.prefs")).ui_font_size === 15);
await dialog.getByRole("button", { name: "Reset to Defaults" }).click();
assert.equal(await dataTheme(), "dark", "Reset leaves settings.json's theme alone");
if (shots) await page.screenshot({ path: `${shots}/config-settings.png` });
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
// removing a key gives the UI's value back
await setCfg("settings.json", `{ "font_size": 14 }`);
await refocus();
await page.waitForFunction(() => document.documentElement.dataset.theme === undefined && document.documentElement.style.getPropertyValue("--bg") === "");
assert.equal(await css("--diff-size"), "14px");
await page.keyboard.press("Meta+p");
assert.equal(await placeholder(), "Switch to repository", "back to the default preset");
await escape();
await setCfg("settings.json", null);
await refocus();
await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--diff-size") === "12px");

// ================= themes =================
// the Kiwi themes from Preferences, then back to Light (the stylesheet's own look, no variables)
await page.keyboard.press("Meta+,");
await dialog.waitFor();
await dialog.getByLabel("Other themes").selectOption("kiwi-light");
assert.equal(await dataTheme(), "light");
assert.equal(await css("--bg"), "#f8fbf4");
assert.equal(await css("--primary-bg"), "#f59e0b");
assert.match(await page.evaluate(() => getComputedStyle(document.getElementById("app")).fontFamily), /^Figtree/);
if (shots) await page.screenshot({ path: `${shots}/config-kiwi-light.png` });
assert.equal((await prefs()).theme, "kiwi-light");
await dialog.getByRole("radio", { name: "Light" }).click();
assert.equal(await css("--bg"), "");
assert.equal(await dataTheme(), "light");
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
// user theme files: one good (extends Kiwi Dark), one broken (reported, left out)
await setCfg("themes/moss.theme.json", `{
  // a comment
  "name": "Moss", "kind": "dark", "extends": "Kiwi Dark",
  "variables": { "--accent": "#70a040" },
}`);
await setCfg("themes/broken.theme.json", `{ "name": "Broken", "kind": "purple" }`);
await refocus();
await page.locator(".banner", { hasText: "themes/broken.theme.json" }).waitFor();
await palette("View: Select Theme…");
await page.getByRole("dialog", { name: "Select Theme" }).waitFor();
const labels = await page.locator(".overlay li .l").allInnerTexts();
assert.deepEqual(labels.map((l) => l.trim()), ["Kiwi Light", "Kiwi Dark", "Moss", "Light", "Dark", "System"]);
await page.keyboard.press("ArrowDown"); // Light (selected) -> Dark: preview
assert.equal(await dataTheme(), "dark");
await page.keyboard.press("ArrowUp"); await page.keyboard.press("ArrowUp"); // Moss
assert.equal(await css("--accent"), "#70a040");
assert.equal(await css("--bg"), "#0c0f09", "extends Kiwi Dark");
if (shots) await page.screenshot({ path: `${shots}/config-user-theme.png` });
await page.keyboard.press("Enter");
assert.equal((await prefs()).theme, "Moss");
// the file goes away: the look falls back to System, the pref stays
await setCfg("themes/moss.theme.json", null);
await setCfg("themes/broken.theme.json", null);
await refocus();
await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--accent") === "");
assert.equal(await dataTheme(), "system");
await page.evaluate(() => { document.querySelector(".banner .ib")?.click(); });

// ================= Import from Sublime Merge =================
const SUB = "/home/user/.config/sublime-merge/Packages/User";
await page.evaluate((dir) => {
  globalThis.__mockSublimeDir = dir;
  globalThis.__mockSublimeFiles = {
    "Default (OSX).sublime-keymap": `[{ "keys": ["super+shift+y"], "command": "toggle_side_bar" }]`,
    "Default.sublime-keymap": "[]",
    "Default.sublime-commands": `[{ "caption": "Imported: Garbage Collect", "command": "git", "args": { "argv": ["gc"] } }]`,
    "Branch.sublime-menu": "[]",
  };
}, SUB);
await setCfg("commands.json", "[]"); // one of ours exists: asked before replacing
await refocus();
await palette("Preferences: Import from Sublime Merge…");
await page.locator(".overlay li.on .d", { hasText: SUB }).waitFor();
await page.keyboard.press("Enter");
await page.locator(".overlay li .l", { hasText: "Default (OSX).sublime-keymap → keymap.json" }).waitFor();
const rows = (await page.locator(".overlay li").allInnerTexts()).map((r) => r.replace(/\s+/g, " ").trim());
assert.ok(rows.some((r) => r.startsWith("Default.sublime-keymap → keymap.json skipped")), rows.join("\n"));
assert.ok(rows.some((r) => r.startsWith("Default.sublime-commands → commands.json replaces yours")), rows.join("\n"));
// keep mine first: new files only
await page.locator(".overlay li.on .l", { hasText: "Import new files, keep mine" }).waitFor();
await page.keyboard.press("Enter");
await page.locator(".banner", { hasText: "Imported from Sublime Merge: keymap.json, Branch.menu.json; kept yours: commands.json" }).waitFor();
assert.equal(await cfg("commands.json"), "[]");
assert.match(await cfg("keymap.json"), /^\/\/ Imported from Sublime Merge \(Default \(OSX\)\.sublime-keymap\)\.\n/);
await page.keyboard.press("Meta+Shift+y");
await page.waitForFunction(() => document.querySelector(".tabview:not(.off) button[aria-label='Toggle side bar']")?.getAttribute("aria-pressed") === "false");
await page.keyboard.press("Meta+Shift+y");
// again, replacing mine
await palette("Preferences: Import from Sublime Merge…");
await page.locator(".overlay li.on .d", { hasText: SUB }).waitFor();
await page.keyboard.press("Enter");
await page.locator(".overlay li .l", { hasText: "Import and replace mine" }).waitFor();
await page.keyboard.press("ArrowDown");
await page.locator(".overlay li.on .l", { hasText: "Import and replace mine" }).waitFor();
await page.keyboard.press("Enter");
await page.locator(".banner", { hasText: "Imported from Sublime Merge: keymap.json, commands.json, Branch.menu.json." }).waitFor();
assert.match(await cfg("commands.json"), /Imported: Garbage Collect/);
await page.keyboard.press("Meta+Shift+p");
await page.locator(".overlay input").fill("Imported: Garbage");
await page.locator(".overlay li.on .l", { hasText: "Imported: Garbage Collect" }).waitFor();
await escape();
// no Sublime Merge here: only the folder picker (none in the browser), nothing written
await page.evaluate(() => { globalThis.__mockSublimeDir = null; });
await palette("Preferences: Import from Sublime Merge…");
await page.locator(".overlay li .l", { hasText: "Choose a folder…" }).waitFor();
assert.deepEqual((await page.locator(".overlay li .l").allInnerTexts()).map((l) => l.trim()), ["Choose a folder…"]);
await page.keyboard.press("Enter");
await overlay.waitFor({ state: "detached" });

// ================= Help > About commit.kiwi & Licenses… =================
await palette("Help: About commit.kiwi & Licenses…");
assert.equal(await placeholder(), "commit.kiwi 0.1.0 (browser preview)");
assert.deepEqual((await page.locator(".overlay li .l").allInnerTexts()).map((l) => l.trim()),
  ["Open Third-Party Licenses", "Licensed under MIT OR Apache-2.0", "An independent open-source project"]);
await page.keyboard.press("Enter");
await overlay.waitFor({ state: "detached" });
assert.equal(await page.evaluate(() => globalThis.__mockLicensesOpened), 1);

assert.deepEqual(errors, []);
await browser.close();
console.log("config e2e ok");
