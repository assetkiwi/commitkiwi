// M7: the Preferences window and the key bindings editor, against the Vite dev server (mock backend).
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { sublimeStyle } from "./preset.mjs";

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 } });
const page = await ctx.newPage();
await sublimeStyle(page);
const shots = process.env.SHOTS_DIR;
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("http://127.0.0.1:1420");
await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();
const openDemo = async () => {
  await page.getByPlaceholder("~/projects/my-repo").fill("/work/demo-repo");
  await page.getByRole("button", { name: "Open Repository", exact: true }).click();
  await page.locator(".row .rb .s", { hasText: "Move DDEV" }).first().waitFor();
};
await openDemo();

const prefs = () => page.evaluate(() => JSON.parse(localStorage.getItem("commitkiwi.prefs")));
const keymapFile = () => page.evaluate(() => localStorage.getItem("commitkiwi.cfg.keymap.json") ?? "");
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

// ---- ⌘, opens it; the Preferences menu has the entries
assert.equal(await menuDetail("Preferences", "Preferences…"), "⌘,");
await page.keyboard.press("Meta+,");
await dialog.waitFor();
assert.equal(await nav("Appearance").getAttribute("aria-current"), "page");

// ---- Appearance: theme, font sizes apply live and persist under their names
await dialog.getByRole("radio", { name: "Dark" }).click();
assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
await dialog.getByLabel("Diff font size").selectOption("16");
assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--diff-size")), "16px");
await dialog.getByLabel("UI font size").selectOption("15");
assert.equal((+(await page.evaluate(() => document.documentElement.style.zoom))).toFixed(3), (15 / 13).toFixed(3));
let p = await prefs();
assert.deepEqual([p.theme, p.font_size, p.ui_font_size], ["dark", 16, 15]);
if (shots) await page.screenshot({ path: `${shots}/m7-appearance.png` });
await dialog.getByRole("button", { name: "Reset to Defaults" }).click();
p = await prefs();
assert.deepEqual([p.theme, p.font_size, p.ui_font_size], ["system", 12, 13]);
assert.equal(await page.evaluate(() => document.documentElement.style.zoom), "");
// the Kiwi themes sit next to Light/Dark/System; picking one applies its variables, System drops them again
assert.deepEqual(await dialog.getByLabel("Other themes").locator("option").allInnerTexts(), ["More themes…", "Kiwi Light", "Kiwi Dark"]);
await dialog.getByLabel("Other themes").selectOption("kiwi-dark");
assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--surface")), "#121610");
assert.equal((await prefs()).theme, "kiwi-dark");
assert.equal(await dialog.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked"), "false");
if (shots) await page.screenshot({ path: `${shots}/m7-kiwi-dark.png` });
await dialog.getByRole("radio", { name: "System" }).click();
assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--surface")), "");
assert.equal((await prefs()).theme, "system");

// ---- Diff: shares state with the diff toolbar; wrap and context apply to the open diff
await nav("Diff").click();
await dialog.getByRole("radio", { name: "Unified" }).click();
await dialog.getByLabel("Context lines").selectOption("0");
await dialog.getByText("Wrap long lines in unified diffs").click();
p = await prefs();
assert.deepEqual([p.diff_style, p.diff_context_lines, p.word_wrap], ["unified", 0, true]);
assert.equal(p.diff, undefined, "the old nested diff object is gone");
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
await page.locator(".dtool [role=tab]", { hasText: "Unified" }).first().waitFor();
assert.equal(await page.locator(".dtool [role=tab]", { hasText: "Unified" }).first().getAttribute("aria-selected"), "true", "toolbar shows the same state");
await page.locator(".diff.wrap .ln").first().waitFor();
assert.equal(await page.locator(".sp").count(), 0, "no split rows");
await page.locator(".dtool [role=tab]", { hasText: "Split" }).first().click();
assert.equal((await prefs()).diff_style, "split", "toolbar writes the same setting");

// ---- Expand merge commits by default: off -> a freshly loaded repo starts with merges collapsed
await page.keyboard.press("Meta+,");
await nav("Diff").click();
await dialog.getByText("Expand merge commits by default").click();
assert.equal((await prefs()).expand_merge_commits_by_default, false);
await dialog.getByRole("button", { name: "Reset to Defaults" }).click();
p = await prefs();
assert.deepEqual([p.diff_style, p.diff_context_lines, p.word_wrap, p.expand_merge_commits_by_default], ["split", 3, false, true]);
await dialog.getByText("Expand merge commits by default").click();
await page.keyboard.press("Escape");
await page.keyboard.press("Meta+w");
await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();
await openDemo();
await page.locator("#row-0 path.plus").waitFor({ state: "attached" });
assert.equal(await page.locator("#row-1").count(), 0, "the merge's side rows are hidden");
await page.keyboard.press("Meta+,");
await nav("Diff").click();
await dialog.getByText("Expand merge commits by default").click();

// ---- Repositories: alias edit renames the open tab; hidden refs reset; Add Repositories opens the dialog
await nav("Repositories").click();
const alias = dialog.getByLabel("Alias for /work/demo-repo");
await alias.fill("Demo");
await alias.press("Tab");
await page.locator(".tab.on .tab-main", { hasText: "Demo" }).waitFor();
assert.equal((await prefs()).aliases["local|/work/demo-repo"], "Demo");
await alias.fill("");
await alias.press("Tab");
await page.locator(".tab.on .tab-main", { hasText: "demo-repo" }).waitFor();
await dialog.getByRole("button", { name: "Add Repositories from Folder…" }).click();
await page.getByRole("dialog", { name: "Add Repositories from Folder" }).waitFor();
await page.keyboard.press("Escape");
await page.getByRole("dialog", { name: "Add Repositories from Folder" }).waitFor({ state: "detached" });
await dialog.waitFor();

// ---- Git: identity through the SetIdentity job; editor/terminal commands; confirm toggle
await nav("Git").click();
await page.waitForFunction(() => document.querySelector(".prefs input[autocomplete=off]")?.value === "Jane Doe"); // read from git config
await dialog.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
await dialog.getByLabel("Email", { exact: true }).fill("ada@example.com");
await dialog.getByRole("button", { name: "Save Identity" }).click();
await page.waitForFunction(() => globalThis.__mockCalls.some((c) => c.SetIdentity?.name === "Ada Lovelace" && c.SetIdentity.email === "ada@example.com"));
await dialog.getByLabel("Terminal", { exact: true }).fill("kitty --directory {path}");
await dialog.getByLabel("Terminal", { exact: true }).press("Tab");
assert.equal((await prefs()).terminal_command, "kitty --directory {path}");
await dialog.getByRole("button", { name: "Reset to Defaults" }).click();
assert.equal((await prefs()).terminal_command, "open -a Terminal {path}");
// Command line: install (asks before replacing another `commitkiwi`), uninstall
await page.evaluate(() => { globalThis.__mockCliInstalls = []; globalThis.__mockCliExisting = "/opt/other/commitkiwi"; });
await dialog.getByRole("button", { name: "Install Command Line Tool…" }).click();
const ask = page.getByRole("dialog", { name: /already exists/ });
await ask.waitFor();
await ask.getByText("Cancel", { exact: true }).click();
await ask.waitFor({ state: "detached" });
assert.deepEqual(await page.evaluate(() => globalThis.__mockCliInstalls), [], "cancel installs nothing");
await dialog.getByRole("button", { name: "Install Command Line Tool…" }).click();
await ask.getByText("Replace it", { exact: true }).click();
await page.locator(".banner", { hasText: "Installed /usr/local/bin/commitkiwi" }).waitFor();
assert.deepEqual(await page.evaluate(() => globalThis.__mockCliInstalls), [true]);
await dialog.getByRole("button", { name: "Uninstall", exact: true }).click();
await page.locator(".banner", { hasText: "Removed /usr/local/bin/commitkiwi." }).waitFor();
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
assert.equal(await menuDetail("File", "Install Command Line Tool…"), "");
await page.keyboard.press("Meta+,");
await dialog.waitFor();

// ---- Remote: ssh hosts and agent info
await nav("Remote").click();
await dialog.locator(".pf-hosts li", { hasText: "example-host" }).first().waitFor();
await dialog.getByText("~/.cache/commitkiwi/agent-", { exact: false }).first().waitFor();

// ---- Key bindings: record, conflict warning, replace; menu hint and behaviour follow
await nav("Key Bindings").click();
assert.equal(await dialog.getByLabel("Key binding preset").inputValue(), "sublime-style", "these tests run on the compatibility preset");
assert.deepEqual(await dialog.getByLabel("Key binding preset").locator("option").allInnerTexts(), ["commit.kiwi", "Sublime-style (compatibility)"]);
const search = dialog.getByLabel("Search key bindings");
await search.fill("close tab");
const row = dialog.locator("li[data-command=close]");
await row.locator(".kb-key", { hasText: "⌘W" }).waitFor();
assert.equal(await row.locator(".kb-key small").innerText(), "default");
await row.locator(".kb-row").click();
const field = dialog.getByRole("textbox", { name: "Press the new keys" });
await field.waitFor();
assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-keyrecord")), true, "recorder is focused");
await page.keyboard.press("Meta+b");
await dialog.locator(".kb-warn", { hasText: "is already used by Check Out Branch… (⌘B)" }).waitFor();
assert.equal(await page.locator(".overlay").count(), 0, "⌘B was recorded, not run");
await page.keyboard.press("Escape");
await field.waitFor({ state: "detached" });
await dialog.waitFor(); // Esc cancelled the recording only
// a two-step chord that would shadow ⌘K ⌘B
await row.locator(".kb-row").click();
await page.keyboard.press("Meta+k");
await page.keyboard.press("Meta+b");
assert.equal((await field.innerText()).trim(), "⌘K ⌘B");
await dialog.locator(".kb-warn", { hasText: "Toggle Side Bar" }).waitFor();
await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
// ⌘E: free, Replace
await row.locator(".kb-row").click();
await page.keyboard.press("Meta+e");
assert.equal(await dialog.locator(".kb-warn").count(), 0);
await dialog.getByRole("button", { name: "Replace", exact: true }).click();
await row.locator(".kb-key.user", { hasText: "⌘E" }).waitFor();
assert.equal(await row.locator(".kb-key", { hasText: "⌘W" }).count(), 0, "the default is replaced");
const file = await keymapFile();
assert.match(file, /"keys": \["super\+e"\], "command": "close"/);
assert.match(file, /"keys": \["super\+w"\], "command": "noop"/);
if (shots) await page.screenshot({ path: `${shots}/m7-keybindings.png` });
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
assert.equal(await menuDetail("File", "Close Tab"), "⌘E", "menu hint follows");
await page.keyboard.press("Meta+e");
await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor(); // ⌘E closed the tab
await openDemo();

// Reset: back to ⌘W; remove a default; Reset All
await page.keyboard.press("Meta+,");
await nav("Key Bindings").click();
await search.fill("close tab");
await row.getByRole("button", { name: "Reset" }).click();
await row.locator(".kb-key", { hasText: "⌘W" }).waitFor();
assert.equal(await row.locator(".kb-key.user").count(), 0);
assert.doesNotMatch(await keymapFile(), /"close"|noop/);
await row.getByRole("button", { name: "Remove ⌘W from Close Tab" }).click();
await row.locator(".kb-key").first().waitFor({ state: "detached" });
assert.match(await keymapFile(), /"keys": \["super\+w"\], "command": "noop"/);
await page.keyboard.press("Escape");
assert.equal(await menuDetail("File", "Close Tab"), "", "a removed default shows no key");
await page.keyboard.press("Meta+,");
await nav("Key Bindings").click();
await dialog.getByRole("button", { name: "Reset All" }).click();
await dialog.getByRole("button", { name: "Remove all my bindings" }).click();
await search.fill("close tab");
await row.locator(".kb-key", { hasText: "⌘W" }).waitFor();
assert.deepEqual(JSON.parse((await keymapFile()).replace(/\/\/[^\n]*/g, "")), []);
// context-restricted defaults are read-only notes
await search.fill("hide_overlay");
await dialog.locator("li[data-command=hide_overlay] .kb-ctx", { hasText: "when overlay_visible" }).waitFor();
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
assert.equal(await menuDetail("File", "Close Tab"), "⌘W");

// ---- Select Theme: arrows preview, Escape restores, Enter saves
await page.locator(".menubar button", { hasText: "Preferences" }).click();
await page.locator(".popup button", { hasText: "Select Theme…" }).click();
await page.getByRole("dialog", { name: "Select Theme" }).waitFor();
const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? "system");
assert.equal(await theme(), "system");
await page.keyboard.press("ArrowUp"); // System -> Dark
assert.equal(await theme(), "dark", "preview");
await page.keyboard.press("Escape");
assert.equal(await theme(), "system", "Escape restores");
await page.keyboard.press("Meta+p");
await page.keyboard.type("select theme");
await page.keyboard.press("Enter");
await page.getByRole("dialog", { name: "Select Theme" }).waitFor();
await page.keyboard.press("ArrowUp"); // Dark
await page.keyboard.press("ArrowUp"); // Light
assert.equal(await theme(), "light");
await page.keyboard.press("Enter");
assert.equal(await theme(), "light");
assert.equal((await prefs()).theme, "light");

assert.deepEqual(errors, []);
await browser.close();
console.log("prefs e2e ok");
