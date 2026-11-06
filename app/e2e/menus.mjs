// F8 context menus against the mock backend: right-click each target kind, check the items (order, separators,
// disabled ones) and that a chosen item sends the right request with the target as its argument.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { sublimeStyle } from "./preset.mjs";

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
await sublimeStyle(page);
const shots = process.env.SHOTS_DIR;
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("http://127.0.0.1:1420");
await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();
await page.getByPlaceholder("~/projects/my-repo").fill("/work/demo-repo");
await page.getByRole("button", { name: "Open Repository", exact: true }).click();
await page.locator(".row .rb .s", { hasText: "Move DDEV" }).first().waitFor();

const oid = (i) => i.toString(16).padStart(8, "0") + "c3f19a2e".repeat(4);
const calls = (kind) => page.evaluate((k) => globalThis.__mockCalls.filter((c) => k in c).map((c) => c[k]), kind);
const count = async (kind) => (await calls(kind)).length;
/** the newest request of `kind`, waiting until there are `n` */
async function sent(kind, n) {
  await page.waitForFunction(([k, m]) => globalThis.__mockCalls.filter((c) => k in c).length >= m, [kind, n]);
  return (await calls(kind)).at(-1);
}
const applied = () => page.evaluate(() => globalThis.__mockApplied);
const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
const popup = page.locator(".popup").first();
/** the open menu's rows: caption, "-" for separators, " (off)" when disabled, " ›" for submenus */
const items = (list = popup) => list.locator(":scope > li").evaluateAll((lis) => lis.map((li) => {
  if (li.classList.contains("sep")) return "-";
  const b = li.querySelector("button");
  return b.querySelector(".l").textContent + (b.dataset.sub !== undefined ? " ›" : "") + (b.disabled ? " (off)" : "");
}));
async function open(target, how = "right") {
  if (how === "right") await target.click({ button: "right" }); else await target.click();
  await popup.waitFor();
  return items();
}
const entry = (label, list = popup) => list.locator(":scope > li > button", { has: page.locator(".l", { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
async function pick(label) {
  await entry(label).click();
  await page.locator(".popup").first().waitFor({ state: "detached" });
}
const pills = () => page.locator(".overlay .pill").allInnerTexts();
async function choose(label) {
  await page.locator(".overlay input").fill(label);
  await page.locator(".overlay li.on .l", { hasText: label }).first().waitFor();
  await page.keyboard.press("Enter");
}
const closed = () => page.locator(".overlay").waitFor({ state: "detached" });
const side = page.locator(".side");
const refRow = (name) => side.locator("li:not(.folder)", { has: page.locator(`.go[title='Go to ${name}']`) }).first();

// ================= Locations =================
// ---- a local branch: Merge/Rebase into the current branch, unregistered nothing; Merge… runs with the ref
assert.deepEqual(await open(refRow("feature/d11-upgrade-B")), [
  "Check Out feature/d11-upgrade-B", "Merge feature/d11-upgrade-B into feature/d11-upgrade-C…", "Rebase feature/d11-upgrade-C onto feature/d11-upgrade-B",
  "Create Pull/Merge Request from feature/d11-upgrade-B…", "-", "Rename feature/d11-upgrade-B…", "Set Upstream…", "Unset Upstream", "Delete feature/d11-upgrade-B", "-",
  "Find Commits on feature/d11-upgrade-B…", "Copy Branch Name", "-", "Hide feature/d11-upgrade-B in the Graph", "Show Only feature/d11-upgrade-B",
]);
if (shots) await page.screenshot({ path: `${shots}/f8-branch.png` });
await pick("Merge feature/d11-upgrade-B into feature/d11-upgrade-C…");
assert.deepEqual(await pills(), ["Merge", "feature/d11-upgrade-B"]);
await choose("merge");
await closed();
assert.deepEqual(await sent("Merge", 1), { repo: "/work/demo-repo", rev: "refs/heads/feature/d11-upgrade-B", flags: [] });
// the current branch: no merge/rebase into itself; Copy puts the name on the clipboard
const headItems = await open(refRow("feature/d11-upgrade-C"));
assert.ok(!headItems.some((i) => i.startsWith("Merge") || i.startsWith("Rebase")), headItems.join());
await pick("Copy Branch Name");
assert.equal(await clipboard(), "feature/d11-upgrade-C");
// Find Commits… opens search mode with branch:
await open(refRow("main"));
await pick("Find Commits on main…");
assert.equal(await page.locator("input[data-control=search_input]").inputValue(), "branch:main ");
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
// a branch folder: New Branch in… starts with the folder as prefix
assert.deepEqual(await open(side.locator("li.folder", { hasText: "feature" }).first()), ["New Branch in feature…", "Copy Folder Name"]);
await pick("New Branch in feature…");
assert.equal(await page.locator(".overlay input").inputValue(), "feature/");
await page.keyboard.press("Escape");
await closed();

// ---- a remote and a remote branch
const originFolder = side.locator("li.folder", { has: page.locator(".t", { hasText: /^origin$/ }) }).first();
assert.deepEqual(await open(originFolder), ["Fetch origin", "Copy URL", "Change URL…", "Rename origin…", "-", "Remove origin"]);
const nFetch = await count("Fetch");
await pick("Fetch origin");
assert.deepEqual(await sent("Fetch", nFetch + 1), { repo: "/work/demo-repo", flags: [], remote: "origin" });
await open(originFolder);
await pick("Copy URL");
await page.waitForFunction(async () => (await navigator.clipboard.readText()) === "git@example.com:demo/origin.git");
await originFolder.locator("button.go").click(); // expand origin/
// origin/main has a local main: only delete/copy/visibility
assert.deepEqual(await open(side.locator("li:not(.folder)", { has: page.locator(".go[title='Go to origin/main']") })), [
  "Delete origin/main", "Copy Branch Name", "-", "Hide origin/main in the Graph", "Show Only origin/main",
]);
await pick("Delete origin/main");
assert.deepEqual(await pills(), ["Delete Remote Branch", "origin/main"]);
await choose("Delete main on origin");
await closed();
assert.deepEqual(await sent("DeleteRemoteBranch", 1), { repo: "/work/demo-repo", branch: "refs/remotes/origin/main" });

// ---- a tag: one Delete … on <remote> per remote, after a separator
const tagRow = side.locator("li:not(.folder)", { has: page.locator(".go[title='Go to v2.4.0']") });
assert.deepEqual(await open(tagRow), ["Check Out v2.4.0", "New Branch from v2.4.0…", "Push v2.4.0…", "Copy Tag Name", "-", "Delete v2.4.0", "-", "Delete v2.4.0 on origin"]);
await pick("Delete v2.4.0 on origin");
await choose("Delete v2.4.0 on origin");
await closed();
assert.deepEqual(await sent("DeleteRemoteTag", 1), { repo: "/work/demo-repo", remote: "origin", name: "v2.4.0" });
await open(tagRow);
await pick("Check Out v2.4.0");
assert.equal((await sent("Checkout", 1)).name, "v2.4.0");
await open(refRow("feature/d11-upgrade-C"));
await pick("Check Out feature/d11-upgrade-C");
assert.equal((await sent("Checkout", 2)).name, "feature/d11-upgrade-C");
await page.locator(".branch", { hasText: "feature/d11-upgrade-C" }).waitFor();

// ---- a stash: by entry, drop confirmed; the section header: Clear All Stashes (confirmed)
const stashRow = side.locator("li", { has: page.locator(".go.stash") }).first();
assert.deepEqual(await open(stashRow), ["Apply Stash", "Apply and Drop (Pop)", "-", "Drop Stash"]);
await pick("Apply Stash");
const stashOid = (await sent("StashOp", 1)).oid;
assert.deepEqual(await sent("StashOp", 1), { repo: "/work/demo-repo", stash: "stash@{0}", oid: stashOid, action: "apply" });
await open(stashRow);
await pick("Drop Stash");
assert.deepEqual(await pills(), ["Drop Stash", "stash@{0}"]);
await choose("Drop stash@{0}");
await closed();
assert.equal((await sent("StashOp", 2)).action, "drop");
assert.deepEqual(await open(side.locator(".sh", { hasText: "STASHES" })), ["Clear All Stashes"]);
await pick("Clear All Stashes");
await choose("Clear 1 stash");
await closed();
await sent("ClearStashes", 1);
assert.deepEqual(await open(side.locator(".sh", { hasText: "BRANCHES" })), ["New Branch…", "Clean Up Branches…"]);
await page.keyboard.press("Escape");

// ---- submodule and worktree rows
const subRow = side.locator("li.plain", { hasText: "vendor/theme" });
assert.deepEqual(await open(subRow), ["Open theme", "Update theme", "Sync theme URL"]);
await pick("Update theme");
assert.deepEqual(await sent("UpdateSubmodules", 1), { repo: "/work/demo-repo", init: false, path: "vendor/theme" });
const wtRow = side.locator("li", { has: page.locator(".go[title='/work/demo-repo-hotfix']") });
assert.deepEqual(await open(wtRow), ["Open demo-repo-hotfix", "Copy Worktree Name"]);
await pick("Copy Worktree Name");
assert.equal(await clipboard(), "demo-repo-hotfix");
assert.ok(!(await open(side.locator("li", { has: page.locator(".go[title='/work/demo-repo']") }))).some((i) => i.startsWith("Open")), "the current worktree is open already");
await page.keyboard.press("Escape");

// ================= Commits =================
await page.getByRole("tab", { name: "Commits", exact: true }).click();
const row = (i) => page.locator(`#row-${i}`);
// ---- HEAD's commit with its branches
assert.deepEqual(await open(row(0)), [
  "Check Out feature/d11-upgrade-C", "Create Pull/Merge Request from feature/d11-upgrade-C…", "Rename feature/d11-upgrade-C…", "Set Upstream…", "Unset Upstream", "Delete feature/d11-upgrade-C",
  "Find Commits on feature/d11-upgrade-C…", "Copy Branch Name", "-",
  "Delete origin/feature/d11-upgrade-C", "Copy Branch Name", "-",
  "Check Out This Commit", "New ›", "-", "Cherry-pick 00000000…", "Revert 00000000", "Rebase Interactively from Here…", "Rewrite History ›", "Reset feature/d11-upgrade-C to Here ›", "-",
  "Copy Commit Hash", "-", "Hide Branches on This Commit", "Show Only Branches on This Commit", "Show All Branches",
]);
if (shots) await page.screenshot({ path: `${shots}/f8-commit.png` });
await entry("Rewrite History").hover();
const sub = page.locator(".popup[aria-label=Submenu]");
await sub.waitFor();
assert.deepEqual(await items(sub), ["Edit Message", "Edit Contents", "Squash into Parent", "Move Up", "Move Down", "Drop Selected"]);
await entry("New").hover();
assert.deepEqual(await items(sub), ["Branch Here…", "Tag Here…"]);
await page.keyboard.press("Escape");
// ---- another commit: right-click selects it; Reset › Keep runs with that commit
await open(row(3));
await row(3).and(page.locator(".sel")).waitFor();
await entry("Reset feature/d11-upgrade-C to Here").click(); // click opens the submenu and focuses it
await sub.waitFor();
assert.deepEqual((await items(sub)).map((i) => i.split(":")[0].split(" ")[0]), ["Soft", "Mixed", "Keep", "Hard"]);
await sub.locator("button", { hasText: /^Keep/ }).click();
assert.deepEqual(await sent("Reset", 1), { repo: "/work/demo-repo", rev: oid(3), mode: "keep" });
await open(row(3));
await pick("Revert 00000003");
assert.deepEqual(await sent("Revert", 1), { repo: "/work/demo-repo", rev: oid(3) });
await open(row(0));
await pick("Show Only Branches on This Commit");
await page.waitForFunction(() => globalThis.__mockCalls.some((c) => c.Count?.hidden.length > 0));
await open(row(3));
await pick("Show All Branches");
// ---- several selected: commits travel as args; cherry-pick oldest first, revert newest first
await row(2).click();
await row(4).click({ modifiers: ["Shift"] });
assert.deepEqual(await open(row(3)), [
  "Check Out This Commit", "New ›", "-", "Cherry-pick Selected Commits", "Revert Selected Commits", "Rewrite History ›", "Reset feature/d11-upgrade-C to Here ›", "-",
  "Copy Commit Hash", "-", "Show All Branches",
]);
const nPick = await count("CherryPick");
await pick("Cherry-pick Selected Commits");
await sent("CherryPick", nPick + 3);
assert.deepEqual((await calls("CherryPick")).slice(-3).map((c) => c.rev), [oid(4), oid(3), oid(2)]);
await row(2).click(); // a reload after the jobs keeps one row selected
await row(4).click({ modifiers: ["Shift"] });
await open(row(3));
await pick("Revert Selected Commits");
await sent("Revert", 4);
assert.deepEqual((await calls("Revert")).slice(-3).map((c) => c.rev), [oid(2), oid(3), oid(4)]);

// ---- a commit's file: band `…` and the Files column; Revert/Cherry-pick This File send the commit's patch
await row(1).click();
await page.locator(".file", { hasText: "composer.json" }).first().waitFor();
assert.deepEqual(await open(page.getByRole("button", { name: "File actions for composer.json" }), "click"), [
  "Revert Changes to This File", "Cherry-pick This File", "-", "Open in Editor…", "Reveal in Finder", "Copy File Path", "-", "File History", "Blame",
]);
await pick("Revert Changes to This File");
await page.waitForFunction(() => globalThis.__mockApplied.length > 0);
let a = (await applied()).at(-1);
assert.equal(a.mode, "discard");
assert.match(a.patch, /^diff --git a\/composer.json b\/composer.json/);
await page.locator(".file", { hasText: ".ddev/config.yaml" }).locator(".band").click({ button: "right" });
await popup.waitFor();
const nBefore = (await applied()).length;
await pick("Cherry-pick This File");
await page.waitForFunction((n) => globalThis.__mockApplied.length > n, nBefore);
a = (await applied()).at(-1);
assert.equal(a.mode, "worktree");
assert.match(a.patch, /\.ddev\/config\.yaml/);
await page.getByRole("button", { name: "File actions for .ddev/config.yaml" }).click();
await popup.waitFor();
await pick("File History");
assert.equal(await page.locator("input[data-control=search_input]").inputValue(), 'file:".ddev/config.yaml"');
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
// ---- a hunk's `…` (commit diffs): the hunk's patch, reversed or forward
await row(1).click();
const hunkBtn = page.locator(".file", { hasText: "composer.json" }).first().getByRole("button", { name: "Hunk actions" }).first();
assert.deepEqual(await open(hunkBtn, "click"), ["Revert This Hunk", "Cherry-pick This Hunk"]);
const nApplied = (await applied()).length;
await pick("Revert This Hunk");
await page.waitForFunction((n) => globalThis.__mockApplied.length > n, nApplied);
a = (await applied()).at(-1);
assert.equal(a.mode, "discard");
assert.match(a.patch, /\n-        "php": "\^8\.1",\n\+        "php": "\^8\.3",\n/);
assert.ok(!a.patch.includes("short old line"), "only that hunk");
await open(hunkBtn, "click");
await pick("Cherry-pick This Hunk");
await page.waitForFunction((n) => globalThis.__mockApplied.length > n, nApplied + 1);
assert.equal((await applied()).at(-1).mode, "worktree");
// ---- an image diff
const logo = page.locator(".file", { hasText: "assets/logo.png" }).locator(".fh");
await page.waitForTimeout(300); // the hunk pick reloads the view
if ((await logo.getAttribute("aria-expanded")) !== "true") await logo.click();
await page.locator(".file", { hasText: "assets/logo.png" }).scrollIntoViewIfNeeded(); // bodies mount near the view
assert.deepEqual(await open(page.locator(".imgdiff").first()), ["Open in Editor…", "Reveal in Finder", "Copy File Path"]);
await pick("Copy File Path");
assert.equal(await clipboard(), "assets/logo.png");
// ---- the commit summary `…`
await row(1).click(); // writes reload the list, which selects HEAD again
await page.locator(".kv .mono", { hasText: oid(1) }).first().waitFor();
assert.deepEqual(await open(page.getByRole("button", { name: "Commit actions" }), "click"), ["Copy Commit Hash", "Copy Message", "Copy Tree Hash"]);
await pick("Copy Commit Hash");
assert.equal(await clipboard(), oid(1));

// ================= Working directory: menus by status =================
await page.locator(".workrow").click();
const band = (name) => page.locator(".card.file", { has: page.locator(".path", { hasText: name }) }).first().locator(".band");
assert.deepEqual((await open(band("composer.json"))).slice(0, 3), ["Stage File", "Discard Changes…", "-"]);
const nStage = await count("Stage");
await pick("Stage File");
assert.deepEqual(await sent("Stage", nStage + 1), { repo: "/work/demo-repo", paths: ["composer.json"] });
const untracked = await open(band("debug.log"));
assert.ok(!untracked.includes("Blame"));
assert.deepEqual(untracked.slice(0, 4), ["Stage File", "Ignore debug.log", "Delete File…", "-"]);
await pick("Delete File…");
assert.deepEqual(await pills(), ["Delete File", "debug.log"]);
await choose("Delete debug.log");
await closed();
assert.deepEqual((await sent("Discard", 1)).paths, ["debug.log"]);
const staged = page.locator(".wsec", { hasText: "Staged Files" });
await staged.waitFor();
assert.deepEqual((await open(page.locator(".card.file", { has: page.locator(".path", { hasText: "README.md" }) }).last().locator(".band"))).slice(0, 2), ["Unstage File", "-"]);
const nUnstage = await count("Unstage");
await pick("Unstage File");
assert.deepEqual(await sent("Unstage", nUnstage + 1), { repo: "/work/demo-repo", paths: ["README.md"] });
// the Files column: the same menus
await page.getByRole("tab", { name: "Files", exact: true }).click();
const fileRow = page.locator(".fr", { hasText: "web/new_feature.php" }).first();
assert.deepEqual((await open(fileRow)).slice(0, 4), ["Stage File", "Ignore web/new_feature.php", "Delete File…", "-"]);
await pick("Ignore web/new_feature.php");
assert.equal((await sent("Ignore", 1)).path, "web/new_feature.php");

// ================= tab, console, toolbar =================
assert.deepEqual(await open(page.locator(".tab.on")), ["Set Alias…", "-", "Close Tab"]);
await pick("Set Alias…");
assert.deepEqual(await pills(), ["Set Alias"]);
await page.keyboard.press("Escape");
await closed();
await page.getByRole("button", { name: "Console" }).click();
const job = page.locator(".console-panel .job").first();
await job.waitFor();
const label = await job.locator(".cmd").innerText();
assert.ok((await open(job)).includes("Copy Command"));
await pick("Copy Command");
assert.equal(await clipboard(), label);
await page.getByRole("button", { name: "Console" }).click();
assert.deepEqual(await open(page.getByRole("button", { name: "More actions" }), "click"), [
  "New Branch…", "Merge into Current Branch…", "Create Pull/Merge Request…", "-", (await items())[4], (await items())[5], "-", "Reveal in Finder", "Open Repository in Editor", "Open Repository in Terminal", "Copy Repository Path",
]);
await page.keyboard.press("Escape");

assert.deepEqual(errors, []);
await browser.close();
console.log("menus e2e ok");
