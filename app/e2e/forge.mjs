// Create Pull/Merge Request…: open from the Repository menu, the toolbar `…` and a branch's context menu; prefill;
// push first (queued before the create); the CLI route returns the URL; the browser fallback builds the page URL;
// an unknown host is asked once; a failing CLI shows its stderr. Against the Vite dev server (mock backend).
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { sublimeStyle } from "./preset.mjs";

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 } });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:1420" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.addInitScript(() => { localStorage.removeItem("commitkiwi.prefs"); });
await sublimeStyle(page);
await page.goto("http://127.0.0.1:1420");
const mock = (k) => page.evaluate((k) => globalThis[k], k);
const set = (k, v) => page.evaluate(([k, v]) => { globalThis[k] = v; }, [k, v]);
await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();
await page.getByPlaceholder("~/projects/my-repo").fill("/work/demo-repo");
await page.getByRole("button", { name: "Open Repository", exact: true }).click();
await page.locator(".row .rb .s", { hasText: "Move DDEV" }).first().waitFor();
await set("__mockRemoteUrls", { origin: "git@github.com:acme/site.git" });
const calls = async (kind) => (await mock("__mockCalls")).filter((c) => kind in c).map((c) => c[kind]);
const dialog = page.getByRole("dialog", { name: /^Create (Pull|Merge|Pull\/Merge) Request$/ });
const route = () => dialog.getByLabel("Route").innerText();

// ---- from the Repository menu: current branch, default target, prefilled from the commits ahead, via gh
await page.locator(".menubar button", { hasText: "Remote" }).click();
await page.locator(".popup button", { hasText: "Create Pull/Merge Request…" }).click();
await dialog.waitFor();
await page.waitForFunction(() => document.querySelector("[aria-label=Route]")?.textContent === "via gh");
assert.equal(await dialog.getByLabel("Source branch").inputValue(), "feature/d11-upgrade-C");
assert.equal(await dialog.getByLabel("Target branch").inputValue(), "main");
assert.equal(await dialog.getByLabel("Title").inputValue(), "D11 upgrade C", "several commits: the branch name");
assert.equal(await dialog.getByLabel("Description").inputValue(), "- Export config\n- Upgrade core to 11.1\n  Runs the update hooks.\n\n  See the release notes.");
assert.match(await dialog.getByRole("heading").innerText(), /^Create Pull Request$/, "GitHub: pull request");
const probe = (await calls("ForgeProbe")).at(-1);
assert.deepEqual([probe.remote, probe.forge, probe.host], ["origin", "github", "github.com"]);
// ahead of the remote: push first is offered and checked
await dialog.getByLabel(/Push branch first/).waitFor();
assert.equal(await dialog.getByLabel(/Push branch first/).isChecked(), true);
await dialog.getByLabel("Title").fill("Upgrade to D11");
await dialog.getByLabel("Draft").check();
await dialog.getByLabel("Reviewers").fill("alice, org/team");
await dialog.getByLabel("Assignee").fill("@me");
const jobs0 = (await mock("__mockJobs")).length;
await dialog.getByRole("button", { name: "Create Pull Request" }).click();
await dialog.getByRole("heading", { name: "Pull Request created" }).waitFor();
assert.deepEqual((await mock("__mockJobs")).slice(jobs0), ["Push", "ForgeCreate"], "push queued before the create");
const created = (await calls("ForgeCreate")).at(-1);
assert.deepEqual({ ...created, body: undefined }, {
  repo: "/work/demo-repo", forge: "github", host: "github.com", project: "acme/site", cli_path: null, source: "feature/d11-upgrade-C", target: "main",
  title: "Upgrade to D11", body: undefined, draft: true, remove_source_branch: false, squash: false, reviewers: ["alice", "org/team"], labels: [], assignees: ["@me"],
});
assert.equal(await dialog.getByLabel("Request URL").locator(".mono").innerText(), "https://github.com/acme/site/pull/42");
// opened right away (open_request_after_create), and Open/Copy work
await page.waitForFunction(() => globalThis.__mockEditor.length > 0);
assert.deepEqual((await mock("__mockEditor")).at(-1), { template: "open {path}", path: "https://github.com/acme/site/pull/42", host: "" });
await dialog.getByRole("button", { name: "Copy" }).click();
await page.waitForFunction(async () => (await navigator.clipboard.readText()) === "https://github.com/acme/site/pull/42");
await dialog.getByRole("button", { name: "Close" }).click();
await dialog.waitFor({ state: "detached" });
// the caption follows the forge now
await page.keyboard.press("Meta+Shift+P");
await page.locator("[data-control=overlay_input]").fill("create pull");
await page.locator(".overlay li", { hasText: "Create Pull Request…" }).first().waitFor();
await page.keyboard.press("Escape");

// ---- from a branch's context menu: that branch, no upstream -> push --set-upstream; gh not logged in -> browser
await set("__mockForgeCli", { installed: true, authenticated: false });
const side = page.locator(".tabview:not(.off) .side");
await side.locator("li:not(.folder)", { has: page.locator(".go[title='Go to feature/d11-upgrade-B']") }).first().click({ button: "right" });
await page.locator(".popup button", { hasText: "Create Pull Request from feature/d11-upgrade-B…" }).click();
await dialog.waitFor();
await page.waitForFunction(() => document.querySelector("[aria-label=Route]")?.textContent?.startsWith("in your browser"));
assert.match(await route(), /gh is not logged in — run `gh auth login`/);
assert.equal(await dialog.getByLabel("Source branch").inputValue(), "feature/d11-upgrade-B", "the menu's branch, not the selection");
assert.equal(await dialog.getByLabel("Title").inputValue(), "Fix the menu", "one commit: its subject");
assert.equal(await dialog.getByLabel("Description").inputValue(), "Closes #12");
assert.match(await dialog.getByLabel(/Push branch first/).locator("..").innerText(), /no upstream: git push --set-upstream origin feature\/d11-upgrade-B/);
await dialog.getByLabel("Description").fill("Closes #12 & more");
const editor0 = (await mock("__mockEditor")).length;
const jobs1 = (await mock("__mockJobs")).length;
await dialog.getByRole("button", { name: "Create Pull Request" }).click();
await dialog.getByRole("heading", { name: "Pull Request page opened" }).waitFor();
assert.deepEqual((await mock("__mockJobs")).slice(jobs1), ["Push"], "browser route: only the push runs here");
const url = "https://github.com/acme/site/compare/main...feature/d11-upgrade-B?expand=1&title=Fix%20the%20menu&body=Closes%20%2312%20%26%20more";
assert.equal((await mock("__mockEditor")).slice(editor0)[0].path, url);
await dialog.getByRole("button", { name: "Close" }).click();

// ---- gh missing; a self-hosted host is asked once and remembered; GitLab extras; the toolbar `…`
await set("__mockForgeCli", { installed: false, authenticated: false });
await set("__mockRemoteUrls", { origin: "https://git.example.com:8443/group/sub/proj.git" });
await page.locator(".tabview:not(.off) button[aria-label='More actions']").click();
await page.locator(".popup button", { hasText: "Create Pull Request…" }).click(); // the tab's last forge until asked again
await dialog.waitFor();
await dialog.getByText("Is git.example.com GitHub or GitLab?").waitFor();
await dialog.getByRole("button", { name: "GitLab" }).click();
await page.waitForFunction(() => document.querySelector("[aria-label=Route]")?.textContent?.startsWith("in your browser"));
assert.equal(await route(), "in your browser: glab not found");
assert.match(await dialog.getByRole("heading").innerText(), /^Create Merge Request$/);
await dialog.getByLabel("Delete source branch when merged").waitFor();
assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem("commitkiwi.prefs"))).forge_hosts, { "git.example.com": "gitlab" });
await dialog.getByLabel(/Push branch first/).uncheck();
const editor1 = (await mock("__mockEditor")).length;
await dialog.getByRole("button", { name: "Create Merge Request" }).click();
await dialog.getByRole("heading", { name: "Merge Request page opened" }).waitFor();
assert.equal((await mock("__mockEditor")).slice(editor1)[0].path,
  "https://git.example.com:8443/group/sub/proj/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fd11-upgrade-C&merge_request%5Btarget_branch%5D=main"
  + "&merge_request%5Btitle%5D=D11%20upgrade%20C&merge_request%5Bdescription%5D=-%20Export%20config%0A-%20Upgrade%20core%20to%2011.1%0A%20%20Runs%20the%20update%20hooks.%0A%0A%20%20See%20the%20release%20notes.");
await dialog.getByRole("button", { name: "Close" }).click();
// asked once: the next time it is known; the CLI fails -> its stderr in the dialog and the console
await set("__mockForgeCli", { installed: true, authenticated: true });
await set("__mockForgeAhead", 0);
await set("__mockFail", { ForgeCreate: "merge request create failed: 409 Conflict: Another open merge request already exists for this source branch" });
await page.locator(".menubar button", { hasText: "Remote" }).click();
await page.locator(".popup button", { hasText: "Create Pull/Merge Request…" }).click();
await dialog.waitFor();
await page.waitForFunction(() => document.querySelector("[aria-label=Route]")?.textContent === "via glab");
assert.equal(await dialog.getByText(/GitHub or GitLab\?/).count(), 0, "not asked again");
assert.equal(await dialog.getByLabel(/Push branch first/).count(), 0, "up to date with the remote: no push");
await dialog.getByLabel("Squash commits when merged").check();
await dialog.getByRole("button", { name: "Create Merge Request" }).click();
await dialog.getByRole("alert").filter({ hasText: "Another open merge request already exists" }).waitFor();
const gl = (await calls("ForgeCreate")).length;
assert.equal(gl, 1, "the failed create never reached the mock's handler");
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
await page.keyboard.press("Control+`");
await page.locator(".console-panel .job", { hasText: "glab mr create --source-branch feature/d11-upgrade-C --target-branch main" }).waitFor();
await page.locator(".console-panel", { hasText: "Another open merge request already exists" }).waitFor();

// ---- Preferences > Git: the host map and the CLI paths
await page.keyboard.press("Meta+,");
const prefs = page.getByRole("dialog", { name: "Preferences" });
await prefs.getByRole("button", { name: "Git", exact: true }).click();
await prefs.getByLabel("Forge for git.example.com").waitFor();
assert.equal(await prefs.getByLabel("Forge for git.example.com").inputValue(), "gitlab");
await prefs.getByLabel("Forge host", { exact: true }).fill("code.corp.example");
await prefs.getByLabel("Forge kind").selectOption("github");
await prefs.getByRole("button", { name: "Add host" }).click();
await prefs.getByRole("button", { name: "Forget git.example.com" }).click();
assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem("commitkiwi.prefs"))).forge_hosts, { "code.corp.example": "github" });
await page.keyboard.press("Escape");

assert.deepEqual(errors, [], "no console/page errors");
await browser.close();
console.log("forge e2e ok");
