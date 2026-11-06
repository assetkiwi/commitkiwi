// M5b against the mock backend: Undo/Redo from the journal (menu caption, ⌘Z outside text fields only, refusals),
// Pull/Push option pills (--force confirm), remotes, and the askpass prompt.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { sublimeStyle } from "./preset.mjs";

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await (await browser.newContext({ viewport: { width: 1300, height: 800 } })).newPage();
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

const calls = (kind) => page.evaluate((k) => globalThis.__mockCalls.filter((c) => k in c).map((c) => c[k]), kind);
async function sent(kind, count = 1) {
  await page.waitForFunction(([k, n]) => globalThis.__mockCalls.filter((c) => k in c).length >= n, [kind, count]);
  return (await calls(kind)).at(-1);
}
const pills = () => page.locator(".overlay .pill").allInnerTexts();
const placeholder = () => page.locator(".overlay input").getAttribute("placeholder");
async function palette(caption) {
  await page.keyboard.press("Meta+p");
  await page.locator(".overlay input").fill(caption);
  await page.locator(".overlay li.on .l", { hasText: caption }).waitFor();
  await page.keyboard.press("Enter");
}
async function choose(label) {
  await page.locator(".overlay input").fill(label);
  await page.locator(".overlay li.on .l", { hasText: label }).first().waitFor();
  await page.keyboard.press("Enter");
}
async function type(text) {
  await page.locator(".overlay input").fill(text);
  await page.keyboard.press("Enter");
}
const closed = () => page.locator(".overlay").waitFor({ state: "detached" });
/** the Changes menu's last two items (Undo, Redo): caption and enabled */
async function repoMenu() {
  await page.locator(".menubar button", { hasText: "Changes" }).click();
  const items = page.locator(".popup button");
  await items.first().waitFor();
  const out = [];
  const n = await items.count();
  for (const k of [n - 2, n - 1]) out.push([(await items.nth(k).locator(".l").innerText()).trim(), !(await items.nth(k).isDisabled())]);
  await page.keyboard.press("Escape");
  await page.locator(".popup").waitFor({ state: "detached" });
  return out;
}
const waitMenu = async (want) => {
  for (let i = 0; i < 40; i++) {
    const got = await repoMenu();
    if (JSON.stringify(got) === JSON.stringify(want)) return;
    await page.waitForTimeout(100);
  }
  assert.deepEqual(await repoMenu(), want);
};

// ---- Undo/Redo: nothing yet; a commit makes "Undo: commit"
await waitMenu([["Undo", false], ["Redo", false]]);
await page.locator(".workrow").click();
await page.getByLabel("Commit message").fill("Undo me");
await page.locator(".commitbox .split.commit .primary").first().click();
await page.waitForFunction(() => globalThis.__mockCommits.length === 1);
await waitMenu([["Undo: commit", true], ["Redo", false]]);
// ⌘Z inside the commit message is text undo: no git undo
await page.getByLabel("Commit message").fill("typing");
await page.getByLabel("Commit message").focus();
await page.keyboard.press("Meta+z");
await page.waitForTimeout(300);
assert.equal((await calls("Undo")).length, 0, "⌘Z in a text field never undoes git");
await page.getByLabel("Commit message").fill("");
// outside a text field ⌘Z runs git undo of the commit (soft: its changes come back staged)
await page.locator(".row .rb .s").first().click();
await page.keyboard.press("Meta+z");
const u = await sent("Undo");
assert.deepEqual([u.redo, u.mode, u.check, u.moved.refs[0].name], [false, "soft", false, "refs/heads/feature/d11-upgrade-C"]);
await waitMenu([["Undo", false], ["Redo: commit", true]]);
if (shots) {
  await page.locator(".menubar button", { hasText: "Changes" }).click();
  await page.screenshot({ path: `${shots}/m5b-undo-menu.png` });
  await page.keyboard.press("Escape");
}
// Redo from the … menu, then Undo again: the console journals both
await page.getByRole("button", { name: "More actions" }).click();
await page.locator(".popup button", { hasText: "Redo: commit" }).click();
await page.waitForFunction(() => globalThis.__mockCalls.filter((c) => "Undo" in c).length === 2);
assert.equal((await calls("Undo")).at(-1).redo, true);
await waitMenu([["Undo: commit", true], ["Redo", false]]);
// the backend refuses (local changes in the way): disabled with the reason, ⌘Z shows it
await page.evaluate(() => { globalThis.__mockUndoRefuse = "Undo would overwrite local changes to composer.json; commit or stash them first."; });
await page.locator(".workrow").click(); // a status refresh re-checks
await waitMenu([["Undo: commit (Undo would overwrite local changes to composer.json; commit or stash them first.)", false], ["Redo", false]]);
await page.locator(".row .rb .s").first().click();
await page.keyboard.press("Meta+z");
await page.locator(".banner", { hasText: "overwrite local changes" }).waitFor();
assert.equal((await calls("Undo")).length, 2, "refused: nothing sent");
await page.locator(".banner button[aria-label=Dismiss]").click();
await page.evaluate(() => { globalThis.__mockUndoRefuse = ""; });

// ---- Pull options: one pill, seven rows
await page.getByRole("button", { name: "Pull options" }).click();
await page.locator(".overlay").waitFor();
assert.deepEqual(await pills(), ["Pull"]);
assert.equal(await placeholder(), "Pull Options");
assert.deepEqual((await page.locator(".overlay li .l").allInnerTexts()).map((t) => t.trim()),
  ["pull", "pull --ff-only", "pull --rebase", "pull --rebase --autostash", "fetch", "fetch --tags", "fetch --prune"]);
await choose("pull --rebase --autostash");
await closed();
assert.deepEqual((await sent("Pull")).flags, ["--rebase", "--autostash"]);

// ---- Push options: Push › branch › remote from the upstream; --force asks again
await page.getByRole("button", { name: "Push options" }).click();
await page.locator(".overlay").waitFor();
assert.deepEqual(await pills(), ["Push", "feature/d11-upgrade-C", "origin"]);
assert.equal(await placeholder(), "Push Options");
if (shots) await page.screenshot({ path: `${shots}/m5b-push.png` });
await choose("push --force");
assert.deepEqual(await pills(), ["Push", "feature/d11-upgrade-C", "origin", "--force"]);
await choose("Cancel");
await closed();
assert.equal((await calls("Push")).length, 0, "cancelled force push sends nothing");
await page.getByRole("button", { name: "Push options" }).click();
await choose("push --force");
await choose("Force push");
await closed();
assert.deepEqual(await sent("Push"), { repo: "/work/demo-repo", flags: ["--force"], remote: "origin", branch: "feature/d11-upgrade-C" });

// ---- Remotes: add (validated URL), rename, update URL, delete (confirmed)
await palette("Remote: Add…");
assert.deepEqual(await pills(), ["Add Remote"]);
await type("-bad");
await page.locator(".overlay .ov-err", { hasText: "cannot start with '-'" }).waitFor();
await type("upstream");
assert.deepEqual(await pills(), ["Add Remote", "upstream"]);
await type("--upload-pack=touch /tmp/x");
await page.locator(".overlay .ov-err", { hasText: "cannot start with '-'" }).waitFor();
await type("ext::sh -c x");
await page.locator(".overlay .ov-err", { hasText: "ext::" }).waitFor();
await type("https://example.com/r.git");
await closed();
assert.deepEqual(await sent("AddRemote"), { repo: "/work/demo-repo", name: "upstream", url: "https://example.com/r.git" });
const settle = () => page.waitForTimeout(400); // the tab reloads its refs after each write
await settle();
await palette("Remote: Rename…");
await choose("upstream");
assert.deepEqual(await pills(), ["Rename Remote", "upstream"]);
await type("fork");
await closed();
assert.deepEqual(await sent("RenameRemote"), { repo: "/work/demo-repo", name: "upstream", new_name: "fork" });
await settle();
await palette("Remote: Change URL…");
await choose("fork");
await type("git@example.com:me/r.git");
await closed();
assert.deepEqual(await sent("SetRemoteUrl"), { repo: "/work/demo-repo", name: "fork", url: "git@example.com:me/r.git" });
await palette("Remote: Remove…");
await choose("fork");
await choose("Delete fork");
await closed();
assert.deepEqual(await sent("DeleteRemote"), { repo: "/work/demo-repo", name: "fork" });
// a password typed into a URL never reaches the console
await palette("Remote: Add…");
await type("creds");
await type("https://bob:s3cret@example.com/r.git");
await sent("AddRemote", 2);
await page.getByRole("button", { name: "Console", exact: true }).click();
await page.locator(".console-panel").waitFor();
assert.ok(!(await page.locator(".console-panel").innerText()).includes("s3cret"), "no password in the journal");
assert.ok((await page.locator(".console-panel").innerText()).includes("bob:***@"), await page.locator(".console-panel").innerText());
await page.keyboard.press("Escape");

// ---- askpass: a push that needs credentials prompts in the window (password hidden); Cancel fails the push
await page.evaluate(() => { globalThis.__mockAuth.Push = true; });
await page.getByRole("button", { name: "Push", exact: true }).click();
const dialog = page.getByRole("dialog", { name: "Authentication" });
await dialog.waitFor();
assert.match(await dialog.locator(".ap-prompt").innerText(), /^Username for 'https:\/\/example.com'/);
assert.equal(await dialog.locator("input").getAttribute("type"), "text");
await page.keyboard.type("bob");
await page.keyboard.press("Enter");
await dialog.locator(".ap-prompt", { hasText: "Password for" }).waitFor();
assert.equal(await dialog.locator("input").getAttribute("type"), "password");
if (shots) await page.screenshot({ path: `${shots}/m5b-askpass.png` });
await page.keyboard.type("hunter2");
await page.keyboard.press("Enter");
await dialog.waitFor({ state: "detached" });
await page.waitForFunction(() => globalThis.__mockAuthGot.length === 1);
assert.deepEqual(await page.evaluate(() => globalThis.__mockAuthGot[0]), { user: "bob", passwordLength: 7 });
await page.getByRole("button", { name: "Push", exact: true }).click();
await dialog.waitFor();
await page.keyboard.press("Escape"); // = Cancel
await dialog.waitFor({ state: "detached" });
await page.locator(".banner", { hasText: "could not read Username" }).waitFor();
assert.equal(await page.evaluate(() => globalThis.__mockAuthGot.length), 1);
assert.ok(!(await page.content()).includes("hunter2"), "the password is nowhere in the page");

assert.deepEqual(errors, [], "no console/page errors");
await browser.close();
console.log("m5b e2e ok");
