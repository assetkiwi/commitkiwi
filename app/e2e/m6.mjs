// M6 against the mock backend: the merge tool (columns, CONFLICT marks, arrows, Base toggle, Prev/Next,
// Save and Stage ▾ with the unresolved warning, Cancel, whole-file fallback), commit editing from the commit menu's
// Edit submenu (scripted rebase: published-history confirm, Edit Commit Message inline, Edit Contents stop banner,
// conflicts), and Navigate → Blame… / File History….
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

const oid = (i) => i.toString(16).padStart(8, "0") + "c3f19a2e".repeat(4);
const calls = (kind) => page.evaluate((k) => globalThis.__mockCalls.filter((c) => k in c).map((c) => c[k]), kind);
async function sent(kind, n) {
  await page.waitForFunction(([k, m]) => globalThis.__mockCalls.filter((c) => k in c).length >= m, [kind, n]);
  return (await calls(kind)).at(-1);
}
const count = async (kind) => (await calls(kind)).length;
const popup = page.locator(".popup").first();
const sub = page.locator(".popup[aria-label=Submenu]");
const entry = (label, list = popup) => list.locator(":scope > li > button", { has: page.locator(".l", { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
async function choose(label) {
  await page.locator(".overlay input").fill(label);
  await page.locator(".overlay li.on .l", { hasText: label }).first().waitFor();
  await page.keyboard.press("Enter");
}
const closed = () => page.locator(".overlay").waitFor({ state: "detached" });
const tool = page.locator(".mtool");
const merged = tool.locator("[aria-label=Merged]");
const mergedText = () => merged.evaluate((e) => [...e.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n"));
const wd = page.locator(".details.work");

// ================= merge tool =================
await page.evaluate(() => globalThis.__mockMerge());
await page.keyboard.press("F5");
await page.locator(".workrow").click();
const lockBand = wd.locator(".file.conflict", { hasText: "composer.lock" });
await lockBand.getByRole("button", { name: "Resolve", exact: true }).click();
await merged.waitFor();
await page.locator(".mt-mark").nth(1).waitFor();
// one-sided and identical changes are taken, each conflict is a CONFLICT placeholder; connectors + arrows per hunk
let text = await mergedText();
assert.ok(text.includes('"ours-only": true') && text.includes('"theirs-only": true') && text.includes('"both": "same"'), text);
assert.equal(await page.locator(".mt-mark").count(), 2);
assert.equal(await tool.getByRole("tab", { name: "Merged (2)" }).count(), 1);
assert.equal(await tool.locator(".mt-strip").first().locator("polygon").count(), 5, "a connector per changed hunk");
// conflicts: ▶/◀ and × on both sides (4 each); auto-applied: × on each changed side (ours-only, theirs-only, both x2)
assert.equal(await tool.locator(".mt-arrow").count(), 12);
assert.equal(await tool.getByText("All changes processed").count(), 0);
// × on an auto-applied change undoes it (base text again, ▶ to re-apply); Apply ▾ puts it back
await tool.getByRole("button", { name: "Ignore ours for hunk 3" }).click();
assert.ok(!(await mergedText()).includes('"ours-only": true'));
await tool.getByRole("button", { name: "Take ours for hunk 3" }).waitFor();
await tool.getByRole("button", { name: "Apply", exact: true }).click();
await entry("Apply Non-Conflicting Changes").click();
assert.ok((await mergedText()).includes('"ours-only": true'));
assert.match(await tool.locator(".mt-heads").innerText(), /Commit 00000000 on feature\/d11-upgrade-C[\s\S]*Commit 0000000c on feature\/d11-upgrade-B/);
if (shots) await page.screenshot({ path: `${shots}/m6-merge.png` });
// ⌘S here is the merge tool's save (not Stash): unresolved conflicts warn first
const nStash = await count("Stash");
await page.keyboard.press("Meta+s");
await tool.getByText("2 unresolved conflicts: saved as conflict markers and staged").waitFor();
await tool.getByRole("button", { name: "Back" }).click();
assert.equal(await count("Stash"), nStash);
// the cursor starts on the first conflict: ⇧⌘. takes theirs there; the second takes ours by its arrow
await page.keyboard.press("Meta+Shift+.");
await page.locator(".mt-mark").nth(1).waitFor({ state: "detached" });
assert.ok((await mergedText()).includes('"hash": "bbb"'));
await tool.getByRole("button", { name: "Take ours for hunk 5" }).click();
await page.locator(".mt-mark").waitFor({ state: "detached" });
await tool.getByText("All changes processed").waitFor();
assert.equal(await tool.getByRole("tab", { name: "Merged", exact: true }).count(), 1);
// right-click an arrow: Take Both
await tool.getByRole("button", { name: "Take ours for hunk 1" }).click({ button: "right" });
await entry("Take Both (Left First)").click();
await page.waitForFunction(() => document.querySelector(".mtool [aria-label=Merged]").textContent.includes('"hash": "aaa",  "hash": "bbb"'));
// Base: the middle column shows the common ancestor; ⌘0 flips back
await tool.getByRole("tab", { name: "Base" }).click();
await tool.locator("[aria-label=Base]").getByText('"hash": "base",').waitFor();
await page.keyboard.press("Meta+0");
await merged.waitFor();
// Prev/Next Conflict walk the conflict hunks (all resolved now)
await tool.getByRole("button", { name: "Next Conflict" }).click();
await tool.getByRole("button", { name: "Prev Conflict" }).click();
// Save and Stage: the merged text, no markers; the tool closes and the file is staged
await tool.getByRole("button", { name: "Save and Stage" }).click();
let save = await sent("SaveMerge", 1);
assert.equal(save.stage, true);
assert.ok(save.text.includes('"hash": "aaa",\n  "hash": "bbb",') && save.text.includes('"version": "1.1"') && !save.text.includes("<<<<<<<"), save.text);
await tool.waitFor({ state: "detached" });
await wd.locator(".file:not(.conflict)", { hasText: "composer.lock" }).first().waitFor();

// Cancel with edits asks first; Save without Staging (▾) writes markers for what is unresolved
await page.evaluate(() => globalThis.__mockMerge());
await page.keyboard.press("F5");
await lockBand.getByRole("button", { name: "Resolve", exact: true }).click();
await page.locator(".mt-mark").nth(1).waitFor();
await tool.getByRole("button", { name: "Take theirs for hunk 5" }).click();
await tool.getByRole("button", { name: "Cancel" }).click();
await tool.getByText("Discard your merge edits?").waitFor();
await tool.getByRole("button", { name: "Discard" }).click();
await tool.waitFor({ state: "detached" });
assert.equal(await count("SaveMerge"), 1);
// from the file's context menu this time (Resolve Conflict)
await lockBand.locator(".band").click({ button: "right" });
await entry("Resolve Conflict").click();
await page.locator(".mt-mark").nth(1).waitFor();
await tool.getByRole("button", { name: "Save options" }).click();
await entry("Save without Staging").click();
await tool.getByText("2 unresolved conflicts: saved as conflict markers").waitFor();
await tool.getByRole("button", { name: "Save anyway" }).click();
save = await sent("SaveMerge", 2);
assert.equal(save.stage, false);
assert.ok(save.text.includes('<<<<<<< ours\n  "hash": "aaa",\n=======\n  "hash": "bbb",\n>>>>>>> theirs\n'), save.text);
await tool.waitFor({ state: "detached" });

// a binary conflict: whole-file choice only
await page.evaluate(() => globalThis.__mockMerge("assets/logo.png"));
await page.keyboard.press("F5");
await wd.locator(".file.conflict", { hasText: "logo.png" }).getByRole("button", { name: "Resolve", exact: true }).click();
await tool.getByText("A binary file").waitFor();
assert.ok(await tool.getByRole("button", { name: "Save and Stage" }).isDisabled());
await tool.getByRole("button", { name: "Resolve Using Theirs" }).click();
assert.deepEqual(await sent("Resolve", 1), { repo: "/work/demo-repo", path: "assets/logo.png", theirs: true });
await tool.waitFor({ state: "detached" });
await page.getByRole("button", { name: "Abort merge" }).click();
await page.getByRole("button", { name: "Really abort" }).click().catch(() => {});

// ================= commit editing (Edit submenu → Req::Rewrite) =================
const row = (i) => page.locator(`#row-${i}`);
async function editMenu(r, label) {
  await r.click({ button: "right" });
  await popup.waitFor();
  await entry("Rewrite History").hover();
  await sub.waitFor();
  await entry(label, sub).click();
}
/** the mock says every commit is on origin: confirm the published-history step */
async function published() {
  await page.locator(".overlay input[placeholder='Rewrite published history?']").waitFor();
  await choose("Rewrite anyway");
  await closed();
}
const rewrites = async (n) => { await sent("Rewrite", n); return (await calls("Rewrite")).slice(-2); };

// Edit Commit Message: the message becomes an editor; ⌘↩ saves (reword)
await row(2).click();
await editMenu(row(2), "Edit Message");
const ed = page.getByRole("textbox", { name: "Edit commit message" });
await ed.waitFor();
assert.match(await ed.inputValue(), /^\[25505977\]: /);
await ed.fill("Better message\n\nWith a body");
await page.keyboard.press("Meta+Enter");
await published();
let [first, retry] = await rewrites(2);
assert.deepEqual(first, { repo: "/work/demo-repo", action: "reword", commits: [oid(2)], message: "Better message\n\nWith a body", published_ok: false });
assert.equal(retry.published_ok, true);
await ed.waitFor({ state: "detached" });
// Esc cancels an edit
await editMenu(row(2), "Edit Message");
await ed.waitFor();
await ed.press("Escape");
await ed.waitFor({ state: "detached" });

// Squash with Parent / Move Commit Down / Drop (confirmed)
let n = await count("Rewrite");
await editMenu(row(3), "Squash into Parent");
await published();
assert.deepEqual((await rewrites(n + 2))[1], { repo: "/work/demo-repo", action: "squash", commits: [oid(3)], message: null, published_ok: true });
n += 2;
await editMenu(row(3), "Move Down");
await published();
assert.equal((await rewrites(n + 2))[1].action, "move_down");
n += 2;
await editMenu(row(3), "Drop Selected");
await page.locator(".overlay input[placeholder='Drop this commit?']").waitFor();
await choose("Drop 1 commit");
await published();
assert.deepEqual((await rewrites(n + 2))[1].commits, [oid(3)]);
n += 2;
// several selected: Squash Selected Commits, ignoring new messages (fixup)
await row(2).click();
await row(4).click({ modifiers: ["Shift"] });
await editMenu(row(3), "Squash Selected, Keep First Message (fixup)");
await published();
const fix = (await rewrites(n + 2))[1];
assert.equal(fix.action, "fixup");
assert.deepEqual([...fix.commits].sort(), [oid(2), oid(3), oid(4)].sort());
n += 2;

// Edit Commit Contents: the rebase stops at the commit; the banner says what to do; Continue finishes it
await row(5).click();
await editMenu(row(5), "Edit Contents");
await published();
const banner = page.getByRole("status", { name: "Operation in progress" });
await banner.getByText("Editing commit 0000000: change files and stage them").waitFor();
await wd.waitFor();
if (shots) await page.screenshot({ path: `${shots}/m6-edit-stop.png` });
await banner.getByRole("button", { name: "Continue" }).click();
assert.equal((await sent("Sequence", 1)).action, "continue");
await banner.waitFor({ state: "detached" });
n += 2;

// a rewrite that conflicts: the rebase banner with the conflicted file, Abort
await page.evaluate(() => { globalThis.__mockConflict.Rewrite = true; });
await row(6).click();
await editMenu(row(6), "Move Up");
await published();
await banner.getByText("Rebase in progress: 1 conflicted file").waitFor();
await wd.locator(".file.conflict", { hasText: "composer.lock" }).waitFor();
await page.evaluate(() => { globalThis.__mockConflict.Rewrite = false; });
await banner.getByRole("button", { name: "Abort" }).click();
await banner.getByRole("button", { name: "Really abort" }).click();
assert.equal((await sent("Sequence", 2)).action, "abort");
await banner.waitFor({ state: "detached" });

// ================= Navigate → Blame… / File History… =================
async function navigate(label) {
  await page.locator(".menubar button", { hasText: "Go" }).click();
  await entry(label).click();
  await page.locator(".overlay input[placeholder=File]").waitFor();
}
await navigate("Blame File…");
await choose("composer.json");
await closed();
await page.getByRole("tab", { name: "Blame", selected: true }).waitFor();
await page.locator(".blame .bl button").first().waitFor();
await navigate("File History…");
await choose("README.md");
await closed();
await page.getByRole("tab", { name: "History", selected: true }).waitFor();
await page.locator(".hist li").first().waitFor();
assert.match(await page.locator(".fv-head .path").innerText(), /README\.md/);

assert.deepEqual(errors, []);
await browser.close();
console.log("m6 e2e: ok");
