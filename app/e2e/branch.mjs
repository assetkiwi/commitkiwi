// M5a branch/ref overlays against the mock backend: each flow sends the right request through the console queue.
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

const calls = () => page.evaluate(() => globalThis.__mockCalls);
/** the newest request of `kind` the UI sent, waiting for it to arrive */
async function sent(kind, count = 1) {
  await page.waitForFunction(([k, n]) => globalThis.__mockCalls.filter((c) => k in c).length >= n, [kind, count]);
  return (await calls()).filter((c) => kind in c).at(-1)[kind];
}
const pills = () => page.locator(".overlay .pill").allInnerTexts();
const placeholder = () => page.locator(".overlay input").getAttribute("placeholder");
/** run a palette command by its caption */
async function palette(caption) {
  await page.keyboard.press("Meta+p");
  await page.locator(".overlay input").fill(caption);
  await page.locator(".overlay li.on .l", { hasText: caption }).waitFor();
  await page.keyboard.press("Enter");
}
/** pick a row of the current step by its label (typed, so the fuzzy filter puts it first) */
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

// ---- Create Branch (⇧⌘B): name (validated), start point, checkout option
await page.keyboard.press("Meta+Shift+b");
await page.locator(".overlay").waitFor();
assert.deepEqual(await pills(), ["Create Branch"]);
await type("--force");
await page.locator(".overlay .ov-err", { hasText: "cannot start with '-'" }).waitFor();
await type("a b");
await page.locator(".overlay .ov-err", { hasText: "spaces" }).waitFor();
await type("feature/new");
assert.deepEqual(await pills(), ["Create Branch", "feature/new"]);
assert.equal(await placeholder(), "Start Point");
if (shots) await page.screenshot({ path: `${shots}/m5a-create-branch.png` });
await choose("v2.4.0");
assert.deepEqual(await pills(), ["Create Branch", "feature/new", "v2.4.0"]);
await choose("Create and check out");
await closed();
assert.deepEqual(await sent("CreateBranch"), { repo: "/work/demo-repo", name: "feature/new", from: "refs/tags/v2.4.0", checkout: true });
await page.locator(".branch", { hasText: "feature/new" }).waitFor();

// ---- Create Branch from Remote Branch: start point first, name guessed from it
await palette("Branch: Check Out Remote as New Local…");
await choose("origin/main");
assert.equal(await page.locator(".overlay input").inputValue(), "main");
await type("main-copy");
await choose("Create only");
await closed();
assert.deepEqual(await sent("CreateBranch", 2), { repo: "/work/demo-repo", name: "main-copy", from: "refs/remotes/origin/main", checkout: false });
await page.locator(".side li", { hasText: "main-copy" }).first().waitFor(); // refs reloaded

// ---- Rename Branch
await palette("Branch: Rename…");
await choose("main-copy");
assert.equal(await page.locator(".overlay input").inputValue(), "main-copy");
await type("main-renamed");
await closed();
assert.deepEqual(await sent("RenameBranch"), { repo: "/work/demo-repo", branch: "main-copy", name: "main-renamed" });

// ---- Delete Branch: an unmerged one asks before forcing
await palette("Branch: Delete…");
await choose("feature/d11-upgrade-B");
await page.locator(".overlay .ov-err", { hasText: "not fully merged" }).waitFor();
assert.deepEqual(await pills(), ["Delete Branch", "feature/d11-upgrade-B"]);
await choose("Force delete");
await closed();
assert.deepEqual(await sent("DeleteBranch", 2), { repo: "/work/demo-repo", branch: "feature/d11-upgrade-B", force: true });
assert.equal(await page.locator(".banner", { hasText: "not fully merged" }).count(), 0, "handled in the overlay, no error banner");

// ---- Delete Remote Branch: confirmed, then push --delete
await palette("Branch: Delete on Remote…");
await choose("origin/main");
await page.locator(".overlay li.on .l", { hasText: "Delete main on origin" }).waitFor();
await page.keyboard.press("Enter");
await closed();
assert.deepEqual(await sent("DeleteRemoteBranch"), { repo: "/work/demo-repo", branch: "refs/remotes/origin/main" });

// ---- Merge Branch (from the … menu): flags as pills; excluded flags drop out; a conflict opens the Working Directory
await page.evaluate(() => { globalThis.__mockConflict.Merge = true; });
await page.getByRole("button", { name: "More actions" }).click();
await page.locator(".popup li", { hasText: "Merge into Current Branch…" }).click();
await choose("main");
await choose("--no-ff");
assert.deepEqual(await pills(), ["Merge", "main", "--no-ff"]);
const rows = await page.locator(".overlay li .l").allInnerTexts();
assert.deepEqual(rows.map((r) => r.trim()), ["merge", "--no-commit"], "--ff-only/--squash excluded by --no-ff");
if (shots) await page.screenshot({ path: `${shots}/m5a-merge-flags.png` });
await choose("merge");
await closed();
assert.deepEqual(await sent("Merge"), { repo: "/work/demo-repo", rev: "refs/heads/main", flags: ["--no-ff"] });
await page.locator(".banner", { hasText: "CONFLICT" }).waitFor();
await page.getByRole("button", { name: "Abort merge" }).waitFor(); // F4's merge UI took over
await page.evaluate(() => { globalThis.__mockConflict.Merge = false; });
await page.getByRole("button", { name: "Abort merge" }).click();
await page.getByRole("button", { name: "Really abort the merge" }).click();
await page.getByRole("button", { name: "Abort merge" }).waitFor({ state: "detached" });

// ---- Rebase: a conflict shows the Continue/Skip/Abort banner; its commands run Sequence
await page.evaluate(() => { globalThis.__mockConflict.Rebase = true; });
await palette("Branch: Rebase Current onto…");
await choose("main");
await closed();
assert.deepEqual(await sent("Rebase"), { repo: "/work/demo-repo", onto: "refs/heads/main" });
await page.evaluate(() => { globalThis.__mockConflict.Rebase = false; });
const seq = page.locator(".banner.seq");
await seq.locator(".t", { hasText: "Rebase in progress: 1 conflicted file" }).waitFor({ timeout: 5000 });
if (shots) await page.screenshot({ path: `${shots}/m5a-rebase-banner.png` });
await seq.getByRole("button", { name: "Abort" }).click();
await seq.getByRole("button", { name: "Really abort" }).click();
assert.deepEqual(await sent("Sequence"), { repo: "/work/demo-repo", action: "abort" });
await seq.waitFor({ state: "detached" });
// continue through the palette command (registered only while one is in progress)
await page.evaluate(() => { globalThis.__mockConflict.CherryPick = true; });
await palette("History: Cherry-pick…");
await choose("v2.3.0");
await closed();
assert.deepEqual(await sent("CherryPick"), { repo: "/work/demo-repo", rev: "refs/tags/v2.3.0" });
await page.evaluate(() => { globalThis.__mockConflict.CherryPick = false; });
await seq.locator(".t", { hasText: "Cherry-pick in progress" }).waitFor({ timeout: 5000 });
await palette("Cherry-pick: Continue");
await closed();
assert.deepEqual(await sent("Sequence", 2), { repo: "/work/demo-repo", action: "continue" });
await seq.waitFor({ state: "detached" });

// ---- Revert the selected commit
await page.locator("#row-3").click();
await palette("History: Revert Commit…");
await page.locator(".overlay li.on .l", { hasText: "Selected commit" }).waitFor();
await page.keyboard.press("Enter");
await closed();
assert.match((await sent("Revert")).rev, /^00000003/);

// ---- Reset: mode step; hard asks first and says what is lost
await palette("History: Reset Branch to Commit…");
await choose("v2.3.0");
assert.deepEqual(await pills(), ["Reset feature/new", "v2.3.0"]);
await choose("hard");
await page.locator(".overlay .ov-err", { hasText: "3 commits will leave feature/new" }).waitFor();
const range = await sent("CountRange"); // (not `__mockCalls.at(-1)`: a reload after the revert may land later)
assert.deepEqual(range, { repo: "/work/demo-repo", base: "refs/tags/v2.3.0", tip: range.tip });
assert.match(range.tip, /^[0-9a-f]{40}$/);
if (shots) await page.screenshot({ path: `${shots}/m5a-reset-hard.png` });
assert.equal((await calls()).filter((c) => c.Reset).length, 0, "nothing ran before the confirmation");
await choose("Cancel");
await closed();
assert.equal((await calls()).filter((c) => c.Reset).length, 0, "cancelled");
await palette("History: Reset Branch to Commit…");
await choose("v2.3.0");
await choose("soft");
await closed();
assert.deepEqual(await sent("Reset"), { repo: "/work/demo-repo", rev: "refs/tags/v2.3.0", mode: "soft" });

// ---- Tags: annotated create, push (single remote: no remote step), delete on the remote (confirmed), delete
await palette("Tag: Create…");
await type("v3.0.0");
await choose("HEAD");
await choose("Annotated");
assert.deepEqual(await pills(), ["Create Tag", "v3.0.0", (await pills())[2], "annotated"]);
await type("Release 3");
await closed();
const tag = await sent("CreateTag");
assert.deepEqual([tag.name, tag.message], ["v3.0.0", "Release 3"]);
assert.match(tag.rev, /^[0-9a-f]{40}$/, "HEAD as a commit id");
// the tag prompts list the refs as last loaded: wait for the reload after the job
await page.waitForFunction(() => { const c = globalThis.__mockCalls; return c.findLastIndex((x) => "Count" in x) > c.findLastIndex((x) => "CreateTag" in x); });
await page.waitForTimeout(100);
await palette("Tag: Push…");
await choose("v3.0.0");
await closed();
assert.deepEqual(await sent("PushTag"), { repo: "/work/demo-repo", remote: "origin", name: "v3.0.0" });
await palette("Tag: Delete on Remote…");
await choose("v3.0.0");
await choose("Delete v3.0.0 on origin");
await closed();
assert.deepEqual(await sent("DeleteRemoteTag"), { repo: "/work/demo-repo", remote: "origin", name: "v3.0.0" });
await palette("Tag: Delete…");
await choose("v3.0.0");
await closed();
assert.deepEqual(await sent("DeleteTag"), { repo: "/work/demo-repo", name: "v3.0.0" });

// ---- upstream: set (branch, then remote branch), unset (current branch)
await palette("Branch: Set Upstream");
await choose("feature/new");
await choose("origin/feature/d11-upgrade-C");
await closed();
assert.deepEqual(await sent("SetUpstream"), { repo: "/work/demo-repo", branch: "feature/new", upstream: "refs/remotes/origin/feature/d11-upgrade-C" });
await palette("Branch: Unset Upstream");
assert.deepEqual(await sent("SetUpstream", 2), { repo: "/work/demo-repo", branch: "feature/new", upstream: null });

// ---- Checkout Remote Branch (Repository menu entry's command): an existing local branch is just checked out
await palette("Branch: Check Out Remote…");
await choose("origin/feature/d11-upgrade-C");
await closed();
assert.deepEqual(await sent("Checkout"), { repo: "/work/demo-repo", name: "feature/d11-upgrade-C" });

// every write above went through the console queue
const jobs = await page.evaluate(() => globalThis.__mockJobs);
for (const k of ["CreateBranch", "RenameBranch", "DeleteBranch", "DeleteRemoteBranch", "Merge", "Rebase", "Sequence", "CherryPick", "Revert", "Reset", "CreateTag", "PushTag", "DeleteRemoteTag", "DeleteTag", "SetUpstream"]) {
  assert.ok(jobs.includes(k), `${k} ran as a console job`);
}
assert.deepEqual(errors, []);
await browser.close();
console.log("branch e2e ok");
