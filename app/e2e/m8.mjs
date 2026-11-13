// M8: tab keys (Cmd+1..8), live updates from file events instead of polling, connection lost/reconnect, LFS warning,
// Preferences > Remote (watch state, Reinstall agent). Against the Vite dev server (mock backend).
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { sublimeStyle } from "./preset.mjs";

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 } });
const page = await ctx.newPage();
await sublimeStyle(page);
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.addInitScript(() => { globalThis.__mockWatchEvents = true; });
await page.goto("http://127.0.0.1:1420");
const mock = (k) => page.evaluate((k) => globalThis[k], k);
const open = async (path) => {
  await page.getByRole("button", { name: "New Tab" }).last().click().catch(() => {});
  await page.getByPlaceholder("~/projects/my-repo").fill(path);
  await page.getByRole("button", { name: "Open Repository", exact: true }).click();
  await page.locator(".tab.on .tab-main", { hasText: path.split("/").pop() }).waitFor();
};
await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();
await open("/work/demo-repo");
await page.locator(".row .rb .s", { hasText: "Move DDEV" }).first().waitFor();
await open("/work/other-repo");
await open("/work/lfs-repo");
const active = () => page.locator(".tab.on .tab-main").innerText().then((s) => s.trim());

// ---- every open tab is watched
await page.waitForFunction(() => globalThis.__mockWatched.length >= 3);
assert.deepEqual((await mock("__mockWatched")).slice(0, 3), ["local|/work/demo-repo", "local|/work/other-repo", "local|/work/lfs-repo"]);

// ---- LFS without git-lfs: one line on that tab only
await page.getByRole("status", { name: "Git LFS" }).waitFor();
assert.match(await page.getByRole("status", { name: "Git LFS" }).innerText(), /Git LFS.*pointer files/);

// ---- Cmd+1..8 switch tabs; past the last tab nothing happens
await page.keyboard.press("Meta+1");
await page.waitForFunction(() => document.querySelector(".tab.on .tab-main")?.textContent?.includes("demo-repo"));
assert.equal(await page.getByRole("status", { name: "Git LFS" }).count(), 0, "not on other tabs");
await page.keyboard.press("Meta+2");
await page.waitForFunction(() => document.querySelector(".tab.on .tab-main")?.textContent?.includes("other-repo"));
await page.keyboard.press("Meta+8");
await page.waitForTimeout(150);
assert.match(await active(), /other-repo/, "Cmd+8 with 3 tabs: ignored");
await page.keyboard.press("Meta+1");
await page.waitForFunction(() => document.querySelector(".tab.on .tab-main")?.textContent?.includes("demo-repo"));
// the Go menu lists them with their keys
await page.locator(".menubar button", { hasText: "Go" }).click();
const t2 = page.locator(".popup button", { has: page.locator(".l", { hasText: /^Tab 2$/ }) }).first();
assert.equal((await t2.locator(".d").innerText()).trim(), "⌘2");
await t2.click();
await page.waitForFunction(() => document.querySelector(".tab.on .tab-main")?.textContent?.includes("other-repo"));
await page.keyboard.press("Meta+1");
await page.waitForFunction(() => document.querySelector(".tab.on .tab-main")?.textContent?.includes("demo-repo"));

// ---- file events, not polling: no status calls while idle; a change event refreshes within a moment
await page.waitForTimeout(500);
const s0 = await mock("__mockStatusCalls");
await page.waitForTimeout(3600);
assert.equal(await mock("__mockStatusCalls"), s0, "no status polling while the watcher is active");
const shown = page.locator(".tabview:not(.off)");
await shown.locator(".workrow").click();
await shown.locator(".details.work .file .diff").first().waitFor();
await page.waitForTimeout(800); // the other bodies finish loading
const w0 = await page.evaluate(() => globalThis.__mockDiffCalls.filter((c) => c.work).length);
await page.evaluate(() => globalThis.__mockChange("/work/demo-repo", { work: true }));
await page.waitForFunction((n) => globalThis.__mockStatusCalls > n, s0, { timeout: 1000 });
// the status did not change, but a file may have (an agent editing a modified file): the open diffs reload
await page.waitForFunction((n) => globalThis.__mockDiffCalls.filter((c) => c.work).length > n, w0, { timeout: 1000 });
// a refs change re-reads HEAD/refs (Open + Refs), and reloads only if they differ
const opens = async () => (await mock("__mockOpens")) ?? 0;
const o0 = await opens();
await page.evaluate(() => globalThis.__mockChange("/work/demo-repo", { refs: true, work: true }));
await page.waitForFunction((n) => globalThis.__mockOpens > n, o0, { timeout: 1000 });
// the watcher gives up (limit): this repo polls again, and Preferences says why
await page.evaluate(() => globalThis.__mockChange("/work/demo-repo", { polling: "more than 8000 folders" }));
const s1 = await mock("__mockStatusCalls");
await page.waitForFunction((n) => globalThis.__mockStatusCalls > n, s1, { timeout: 4500 });

// ---- connection drops: banner, queued writes fail "connection lost", calls fail fast; back: banner gone, tab reloaded
await page.evaluate(() => { globalThis.__mockSlow.Fetch = 1500; });
await page.getByRole("button", { name: "Pull options" }).click();
await page.locator(".overlay li", { has: page.locator(".l", { hasText: /^fetch$/ }) }).click();
await page.locator(".branchbox .console .spinner").waitFor();
await page.getByRole("button", { name: "Push", exact: true }).click();
await page.evaluate(() => globalThis.__mockConnection("local", "ssh: Broken pipe"));
const banner = page.getByRole("status", { name: "Connection" });
await banner.waitFor();
assert.match(await banner.innerText(), /Disconnected, reconnecting…\s+ssh: Broken pipe/);
await page.keyboard.press("Control+Backquote");
const con = page.locator(".console-panel");
await con.waitFor();
const job = (label) => con.locator(".job", { has: page.locator(".cmd", { hasText: new RegExp(`^${label}$`) }) }).first();
await job("git push").locator(".stat", { hasText: "Failed" }).waitFor();
await job("git push").locator(".pick").click();
assert.match(await con.locator(".out").innerText(), /connection lost: ssh: Broken pipe/);
assert.ok(!(await mock("__mockJobs")).includes("Push"), "the queued push never ran");
await page.keyboard.press("Escape");
await page.evaluate(() => { delete globalThis.__mockSlow.Fetch; });
const o1 = await opens();
await page.evaluate(() => globalThis.__mockConnection("local", null));
await banner.waitFor({ state: "detached" });
await page.waitForFunction((n) => globalThis.__mockOpens > n, o1, { timeout: 2000 });

// ---- Preferences > Remote: watch state per tab, Reinstall agent for a host
await page.keyboard.press("Meta+,");
const dialog = page.getByRole("dialog", { name: "Preferences" });
await dialog.getByRole("navigation").getByRole("button", { name: "Remote", exact: true }).click();
const watching = dialog.getByRole("list", { name: "Watching" });
await watching.waitFor();
const w = await watching.innerText();
assert.match(w, /demo-repo.*Watching: polling fallback \(more than 8000 folders\)/);
assert.match(w, /other-repo.*Watching: file events/);
await dialog.getByLabel("Host").selectOption("example-host");
await dialog.getByRole("button", { name: "Reinstall agent" }).click();
await dialog.getByText(/Installed ~\/\.cache\/commitkiwi\/agent-.* on example-host; used from the next connection\./).waitFor();
assert.deepEqual(await mock("__mockReinstalled"), ["example-host"]);
await dialog.getByRole("button", { name: "Clean up old agents" }).click();
await dialog.getByText("Removed 2 old agent files (4,194,304 bytes) on example-host.").waitFor();
await dialog.getByLabel("Remove agents unused for").selectOption("0");
await dialog.getByRole("button", { name: "Clean up old agents" }).click();
await dialog.getByText("Removed 3 old agent files (4,194,304 bytes) on example-host.").waitFor();
await dialog.getByLabel("Remove agents unused for").selectOption("60");
await dialog.getByRole("button", { name: "Clean up old agents" }).click();
await dialog.getByText("Removed 2 old agent files (4,194,304 bytes) on example-host.").waitFor();
assert.deepEqual(await mock("__mockCleaned"), [["example-host", 30], ["example-host", 0], ["example-host", 60]]);
assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("commitkiwi.prefs"))).agent_cleanup_days, 60, "age saved, 'now' is not");
await page.keyboard.press("Escape");

assert.deepEqual(errors, [], "no console/page errors");
await browser.close();
console.log("m8 e2e ok");
