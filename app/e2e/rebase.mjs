// Interactive rebase editor: opens from the default key (unpushed commits), the Branch menu and a commit's context
// menu (from that commit); drag reorder with the handle, keyboard moves and actions, inline reword, the result
// preview, validation, the pushed-commits confirmation, Apply as one job, Undo, a conflict handing over to the
// rebase banner, and core's refusal shown in the editor. Against the Vite dev server (mock backend).
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.addInitScript(() => { localStorage.removeItem("commitkiwi.prefs"); });
await page.goto("http://127.0.0.1:1420");
const mock = (k) => page.evaluate((k) => globalThis[k], k);
await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();
await page.getByPlaceholder("~/projects/my-repo").fill("/work/demo-repo");
await page.getByRole("button", { name: "Open Repository", exact: true }).click();
await page.locator(".row .rb .s", { hasText: "Move DDEV" }).first().waitFor();
const calls = async (kind) => (await mock("__mockCalls")).filter((c) => kind in c).map((c) => c[kind]);
const oid = (i) => i.toString(16).padStart(8, "0") + "c3f19a2e".repeat(4); // the mock's ids
const dialog = page.getByRole("dialog", { name: "Interactive Rebase" });
const rows = dialog.locator(".rb-row");
const order = async () => (await rows.evaluateAll((els) => els.map((e) => e.dataset.oid))).map((o) => parseInt(o.slice(0, 8), 16));
const apply = dialog.getByRole("button", { name: "Apply" });
const row = (i) => dialog.locator(`.rb-row[data-oid="${oid(i)}"]`);
const action = (i) => row(i).locator("select");
const preview = () => dialog.getByRole("list", { name: "Result" }).locator("li").allInnerTexts();

// ---- the default key: the unpushed commits (rows 2, 1, 0), oldest at the top; nothing to apply yet
await page.keyboard.press("Meta+Alt+r");
await dialog.waitFor();
await rows.first().waitFor();
assert.deepEqual(await order(), [2, 1, 0]);
assert.deepEqual((await calls("RebasePlan")).at(-1), { repo: "/work/demo-repo", from: null });
assert.equal(await apply.isDisabled(), true);
assert.match(await dialog.locator(".ar-bar .sub").innerText(), /Nothing to change/);
assert.equal(await dialog.locator(".rb-warn").count(), 0, "nothing pushed in range");

// ---- drag the newest row (bottom) to the top by its handle
const handle = rows.nth(2).locator(".rb-handle");
const from = await handle.boundingBox(), top = await rows.nth(0).boundingBox();
await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
await page.mouse.down();
await page.mouse.move(from.x + from.width / 2, from.y - 10, { steps: 4 });
await page.mouse.move(from.x + from.width / 2, top.y + 3, { steps: 6 });
await dialog.locator(".rb-drop").waitFor();
await page.mouse.up();
assert.deepEqual(await order(), [0, 2, 1]);
assert.equal(await apply.isDisabled(), false);
// Escape during a drag cancels only the drag
await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
await page.mouse.down();
await page.mouse.move(from.x + from.width / 2, top.y + 3, { steps: 6 });
await page.keyboard.press("Escape");
await page.mouse.up();
assert.deepEqual(await order(), [0, 2, 1], "a cancelled drag moves nothing");
assert.equal(await dialog.count(), 1, "and the editor stays open");

// ---- keyboard: Alt+↓ moves the focused row, ↑/↓ move the focus, letters set the action
await rows.nth(0).focus();
await page.keyboard.press("Alt+ArrowDown");
assert.deepEqual(await order(), [2, 0, 1]);
assert.equal(await page.evaluate(() => document.activeElement?.dataset.oid?.slice(0, 8)), oid(0).slice(0, 8), "focus follows the row");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("s");
assert.equal(await action(1).inputValue(), "squash");
// (the mock's short ids all read 0000000)
assert.deepEqual(await preview(), ["0000000 [25505977]: Update the scaffolded example.settings.local.php", "0000000 [25505977]: Move DDEV, the composer platform and CI to PHP 8.3 + squash 0000000"]);
// the first row cannot join anything
await rows.nth(0).focus();
await page.keyboard.press("f");
assert.equal(await apply.isDisabled(), true);
assert.match(await dialog.locator(".ar-bar .sub").innerText(), /cannot be fixup/);
// reword inline (the dropdown works too)
await action(2).selectOption("reword");
const msg = row(2).locator("textarea");
assert.match(await msg.inputValue(), /^\[25505977\]: Update the scaffolded.*\n\nDetails of change 2\.$/s);
await msg.fill("Scaffold settings.local.php\n\nWith a body.");
assert.match((await preview())[0], /Scaffold settings\.local\.php$/);
assert.equal(await apply.isDisabled(), false);

// ---- Apply: one queued job with the todo list; the editor closes; Undo puts the branch back
const jobs0 = (await mock("__mockJobs")).length;
await apply.click();
await dialog.waitFor({ state: "detached" });
assert.deepEqual((await mock("__mockJobs")).slice(jobs0), ["InteractiveRebase"]);
assert.deepEqual((await calls("InteractiveRebase")).at(-1), {
  repo: "/work/demo-repo", base: oid(3), head: oid(0), published_ok: false, steps: [
    { oid: oid(2), action: "reword", message: "Scaffold settings.local.php\n\nWith a body." },
    { oid: oid(0), action: "pick", message: null },
    { oid: oid(1), action: "squash", message: null },
  ],
});
const undo = page.locator(".popup button:not([disabled])", { hasText: /^Undo: rebase -i/ });
for (let i = 0; ; i++) {
  await page.locator(".menubar button", { hasText: "Changes" }).click();
  await page.locator(".popup button").first().waitFor();
  if (await undo.count()) break;
  assert.ok(i < 50, `Undo: rebase -i … never became available: ${await page.locator(".popup").innerText()}`);
  await page.keyboard.press("Escape");
  await page.locator(".popup").waitFor({ state: "detached" });
  await page.waitForTimeout(100);
}
await undo.click();
await page.waitForFunction(() => globalThis.__mockCalls.some((c) => "Undo" in c && !c.Undo.check));
const u = (await calls("Undo")).filter((x) => !x.check).at(-1);
assert.equal(u.moved.head_before.oid, oid(0), "back to where the rebase started");

// ---- a commit's context menu: from that commit (row 4); pushed ones need the force-push confirmation
await page.locator(".tabview:not(.off) .row", { hasText: SUBJECT(4) }).first().click({ button: "right" });
await page.locator(".popup button", { hasText: "Rebase Interactively from Here…" }).click();
await dialog.waitFor();
await rows.first().waitFor();
assert.deepEqual(await order(), [4, 3, 2, 1, 0]);
assert.deepEqual((await calls("RebasePlan")).at(-1), { repo: "/work/demo-repo", from: oid(4) });
assert.equal(await dialog.locator(".rb-row .cl-tag", { hasText: "pushed" }).count(), 2);
await rows.nth(4).focus();
await page.keyboard.press("d");
assert.equal(await dialog.locator(".rb-warn").count(), 0, "changing only unpushed commits needs no force push");
await rows.nth(1).focus();
await page.keyboard.press("Alt+ArrowUp");
assert.deepEqual(await order(), [3, 4, 2, 1, 0]);
assert.match(await dialog.locator(".rb-warn").innerText(), /2 commits are already pushed\. Rewriting them will need a force push/);
assert.equal(await apply.isDisabled(), true, "not before the confirmation");
await dialog.locator(".rb-warn input").check();
await apply.click();
await dialog.waitFor({ state: "detached" });
const r2 = (await calls("InteractiveRebase")).at(-1);
assert.equal(r2.published_ok, true);
assert.deepEqual(r2.steps.map((s) => [parseInt(s.oid.slice(0, 8), 16), s.action]), [[3, "pick"], [4, "pick"], [2, "pick"], [1, "pick"], [0, "drop"]]);

// ---- core refuses (e.g. local changes): the editor stays open with the reason and the edits
await page.evaluate(() => { globalThis.__mockRebaseRefuse = "Commit or stash your changes first: editing commits needs a clean working directory."; });
await page.locator(".menubar button", { hasText: "Branch" }).click();
await page.locator(".popup button", { hasText: "Rebase Interactively…" }).click();
await dialog.waitFor();
await rows.first().waitFor();
await rows.nth(2).focus();
await page.keyboard.press("d");
await apply.click();
await dialog.getByRole("alert").filter({ hasText: "clean working directory" }).waitFor();
assert.equal(await action(0).inputValue(), "drop", "the edits are kept");

// ---- a conflict: the editor closes, the rebase banner takes over (Continue / Skip / Abort)
await page.evaluate(() => { globalThis.__mockRebaseRefuse = undefined; globalThis.__mockConflict.InteractiveRebase = true; });
await apply.click();
await dialog.waitFor({ state: "detached" });
const banner = page.getByRole("status", { name: "Operation in progress" });
await banner.waitFor();
assert.match(await banner.innerText(), /Rebase.*1 conflicted file/s);
await page.evaluate(() => { globalThis.__mockConflict.InteractiveRebase = false; });
await banner.getByRole("button", { name: "Abort" }).click();
await banner.getByRole("button", { name: "Really abort" }).click();
await banner.waitFor({ state: "detached" });

// ---- a merge in the range: the plan is refused with the reason
await page.evaluate(() => { globalThis.__mockPushedFrom = 50; });
await page.keyboard.press("Meta+Alt+r");
await dialog.getByRole("alert").filter({ hasText: "include a merge" }).waitFor();
assert.equal(await apply.isDisabled(), true);
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });

assert.deepEqual(errors, [], "no console/page errors");
await browser.close();
console.log("rebase e2e ok");

function SUBJECT(i) {
  const s = ["Move DDEV, the composer platform and CI to PHP 8.3", "Patch the remaining implicitly nullable params", "Update the scaffolded example.settings.local.php", "Update entity_usage to 5.0", "Update optional_end_date to 2.0"];
  return s[i];
}
