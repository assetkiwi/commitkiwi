// M7b: the New Tab page (Clone / New / Open Repository), palette entries with args, the user's
// Default.sublime-commands (custom `git` command with $variables and selectors) and .sublime-menu additions.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { sublimeStyle } from "./preset.mjs";

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 860 } })).newPage();
await sublimeStyle(page);
const shots = process.env.SHOTS_DIR;
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("http://127.0.0.1:1420");
const openBtn = page.getByRole("button", { name: "Open Repository", exact: true });
await openBtn.waitFor();

const calls = (kind) => page.evaluate((k) => globalThis.__mockCalls.filter((c) => k in c).map((c) => c[k]), kind);
async function sent(kind, n) {
  await page.waitForFunction(([k, m]) => globalThis.__mockCalls.filter((c) => k in c).length >= m, [kind, n]);
  return (await calls(kind)).at(-1);
}
const activeTab = () => page.locator(".tab.on .tab-main").innerText().then((t) => t.trim());
const form = page.getByRole("form", { name: "Clone Repository" });
const cloneBtn = form.getByRole("button", { name: "Clone", exact: true });
const consoleRow = (status) => page.locator(".setup-console .job", { hasText: "git clone" }).filter({ hasText: status });

// ---- Clone: validation before anything runs
await cloneBtn.click();
await form.getByRole("alert").filter({ hasText: "Enter the URL" }).waitFor();
await form.getByLabel("Source URL").fill("--upload-pack=touch /tmp/x");
await cloneBtn.click();
await form.getByRole("alert").filter({ hasText: "Not a valid repository URL" }).waitFor();
await form.getByLabel("Source URL").fill("ext::sh -c touch% /tmp/x");
await cloneBtn.click();
await form.getByRole("alert").filter({ hasText: "Not a valid repository URL" }).waitFor();
await form.getByLabel("Source URL").fill("https://example.com/team/site.git");
assert.equal(await form.getByLabel("Repository Name").getAttribute("placeholder"), "site", "the name git will pick");
await form.getByLabel("Repository Name").fill("../x");
await cloneBtn.click();
await form.getByRole("alert").filter({ hasText: "Not a valid folder name" }).waitFor();
await form.getByLabel("Repository Name").fill("");
assert.equal((await calls("Clone")).length, 0);

// ---- a slow clone streams into the console and can be cancelled; nothing opens
await page.evaluate(() => { globalThis.__mockSlow.Clone = 4000; });
await cloneBtn.click();
await consoleRow("Running").waitFor();
await page.locator(".setup-console .out", { hasText: "Receiving objects" }).waitFor();
assert.equal(await form.getByRole("button", { name: "Cloning…" }).isDisabled(), true);
if (shots) await page.screenshot({ path: `${shots}/m7b-cloning.png` });
await page.locator(".setup-console").getByRole("button", { name: /^Cancel git clone/ }).click();
await consoleRow("Cancelled").waitFor();
assert.equal(await page.locator(".tabbar .tab").count(), 1, "only the New Tab");
await page.evaluate(() => { globalThis.__mockSlow.Clone = 0; });

// ---- a clone that finishes opens the repository and adds it to Recent
await form.getByLabel("Repository Name").fill("mysite");
await form.getByLabel("Destination Path").fill("~/projects");
await cloneBtn.click();
await page.locator(".row .rb .s", { hasText: "Move DDEV" }).first().waitFor();
assert.equal(await activeTab(), "mysite");
assert.deepEqual(await sent("Clone", 1), { url: "https://example.com/team/site.git", parent: "~/projects", name: "mysite" });
const recent = await page.evaluate(() => JSON.parse(localStorage.getItem("commitkiwi.prefs")).recent.map((r) => r.path));
assert.equal(recent[0], "/home/user/projects/mysite");

// ---- File menu: New Repository / Clone Repository… are enabled; Clone… shows the page with the URL focused
const menu = async (top, item) => {
  await page.locator(".menubar button", { hasText: top }).click();
  const row = page.locator(".popup button", { has: page.locator(".l", { hasText: new RegExp(`^${item}$`) }) }).first();
  await row.waitFor();
  return row;
};
assert.equal(await (await menu("File", "New Repository…")).isDisabled(), false);
await page.keyboard.press("Escape");
await page.locator(".popup").waitFor({ state: "detached" });
await (await menu("File", "Clone Repository…")).click();
await form.waitFor();
await page.waitForFunction(() => document.activeElement?.id === "clone-url");

// ---- New Repository in a typed folder: Init, then the tab
await page.getByPlaceholder("~/projects/my-repo").fill("~/fresh");
await page.getByRole("button", { name: "New Repository", exact: true }).click();
await page.locator(".tab.on .tab-main", { hasText: "fresh" }).waitFor();
assert.deepEqual(await sent("Init", 1), { path: "~/fresh" });
if (shots) { await page.getByRole("button", { name: "New tab", exact: true }).click(); await page.screenshot({ path: `${shots}/m7b-new-tab.png` }); await page.locator(".tabbar .tab-main", { hasText: "fresh" }).click(); }

// ---- the palette: our categories, compatible args, commands without a backend left out
async function palette(caption) {
  await page.keyboard.press("Meta+p");
  await page.locator(".overlay input").fill(caption);
  await page.locator(".overlay li.on .l", { hasText: caption }).waitFor();
  await page.keyboard.press("Enter");
}
const prefs = () => page.evaluate(() => JSON.parse(localStorage.getItem("commitkiwi.prefs")));
const expandBefore = (await prefs()).expand_merge_commits_by_default ?? true;
await palette("History: Expand Merge Commits (Toggle)");
await page.waitForFunction((b) => JSON.parse(localStorage.getItem("commitkiwi.prefs")).expand_merge_commits_by_default === !b, expandBefore);
await page.keyboard.press("Meta+p");
await page.locator(".overlay input").fill("Stash: Pop Latest");
assert.match((await page.locator(".overlay li.on .d").innerText()).trim(), /^git stash pop\s+⇧⌘S$/, "the detail, then the key");
const labels = () => page.locator(".overlay li .l").allInnerTexts();
await page.locator(".overlay input").fill("");
const all = await labels();
assert.ok(all.includes("Changes: Stage All, Including Untracked") && all.includes("Branch: Check Out Remote as New Local…") && all.includes("Repository: Clone…"), all.join("|"));
assert.ok(!all.some((l) => /LFS|Git Flow/.test(l)) && !all.includes("Stash"), "no placeholders / the list's caption wins");
assert.ok(all.includes("Preferences: Import from Sublime Merge…") && all.includes("Preferences: Edit settings.json…") && all.includes("Preferences: Open Configuration Folder…"), "config file commands");
assert.ok(all.every((l) => !/^(Checkout…|Create Branch…|Pop Stash)$/.test(l)), "our own captions");
await page.keyboard.press("Escape");

// ---- user commands file (hot reload on focus): git with argv, $variables, a selector
await page.evaluate(() => {
  localStorage.setItem("commitkiwi.cfg.commands.json", `[
    // mine
    { "caption": "Cleanup Repository", "command": "git", "args": { "argv": ["gc", "--prune=now"] } },
    { "caption": "Rebase onto…", "command": "git", "args": { "argv": ["rebase", "$select_local_branch"] } },
    { "caption": "Tag HEAD", "command": "git", "args": { "argv": ["tag", "-m", "$text", "at-$short_commit", "$head"] } },
  ]`);
  // an older file name still works while the new one does not exist
  localStorage.setItem("commitkiwi.cfg.Branch.sublime-menu", `[{ "caption": "Prune $branch", "command": "git", "args": { "argv": ["branch", "-D", "$branch"] } }]`);
  // "tools": the View menu's earlier id
  localStorage.setItem("commitkiwi.cfg.Main.menu.json", `[{ "id": "tools", "children": [{ "caption": "Garbage Collect", "command": "git", "args": { "argv": ["gc"] } }] }]`);
  window.dispatchEvent(new Event("focus"));
});
await palette("Cleanup Repository");
assert.deepEqual(await sent("GitCustom", 1), { repo: "/home/user/fresh", argv: ["gc", "--prune=now"] });
await palette("Rebase onto…");
assert.deepEqual(await page.locator(".overlay .pill").allInnerTexts(), ["git rebase $select_local_branch"]);
await page.locator(".overlay input").fill("main");
await page.locator(".overlay li.on .l", { hasText: "main" }).first().waitFor();
await page.keyboard.press("Enter");
assert.deepEqual((await sent("GitCustom", 2)).argv, ["rebase", "main"]);
await palette("Tag HEAD");
await page.locator(".overlay input").fill("release notes");
await page.keyboard.press("Enter");
const tagArgv = (await sent("GitCustom", 3)).argv;
assert.equal(tagArgv.length, 5);
assert.deepEqual(tagArgv.slice(0, 3), ["tag", "-m", "release notes"]);
assert.match(tagArgv[3], /^at-[0-9a-f]{7}$/);
assert.match(tagArgv[4], /^[0-9a-f]{40}$/);
// the console shows the user's command like any write
await page.keyboard.press("Control+`");
await page.locator(".console-panel .job", { hasText: "git gc --prune=now" }).waitFor();
await page.keyboard.press("Control+`");

// ---- user menu additions: a branch's context menu and View in the menu bar
const side = page.locator(".tabview:not(.off) .side");
await side.locator("li:not(.folder)", { has: page.locator(".go[title='Go to main']") }).first().click({ button: "right" });
await page.locator(".popup button", { hasText: "Prune main" }).click();
assert.deepEqual((await sent("GitCustom", 4)).argv, ["branch", "-D", "main"]);
await (await menu("View", "Garbage Collect")).click();
assert.deepEqual((await sent("GitCustom", 5)).argv, ["gc"]);

// ---- a broken file is reported, the rest keeps working; removing it removes its entries
await page.evaluate(() => {
  localStorage.setItem("commitkiwi.cfg.commands.json", "[ { oops ]");
  localStorage.removeItem("commitkiwi.cfg.Main.menu.json");
  window.dispatchEvent(new Event("focus"));
});
await page.locator(".banner", { hasText: "commands.json" }).waitFor();
await page.locator(".menubar button", { hasText: "View" }).click();
await page.locator(".popup").waitFor();
assert.equal(await page.locator(".popup .l", { hasText: "Garbage Collect" }).count(), 0);
await page.keyboard.press("Escape");

// ---- New Tab page: Recent Repositories filter (fuzzy name/alias/path, keys, empty state)
await page.getByRole("button", { name: "New tab", exact: true }).click();
const filter = page.getByRole("searchbox", { name: "Filter recent repositories" });
await filter.waitFor();
await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Filter recent repositories");
const rows = () => page.locator(".recent li .p").allInnerTexts();
const recentAll = await rows();
assert.ok(recentAll.length >= 2, "recent holds the cloned and the new repo");
await filter.fill("frsh");
assert.deepEqual((await rows()).map((p) => p.split("/").pop()), ["fresh"]);
await filter.fill("zzzqq");
await page.locator(".recent").getByText("No matches").waitFor();
await filter.press("Escape");
assert.equal(await filter.inputValue(), "");
assert.deepEqual(await rows(), recentAll, "Esc clears and the list returns");
await filter.fill("e");
await filter.press("ArrowDown");
assert.equal(await page.locator(".recent li.on").count(), 1);
await filter.fill("frsh");
await filter.press("Enter");
await page.locator(".tab.on .tab-main", { hasText: "fresh" }).waitFor();

assert.deepEqual(errors, [], "no console/page errors");
await browser.close();
console.log("m7b ok");
