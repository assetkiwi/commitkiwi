// Key bindings, command palette and overlays, against the Vite dev server (mock backend).
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { sublimeStyle } from "./preset.mjs";

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const ctx = await browser.newContext({ viewport: { width: 1300, height: 800 } });
const page = await ctx.newPage();
await sublimeStyle(page);
const shots = process.env.SHOTS_DIR;
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("http://127.0.0.1:1420");

const openRepo = async (path) => {
  await page.getByPlaceholder("~/projects/my-repo").fill(path);
  await page.getByRole("button", { name: "Open Repository", exact: true }).click();
  await page.locator(".tab.on .tab-main", { hasText: path.split("/").pop() }).waitFor();
};
const tabNames = () => page.locator(".tabbar .tab-main").allInnerTexts();
const activeTab = () => page.locator(".tabbar .tab.on").first().innerText();

await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();
await openRepo("/work/alpha");
await page.getByRole("button", { name: "New tab", exact: true }).click();
await openRepo("/work/beta");
assert.deepEqual((await tabNames()).map((t) => t.trim()), ["alpha", "beta"]);

// ---- palette: opens with the key, fuzzy-matches with bold letters, shows each command's shortcut, Enter runs it
await page.keyboard.press("Meta+p");
await page.locator(".overlay").waitFor();
assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-control")), "overlay_input", "input is focused");
await page.keyboard.type("clos");
await page.locator(".overlay li.on .l b").first().waitFor();
if (shots) await page.screenshot({ path: `${shots}/m45-palette.png` });
assert.equal((await page.locator(".overlay li.on .l").innerText()).trim(), "Close Tab");
assert.equal((await page.locator(".overlay li.on .d").innerText()).trim(), "⌘W", "shortcut shown next to the command");
assert.equal((await page.locator(".overlay li.on .l b").allInnerTexts()).join(""), "Clos", "matched letters are bold");
await page.keyboard.press("Enter");
await page.locator(".overlay").waitFor({ state: "detached" });
assert.deepEqual((await tabNames()).map((t) => t.trim()), ["alpha"], "Close Tab ran: beta is gone");

// ---- Escape closes the overlay (a normal, rebindable binding); typing in it never triggers shortcuts
await page.keyboard.press("Meta+Shift+p");
await page.locator(".overlay").waitFor();
await page.keyboard.type("tw"); // plain letters go to the input
assert.equal(await page.locator(".overlay input").inputValue(), "tw");
await page.keyboard.press("Escape");
await page.locator(".overlay").waitFor({ state: "detached" });
await page.keyboard.press("Meta+Shift+p");
await page.keyboard.type("zzzzzz");
await page.getByText("No matches").waitFor();
await page.keyboard.press("Escape");

// ---- arrows move the selection and wrap; clicking picks
await page.keyboard.press("Meta+p");
await page.locator(".overlay li").first().waitFor();
const n = await page.locator(".overlay li").count();
await page.keyboard.press("ArrowUp"); // wraps to the last row
assert.equal(await page.locator(".overlay li.on").evaluate((el) => [...el.parentElement.children].indexOf(el)), n - 1);
await page.keyboard.press("Escape");

// ---- tab commands
await page.keyboard.press("Meta+t");
await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();
await page.keyboard.press("Meta+Shift+t"); // restore beta
await page.locator(".tab-main", { hasText: "beta" }).waitFor();
assert.equal((await activeTab()).trim(), "beta", "restored tab becomes active");
await page.keyboard.press("Control+Tab");
assert.equal((await activeTab()).trim(), "New Tab", "next_tab cycles on (beta -> New Tab)");
await page.keyboard.press("Control+Shift+Tab");
assert.equal((await activeTab()).trim(), "beta");
await page.keyboard.press("Meta+w");
assert.deepEqual((await tabNames()).map((t) => t.trim()), ["alpha"]);
await page.keyboard.press("Meta+Shift+t");
await page.locator(".tab-main", { hasText: "beta" }).waitFor();

// ---- a two-key chord (Cmd+K, Cmd+B) toggles the sidebar; the first key alone does nothing
await page.locator(".tabview:not(.off) .side").waitFor();
await page.keyboard.press("Meta+k");
assert.equal(await page.locator(".tabview:not(.off) .side").count(), 1);
await page.keyboard.press("Meta+b");
await page.waitForFunction(() => document.querySelectorAll(".side").length === 0);
await page.keyboard.press("Meta+k");
await page.keyboard.press("Meta+b");
await page.locator(".tabview:not(.off) .side").waitFor();

// ---- ⌘← in a text field moves the caret instead of navigating back
await page.keyboard.press("Meta+p");
await page.keyboard.type("abc");
await page.keyboard.press("Meta+ArrowLeft");
assert.equal(await page.locator(".overlay input").evaluate((i) => i.selectionStart), 0, "caret moved to the start");
await page.keyboard.press("Escape");

// ---- show_command_palette with {command} opens that command's prompt (shift+f8 = push options)
await page.keyboard.press("Shift+F8");
await page.locator(".overlay .pill", { hasText: "Push" }).waitFor();
assert.deepEqual(await page.locator(".overlay li .l").allInnerTexts(), ["push", "push --force", "push --force-with-lease", "push --no-verify"]);
await page.keyboard.press("Escape");
await page.keyboard.press("Meta+s"); // stash
await page.waitForFunction(() => /git stash push: ok/.test(document.querySelector(".tabview:not(.off) .console")?.title ?? "")); // done (a second git command waits for the first)
await page.keyboard.press("Meta+Shift+s"); // pop_stash
await page.waitForFunction(() => globalThis.__mockCalls.some((c) => c.PopStash));

// ---- palette lists the new commands with their keys
await page.keyboard.press("Meta+p");
await page.keyboard.type("Go: Back");
assert.equal((await page.locator(".overlay li.on .d").innerText()).trim(), "⌘←");
await page.keyboard.press("Escape");

// ---- switch repository: shows open repos, typing narrows, Enter activates
await page.keyboard.press("Meta+Shift+o");
await page.locator(".overlay li", { hasText: "alpha" }).waitFor();
await page.keyboard.type("alp");
await page.keyboard.press("Enter");
await page.locator(".tab.on .tab-main", { hasText: "alpha" }).waitFor();

// ---- user keymap: JSON with comments and trailing commas; later entries override defaults
const userKeymap = `[
  // make the palette key close the tab instead, and add a theme toggle
  { "keys": ["super+p"], "command": "close" },
  { "keys": ["super+shift+x"], "command": "toggle_theme" },
  { "keys": ["super+shift+l"], "command": "set_preference", "args": { "setting": "side_bar_layout", "value": "columns" } },
]`;
await page.evaluate((t) => localStorage.setItem("commitkiwi.cfg.Default.sublime-keymap", t), userKeymap);
await page.reload();
await page.locator(".tab-main", { hasText: "alpha" }).waitFor();
const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? "");
const before = await theme();
await page.keyboard.press("Meta+Shift+x");
const once = await theme();
assert.notEqual(once, before, "user binding toggles the theme");
await page.keyboard.press("Meta+Shift+x");
assert.notEqual(await theme(), once, "and toggles it back");
await page.keyboard.press("Meta+Shift+l");
await page.locator(".tabview:not(.off) .main > .left.col-files").waitFor();
await page.keyboard.press("Meta+p"); // now means "close", so no palette
assert.equal(await page.locator(".overlay").count(), 0);
await page.keyboard.press("Meta+Shift+p"); // the other default still opens it
await page.locator(".overlay").waitFor();
await page.keyboard.type("close tab");
assert.equal((await page.locator(".overlay li.on .d").innerText()).trim(), "⌘P", "palette shows the user's key, not the old one");
await page.keyboard.press("Escape");

// ---- in-window menu bar (no native one in the browser): registry state, keymap hints (the user's), runs commands
const menu = async (top) => { await page.locator(".menubar button", { hasText: top }).click(); await page.locator(".popup").waitFor(); };
const entry = (label) => page.locator(".popup button", { has: page.locator(".l", { hasText: new RegExp(`^${label}$`) }) });
await menu("File");
assert.equal((await entry("Close Tab").locator(".d").innerText()).trim(), "⌘P", "menu shows the user's key");
assert.equal(await entry("Close Window").count(), 0, "OS-only items are not drawn in-window");
await page.keyboard.press("Escape");
await menu("Branch");
assert.equal(await entry("Check Out Branch…").isEnabled(), true);
assert.equal((await entry("Check Out Branch…").locator(".d").innerText()).trim(), "⌘B");
assert.equal(await entry("New Branch…").isEnabled(), true, "M5a: built");
assert.equal((await entry("New Branch…").locator(".d").innerText()).trim(), "⇧⌘B");
if (shots) await page.screenshot({ path: `${shots}/menubar.png` });
await page.keyboard.press("Escape");
assert.equal(await page.locator(".menubar button", { hasText: "Edit" }).count(), 0, "Edit is clipboard only: native-only");
const t0 = await theme();
await menu("View");
await entry("Toggle Light/Dark Theme").click();
assert.notEqual(await theme(), t0, "menu item ran its command");
await page.locator(".popup").waitFor({ state: "detached" });

// ---- search mode (⌘F): keyword autocomplete, results filter the list, next/prev, Esc restores
const list = page.locator(".list[data-control=commit_table]");
const searchInput = page.locator(".searchbar input");
await page.keyboard.press("Meta+f");
await searchInput.waitFor();
assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-control")), "search_input");
await page.keyboard.type("f");
await page.locator("#search-ac li").first().waitFor();
assert.deepEqual(await page.locator("#search-ac .kw").allInnerTexts(), ["file:", "from:", "after:", "before:"], "`f` suggestions");
assert.ok((await page.locator("#search-ac li.on .d").innerText()).length > 5, "keywords have descriptions");
if (shots) await page.screenshot({ path: `${shots}/f6-search-autocomplete.png` });
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Tab");
assert.equal(await searchInput.inputValue(), "from:", "Tab inserts the keyword");
await page.keyboard.press("Escape"); // nothing to dismiss now: leaves search
await searchInput.waitFor({ state: "detached" });
await page.keyboard.press("Meta+f");
await page.keyboard.type("a");
await page.locator("#search-ac").waitFor();
await page.keyboard.press("Escape"); // first Escape closes the list only
await page.locator("#search-ac").waitFor({ state: "detached" });
assert.equal(await searchInput.count(), 1);
await searchInput.fill("");
await page.keyboard.type("au");
await page.keyboard.press("Enter");
assert.equal(await searchInput.inputValue(), "author:", "Enter inserts the keyword too");
await searchInput.fill("message:remaining from:\"John Smith\"");
await page.locator(".searchbar .info", { hasText: "714 results" }).waitFor();
const sent = await page.evaluate(() => globalThis.__mockCalls.filter((c) => c.Search).at(-1).Search.query);
assert.deepEqual([sent.message, sent.author, sent.text], [["remaining"], ["John Smith"], []], "parsed before it reaches the backend");
await page.locator("#row-21.sel").waitFor();
const subjects = await list.locator(".row .s").allInnerTexts();
assert.ok(subjects.length > 3 && subjects.every((s) => s.includes("Patch the remaining")), "only results are listed");
if (shots) await page.screenshot({ path: `${shots}/f6-search-results.png` });
await page.keyboard.press("Enter"); // next result
await page.locator("#row-91.sel").waitFor();
await page.keyboard.press("Meta+g");
await page.locator("#row-161.sel").waitFor();
await page.keyboard.press("Meta+Shift+g");
await page.locator("#row-91.sel").waitFor();
await page.keyboard.press("Escape");
await searchInput.waitFor({ state: "detached" });
await page.locator("#row-90").waitFor(); // the full list is back, the picked result still selected
await page.locator("#row-91.sel").waitFor();
const top = await list.evaluate((el) => el.scrollTop);
await page.keyboard.press("Meta+f");
await searchInput.fill("commit:zz");
await page.locator(".searchbar .info.err", { hasText: "commit:" }).waitFor();
await searchInput.fill("nothing-matches-this");
await page.locator(".searchbar .info", { hasText: "No results" }).waitFor();
await page.locator(".toolbar button[aria-label=Search]").click(); // the toolbar button closes it too
await searchInput.waitFor({ state: "detached" });
assert.equal(await list.evaluate((el) => el.scrollTop), top, "scroll position restored");
await menu("Go");
await entry("Search Commits").click();
await searchInput.waitFor();
await page.keyboard.press("Escape");

// ---- a broken user file is reported and the defaults keep working
await page.evaluate(() => localStorage.setItem("commitkiwi.cfg.Default.sublime-keymap", "[ not json"));
await page.reload();
await page.locator(".banner", { hasText: "Could not read your key bindings" }).waitFor();
await page.keyboard.press("Meta+p");
await page.locator(".overlay").waitFor();

assert.deepEqual(errors.filter((e) => !e.includes("Could not read")), [], "no console/page errors");
await browser.close();
console.log("keys e2e ok");
