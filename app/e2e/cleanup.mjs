// Clean Up Branches…: open from the default key, the Branch menu and the BRANCHES section gear; groups with merged
// ones preselected; filter and select-all per group; merged-only deletes run at once (one job, Undo restores);
// unmerged ones need a confirmation that lists them; remote deletes need their own confirmation and say they cannot
// be undone; the stale and protected settings reach the request. Against the Vite dev server (mock backend).
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
const dialog = page.getByRole("dialog", { name: "Clean Up Branches" });
const group = (title) => dialog.getByRole("region", { name: title, exact: true });
const names = async (title) => (await group(title).locator(".cl-row .mono").allInnerTexts());
const checked = async (title) => {
  const rows = group(title).locator(".cl-row");
  const out = [];
  for (let i = 0; i < await rows.count(); i++) if (await rows.nth(i).locator("input").isChecked()) out.push(await rows.nth(i).locator(".mono").innerText());
  return out;
};
const localBtn = () => dialog.getByRole("button", { name: /^Delete \d+ local branch/ });
const remoteBtn = () => dialog.getByRole("button", { name: /^Delete \d+ remote branch/ });

// ---- the default key (⌥⌘B); defaults: 90 days, the protected list (release/2.0 is left out)
await page.keyboard.press("Meta+Alt+b");
await dialog.waitFor();
await group("Merged").waitFor();
assert.deepEqual((await calls("CleanupCandidates")).at(-1), { repo: "/work/demo-repo", stale_days: 90, protected: ["main", "master", "develop", "trunk", "release/*"] });
assert.deepEqual(await names("Merged"), ["feature/login-form", "fix/typo"]);
assert.deepEqual(await names("Upstream gone"), ["feature/old-api"]);
assert.deepEqual(await names("Stale"), ["spike/graphql"]);
assert.deepEqual(await names("Remote: merged"), ["origin/feature/login-form"]);
assert.deepEqual(await names("Remote: stale"), ["origin/experiment/cache"]);
assert.match(await group("Merged").locator(".cl-row", { hasText: "fix/typo" }).innerText(), /merged\s*stale/, "every reason is tagged");
assert.match(await group("Stale").locator(".cl-row").innerText(), /↑3 ↓3/, "ahead/behind against main");
assert.match(await group("Stale").locator(".cl-row").innerText(), /Jane Doe · \[25505977\]: Work on graphql/);
// only merged ones start selected
assert.deepEqual([await checked("Merged"), await checked("Upstream gone"), await checked("Stale"), await checked("Remote: merged"), await checked("Remote: stale")],
  [["feature/login-form", "fix/typo"], [], [], ["origin/feature/login-form"], []]);
assert.equal(await localBtn().innerText(), "Delete 2 local branches");
assert.equal(await remoteBtn().innerText(), "Delete 1 remote branch…");
assert.match(await group("Remote: merged").innerText(), /deleting these changes the remote/);

// ---- filter and select-all per group
await dialog.getByLabel("Filter branches").fill("login");
assert.deepEqual(await names("Merged"), ["feature/login-form"]);
assert.equal(await group("Stale").count(), 0);
await dialog.getByLabel("Filter branches").fill("");
await group("Merged").getByLabel("Select all Merged").uncheck();
assert.equal(await localBtn().isDisabled(), true);
assert.equal(await localBtn().innerText(), "Delete 0 local branches");
await group("Merged").getByLabel("Select all Merged").check();
assert.deepEqual(await checked("Merged"), ["feature/login-form", "fix/typo"]);

// ---- merged only: one job right away, no question; Undo restores them
const jobs0 = (await mock("__mockJobs")).length;
await localBtn().click();
await dialog.getByRole("status").filter({ hasText: "Deleted 2 branches. Undo (Changes > Undo) restores them" }).waitFor();
assert.deepEqual((await mock("__mockJobs")).slice(jobs0), ["DeleteBranches"]);
assert.deepEqual((await calls("DeleteBranches")).at(-1), { repo: "/work/demo-repo", merged: ["feature/login-form", "fix/typo"], unmerged: [] });
await group("Merged").waitFor({ state: "detached" });
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
// the menu is built when it opens and the caption follows the journal: reopen until it is there
const undo = page.locator(".popup button:not([disabled])", { hasText: "Undo: branch -d feature/login-form fix/typo" });
for (let i = 0; ; i++) {
  await page.locator(".menubar button", { hasText: "Changes" }).click();
  await page.locator(".popup button").first().waitFor();
  if (await undo.count()) break;
  assert.ok(i < 50, `Undo: branch -d … never became available: ${await page.locator(".popup").innerText()}`);
  await page.keyboard.press("Escape");
  await page.locator(".popup").waitFor({ state: "detached" });
  await page.waitForTimeout(100);
}
await undo.click();
await page.waitForFunction(() => globalThis.__mockCalls.some((c) => "Undo" in c && !c.Undo.check));

// ---- from the Branch menu: restored; an unmerged one asks first and lists what it loses
await page.locator(".menubar button", { hasText: "Branch" }).click();
await page.locator(".popup button", { hasText: "Clean Up Branches…" }).click();
await dialog.waitFor();
await group("Merged").waitFor();
assert.deepEqual(await names("Merged"), ["feature/login-form", "fix/typo"], "Undo put them back");
await group("Merged").getByLabel("fix/typo").uncheck();
await group("Stale").getByLabel("spike/graphql").check();
await group("Upstream gone").getByLabel("Select all Upstream gone").check();
assert.equal(await localBtn().innerText(), "Delete 3 local branches");
await localBtn().click();
const ask = dialog.getByRole("group", { name: "Confirm unmerged" });
await ask.waitFor();
assert.match(await ask.innerText(), /2 of these branches have commits that are not on main/);
assert.match(await ask.innerText(), /spike\/graphql\s*3 commits not on main/);
assert.match(await ask.innerText(), /feature\/old-api\s*1 commit not on main/);
// Back keeps everything; Escape also goes back first
await ask.getByRole("button", { name: "Back" }).click();
await localBtn().click();
await page.keyboard.press("Escape");
await localBtn().waitFor();
await localBtn().click();
await ask.getByRole("button", { name: "Delete 3 branches, including unmerged" }).click();
await dialog.getByRole("status").filter({ hasText: "Deleted 3 branches" }).waitFor();
assert.deepEqual((await calls("DeleteBranches")).at(-1), { repo: "/work/demo-repo", merged: ["feature/login-form"], unmerged: ["feature/old-api", "spike/graphql"] });

// ---- remote: its own confirmation, says it cannot be undone
const pushes = (await calls("DeleteRemoteBranches")).length;
await group("Remote: stale").getByLabel("origin/experiment/cache").check();
assert.equal(await remoteBtn().innerText(), "Delete 2 remote branches…");
await remoteBtn().click();
const rask = dialog.getByRole("group", { name: "Confirm remote delete" });
await rask.waitFor();
assert.match(await rask.innerText(), /This deletes 2 branches on the remote origin.*cannot be undone here/s);
assert.match(await rask.innerText(), /origin\/experiment\/cache\s*not merged: 2 commits only there/);
assert.equal((await calls("DeleteRemoteBranches")).length, pushes, "nothing ran before the confirmation");
await rask.getByRole("button", { name: "Delete on origin" }).click();
await dialog.getByRole("status").filter({ hasText: "Deleted 2 branches on origin. This cannot be undone here." }).waitFor();
assert.deepEqual((await calls("DeleteRemoteBranches")).at(-1), { repo: "/work/demo-repo", branches: ["refs/remotes/origin/experiment/cache", "refs/remotes/origin/feature/login-form"] });
assert.equal(await remoteBtn().count(), 0, "no remote candidates left");
await dialog.getByRole("button", { name: "Close" }).click();
await dialog.waitFor({ state: "detached" });

// ---- Preferences > Git: stale off and no protection reach the request; the BRANCHES gear opens it too
await page.keyboard.press("Meta+,");
const prefs = page.getByRole("dialog", { name: "Preferences" });
await prefs.getByRole("button", { name: "Git", exact: true }).click();
const box = prefs.getByRole("group", { name: "Branch cleanup" });
assert.equal(await box.getByLabel(/Protected/).inputValue(), "main, master, develop, trunk, release/*");
await box.getByLabel(/Stale after/).fill("0");
await box.getByLabel(/Stale after/).press("Tab");
await box.getByLabel(/Protected/).fill("");
await box.getByLabel(/Protected/).press("Tab");
await page.keyboard.press("Escape");
await prefs.waitFor({ state: "detached" });
const saved = JSON.parse(await page.evaluate(() => localStorage.getItem("commitkiwi.prefs")));
assert.deepEqual([saved.cleanup_stale_days, saved.cleanup_protected_branches], [0, []]);
await page.locator(".tabview:not(.off) button[aria-label='BRANCHES options']").click();
await page.locator(".popup button", { hasText: "Clean Up Branches…" }).click();
await dialog.waitFor();
await group("Merged").waitFor();
assert.deepEqual((await calls("CleanupCandidates")).at(-1), { repo: "/work/demo-repo", stale_days: 0, protected: [] });
assert.deepEqual(await names("Merged"), ["fix/typo", "release/2.0"], "release/2.0 is not protected now");
assert.doesNotMatch(await group("Merged").locator(".cl-row", { hasText: "fix/typo" }).innerText(), /stale/, "stale is off");
assert.match(await dialog.locator(".ar-form .hint").first().innerText(), /^Merged into main or HEAD, or the upstream is gone/);

assert.deepEqual(errors, [], "no console/page errors");
await browser.close();
console.log("cleanup e2e ok");
