// Repository dashboard: every recent repository (local, remote, bulk-added) with branch, changes, ahead/behind, last
// commit and a state badge, read with `Overview` (no tabs opened); entry points (New Tab link, ⇧⌘D, palette, File
// menu); filter and sort; Fetch / fast-forward-only Pull per row (refused when diverged or without upstream, git's
// refusal reworded), through the tab's console queue when the repository is open; Fetch All with progress, at most 3
// at once, Cancel; offline hosts and broken paths. Default key preset. Against the Vite dev server (mock backend).
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const now = Math.floor(Date.now() / 1000);
const local = (p) => ({ location: "local", path: `/work/${p}` });
const recent = [local("demo-repo"), local("alpha"), local("beta"), local("gamma"), local("delta"), local("missing-repo"),
  { location: "ssh:example-host", path: "/srv/app" }, { location: "ssh:offline-box", path: "/srv/site" }];
await page.goto("http://127.0.0.1:1420");
await page.evaluate((recent) => localStorage.setItem("commitkiwi.prefs", JSON.stringify({ recent, tabs: [recent[0]] })), recent);
await page.reload();
await page.locator(".row .rb .s", { hasText: "Move DDEV" }).first().waitFor(); // demo-repo's tab came back
await page.evaluate((now) => {
  globalThis.__mockOverview = {
    "/work/alpha": { changed: 3, time: now - 60 },
    "/work/beta": { behind: 2, time: now - 7200 },
    "/work/gamma": { ahead: 1, behind: 4, time: now - 3 * 86400 },
    "/work/delta": { upstream: null, branch: "topic", time: now - 30 * 86400, subject: "Add the delta page" },
    "/work/demo-repo": { ahead: 2, time: now - 600 },
    "/srv/app": { time: now - 120 },
  };
}, now);
const opensBefore = await page.evaluate(() => globalThis.__mockOpens ?? 0);

// ---- entry point: the New Tab page's link
await page.getByRole("button", { name: "New tab", exact: true }).click();
await page.getByRole("button", { name: /^Dashboard: status of all 8 repositories/ }).click();
const dash = page.locator("main.dashboard");
const row = (name) => dash.getByRole("row", { name, exact: true });
const badge = (name) => row(name).locator(".db-badge");
await page.waitForFunction(() => document.querySelectorAll("main.dashboard .db-badge.loading").length === 0 && document.querySelectorAll("main.dashboard tbody tr").length === 8);
assert.equal(await page.locator(".tabbar .tab.on").innerText(), "Dashboard");
const badges = {};
for (const n of ["demo-repo", "alpha", "beta", "gamma", "delta", "missing-repo", "app", "site"]) badges[n] = await badge(n).innerText();
assert.deepEqual(badges, { "demo-repo": "ahead", alpha: "dirty", beta: "behind", gamma: "diverged", delta: "clean", "missing-repo": "error", app: "clean", site: "offline" });
assert.match(await row("alpha").innerText(), /alpha\s+\/work\/alpha\s+main\s+3\s+↑0 ↓0\s+1 min ago/);
assert.match(await row("delta").innerText(), /topic\s+0\s+none\s+1 mo ago Add the delta page/);
assert.match(await row("app").innerText(), /example-host:\/srv\/app/);
assert.match(await row("site").locator(".db-status").innerText(), /ssh: connect to host offline-box/);
assert.equal(await row("site").locator(".db-status.err").count(), 0, "offline is not shown as an error");
assert.match(await row("missing-repo").locator(".db-status.err").innerText(), /not a git repository/);
assert.equal(await page.evaluate(() => globalThis.__mockOpens ?? 0), opensBefore, "statuses without opening repositories");

// ---- filter and sort
const order = async () => (await dash.locator("tbody tr .db-name b").allInnerTexts());
await dash.getByLabel("Filter repositories").fill("alp");
assert.deepEqual(await order(), ["alpha"]);
await dash.getByLabel("Filter repositories").fill("zzz");
await dash.getByText("No repository matches the filter.").waitFor();
await dash.getByLabel("Filter repositories").fill("");
assert.deepEqual(await order(), ["alpha", "app", "beta", "delta", "demo-repo", "gamma", "missing-repo", "site"]);
await dash.getByLabel("Sort repositories").selectOption("dirty");
assert.equal((await order())[0], "alpha");
await dash.getByLabel("Sort repositories").selectOption("activity");
assert.deepEqual((await order()).slice(0, 6), ["alpha", "app", "demo-repo", "beta", "gamma", "delta"]);
await dash.getByLabel("Sort repositories").selectOption("name");

// ---- Pull is fast-forward only: refused before running when diverged or without an upstream
const calls = async (kind) => (await page.evaluate(() => globalThis.__mockCalls)).filter((c) => kind in c).map((c) => c[kind]);
await dash.getByRole("button", { name: "Pull gamma" }).click();
assert.match(await row("gamma").locator(".db-status.err").innerText(), /^Not a fast-forward: main and origin\/main have diverged/);
await dash.getByRole("button", { name: "Pull delta" }).click();
assert.match(await row("delta").locator(".db-status.err").innerText(), /topic has no upstream branch/);
assert.deepEqual(await calls("Pull"), [], "nothing ran");
// allowed: runs `git pull --ff-only` as a job
await dash.getByRole("button", { name: "Pull beta" }).click();
await row("beta").locator(".db-status", { hasText: "Pulled" }).waitFor();
assert.deepEqual(await calls("Pull"), [{ repo: "/work/beta", flags: ["--ff-only"] }]);
// git refuses (the upstream moved meanwhile): the same clear message
await page.evaluate(() => { globalThis.__mockFail.Pull = "fatal: Not possible to fast-forward, aborting."; });
await dash.getByRole("button", { name: "Pull beta" }).click();
await row("beta").locator(".db-status.err", { hasText: "Not a fast-forward" }).waitFor();
await page.evaluate(() => { delete globalThis.__mockFail.Pull; });

// ---- Fetch on a repository open in a tab: queued in that tab's console
await dash.getByRole("button", { name: "Fetch demo-repo" }).click();
await row("demo-repo").locator(".db-status", { hasText: "Fetched" }).waitFor();
assert.deepEqual((await calls("Fetch")).at(-1), { repo: "/work/demo-repo", flags: [], remote: null });

// ---- Fetch All: progress, at most 3 at once, offline and broken rows skipped, Cancel stops the rest
await page.evaluate(() => { globalThis.__mockSlow.Fetch = 700; globalThis.__mockJobs.length = 0; });
await dash.getByRole("button", { name: "Fetch All" }).click();
await dash.getByRole("status").filter({ hasText: /^Fetching 0 of 6…/ }).waitFor();
await page.waitForFunction(() => [...document.querySelectorAll("main.dashboard .db-status")].filter((e) => e.textContent === "Fetching…").length === 3);
assert.equal(await dash.locator(".db-status", { hasText: "Waiting…" }).count(), 3);
assert.equal(await row("site").locator(".db-status", { hasText: /Waiting|Fetching/ }).count(), 0, "offline rows are skipped");
await dash.getByRole("button", { name: "Cancel", exact: true }).click();
await dash.getByRole("status").filter({ hasText: /^Cancelled: Fetched 0 of 6$/ }).waitFor();
assert.equal(await page.evaluate(() => globalThis.__mockJobs.length), 3, "the waiting ones never started");
assert.equal(await dash.locator(".db-status.err", { hasText: "Cancelled" }).count(), 6, "running ones killed, waiting ones dropped");
// all of them
await dash.getByRole("button", { name: "Fetch All" }).click();
await dash.getByRole("status").filter({ hasText: /^Fetched 6 of 6$/ }).waitFor();
await page.evaluate(() => { globalThis.__mockSlow.Fetch = 0; });

// ---- Open in a tab; the key, the palette and the File menu come back here
await dash.getByRole("button", { name: "Open alpha" }).click();
await page.locator(".tab.on .tab-main", { hasText: "alpha" }).waitFor();
await page.keyboard.press("Meta+Shift+d");
await dash.waitFor({ state: "visible" });
assert.equal(await page.locator(".tabbar .tab.on").innerText(), "Dashboard");
await page.keyboard.press("Meta+1");
await page.keyboard.press("Meta+Shift+p");
await page.locator("[data-control=overlay_input]").fill("dashboard");
assert.match(await page.locator(".overlay li.on").innerText(), /Dashboard: Show…\s+⇧⌘D/);
await page.keyboard.press("Enter");
await dash.waitFor({ state: "visible" });
await page.keyboard.press("Meta+1");
await page.locator(".menubar button", { hasText: "File" }).click();
await page.locator(".popup button", { hasText: "Repository Dashboard" }).click();
await dash.waitFor({ state: "visible" });
// ⌘W leaves it for the New Tab page
await page.keyboard.press("Meta+w");
await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();

assert.deepEqual(errors, []);
await browser.close();
console.log("dashboard e2e ok");
