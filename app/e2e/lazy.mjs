// Lazy diff bodies + cached repo tabs, against the mock's 300-file working copy / commit (`__mockBig`) with file
// events on (`__mockWatchEvents`, so nothing polls). Run: node e2e/lazy.mjs (dev server up).
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { sublimeStyle } from "./preset.mjs";

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 850 } })).newPage();
await sublimeStyle(page);
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.addInitScript(() => { globalThis.__mockBig = true; globalThis.__mockWatchEvents = true; });
await page.goto("http://127.0.0.1:1420");
const mock = (k) => page.evaluate((k) => globalThis[k], k);
const reqs = async (kind) => (await mock("__mockReqs"))[kind] ?? 0;
const open = async (path) => {
  await page.getByRole("button", { name: "New Tab" }).last().click().catch(() => {});
  await page.getByPlaceholder("~/projects/my-repo").fill(path);
  await page.getByRole("button", { name: "Open Repository", exact: true }).click();
  await page.locator(".tab.on .tab-main", { hasText: path.split("/").pop() }).waitFor();
};
await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();
await open("/work/demo-repo");
const view = page.locator(".tabview:not(.off)");
await view.locator(".row .rb .s", { hasText: "Move DDEV" }).first().waitFor();

const wd = view.locator(".details.work");
const scroller = wd.locator(".dscroll");
const file = (name) => wd.locator(".file", { has: page.locator(".path", { hasText: new RegExp(`/${name}$`) }) });
const mounted = () => wd.locator(".lazy .diff").count();
const dom = () => page.evaluate(() => document.querySelectorAll("*").length);
/** scroll in steps, letting observers and requests catch up */
async function scrollBy(dy, steps = 6) {
  for (let i = 0; i < steps; i++) { await scroller.evaluate((e, d) => { e.scrollTop += d; }, dy / steps); await page.waitForTimeout(60); }
  await page.waitForTimeout(400);
}
const scrollTo = async (y) => { await scroller.evaluate((e, y) => { e.scrollTop = y; }, y); await page.waitForTimeout(500); };
/** the first file header at or below the view's top, and its offset from that top */
const firstHeader = () => scroller.evaluate((e) => {
  const top = e.getBoundingClientRect().top;
  const h = [...e.querySelectorAll(".file > h3")].find((x) => x.getBoundingClientRect().bottom > top);
  return { name: h.querySelector(".path").textContent, off: Math.round(h.getBoundingClientRect().top - top) };
});

// ---- Expand all on 300 files: every header renders, only bodies near the view mount and fetch
await view.locator(".workrow").click();
await view.locator(".workrow .s", { hasText: "300 unstaged files" }).waitFor();
const section = wd.locator(".wsec .fh", { hasText: "Working Directory" });
assert.equal(await wd.locator(".lazy").count(), 0, "more than 20 files: collapsed");
const d0 = (await mock("__mockDiffCalls")).length;
await section.click();
await file("f0.php").locator(".diff").waitFor();
await page.waitForTimeout(600);
assert.equal(await wd.locator(".file > h3").count(), 300);
assert.equal(await wd.locator(".lazy").count(), 300, "a body (or its placeholder) per file");
assert.ok(await mounted() < 25, `only bodies near the view mount (${await mounted()})`);
assert.ok((await mock("__mockDiffCalls")).length - d0 < 25, "only those fetch");
assert.ok(await dom() < 40_000, `bounded DOM (${await dom()})`);
// Collapse all, Expand all
await section.click();
assert.equal(await wd.locator(".lazy").count(), 0);
await section.click();
await file("f0.php").locator(".diff").waitFor();

// ---- picked lines survive the body unmounting; Stage Lines afterwards stages them
const f0 = file("f0.php");
await f0.locator(".half.add .n").first().dispatchEvent("mousedown", { button: 0 });
await page.mouse.up();
assert.equal(await f0.locator(".half.picked").count(), 1);
await scrollBy(20_000);
assert.equal(await f0.locator(".diff").count(), 0, "f0's body is gone far away");
await scrollTo(0);
await f0.locator(".half.picked").waitFor();
const nApplied = (await mock("__mockApplied")).length;
await f0.getByRole("button", { name: "Stage Lines" }).click();
await page.waitForFunction((n) => globalThis.__mockApplied.length > n, nApplied);
const ap = (await mock("__mockApplied")).at(-1);
assert.equal(ap.mode, "stage");
assert.match(ap.patch, /\+\+\+ b\/big\/f0\.php/);
assert.equal((ap.patch.match(/^\+\$/gm) ?? []).length, 1, "one picked line");

// ---- Show entire file stays on after scrolling away and back, without reading the files again
const f1 = file("f1.php");
const full = f1.getByRole("button", { name: "Show entire file" }).first();
await full.click();
assert.equal(await full.getAttribute("aria-pressed"), "true");
const reads = async () => (await mock("__mockCalls")).filter((c) => c?.ReadFile?.path === "big/f1.php").length;
const r0 = await reads();
await scrollBy(20_000);
assert.equal(await f1.locator(".diff").count(), 0);
await scrollTo(0);
await f1.locator(".diff").waitFor();
assert.equal(await f1.getByRole("button", { name: "Show entire file" }).first().getAttribute("aria-pressed"), "true");
assert.equal(await reads(), r0, "contents kept with the body's state");

// ---- the 'Show N more lines' cap on a 5000-line file, kept across unmounting
const big = file("f50.php");
await big.scrollIntoViewIfNeeded();
await big.locator(".diff").waitFor();
const more = big.locator(".more");
assert.match(await more.innerText(), /^Show 2000 more of 4401 lines$/);
await more.click();
assert.match(await more.innerText(), /^Show 2000 more of 2401 lines$/);
await scrollTo(0);
await page.waitForTimeout(300);
assert.equal(await big.locator(".diff").count(), 0);
await big.scrollIntoViewIfNeeded();
assert.match(await big.locator(".more").innerText(), /^Show 2000 more of 2401 lines$/, "the shown rows are kept");

// ---- Split / Unified switch applies to mounted bodies and to those mounting later
await scrollTo(0);
await view.getByRole("tab", { name: "Unified" }).first().click();
await f0.locator(".diff .ln.add").first().waitFor();
await file("f200.php").scrollIntoViewIfNeeded();
await file("f200.php").locator(".diff .ln.add").first().waitFor();
await view.getByRole("tab", { name: "Split" }).first().click();
await file("f200.php").scrollIntoViewIfNeeded(); // the switch changed the heights above it
await file("f200.php").locator(".diff .half.add").first().waitFor();

// ---- scroll stability: jump into the middle (bodies above never rendered), let them mount: nothing moves; then
// scroll up 1500 px in steps: the header moves down by exactly that much (bodies mounting above are compensated)
await file("f150.php").locator("h3").evaluate((h) => h.scrollIntoView({ block: "start" }));
await page.waitForTimeout(900);
const at = await firstHeader();
await page.waitForTimeout(600);
assert.deepEqual(await firstHeader(), at, "steady while bodies above mount");
const pos = () => file(at.name.split("/").pop()).locator("h3").evaluate((h) => Math.round(h.getBoundingClientRect().top));
const p0 = await pos();
await scrollBy(-1500, 10);
assert.ok(Math.abs((await pos()) - p0 - 1500) <= 3, `moved by the scroll only (${(await pos()) - p0})`);
await scrollBy(1500, 10);
assert.ok(Math.abs((await pos()) - p0) <= 3, "and back");
assert.ok(await dom() < 40_000, `still bounded after scrolling (${await dom()})`);

// ---- picking a file in the Files column opens it, mounted, in its own tab
await view.getByRole("tab", { name: "Files", exact: true }).click();
await view.locator(".filespane .fr", { hasText: "f120.php" }).click();
await wd.locator(".file .diff").waitFor();
assert.equal(await wd.locator(".file").count(), 1);
await view.getByRole("tab", { name: "Summary" }).click();
await view.getByRole("tab", { name: "Commits", exact: true }).click();

// ---- Discard / Stage on a file after scrolling away and back
await file("f250.php").scrollIntoViewIfNeeded();
await scrollTo(0);
await file("f250.php").scrollIntoViewIfNeeded();
const nCalls = (await mock("__mockCalls")).length;
await file("f250.php").getByRole("button", { name: "Stage big/f250.php" }).click();
await page.waitForFunction((n) => globalThis.__mockCalls.slice(n).some((c) => c?.Stage?.paths?.[0] === "big/f250.php"), nCalls);
await view.locator(".workrow .s", { hasText: "1 staged file, 299 unstaged files" }).waitFor();

// ---- a commit with 300 files: the Summary page, Expand all with bounded DOM
await view.locator(".row .rb .s", { hasText: "Move DDEV" }).first().click();
const cd = view.locator(".details:not(.work)");
await cd.locator(".kv").waitFor();
await cd.getByRole("button", { name: "Expand all" }).click();
await cd.locator(".file .diff").first().waitFor();
await page.waitForTimeout(500);
assert.equal(await cd.locator(".file > h3").count(), 300);
assert.ok(await cd.locator(".lazy .diff").count() < 25);
assert.ok(await dom() < 40_000, `bounded DOM on the commit (${await dom()})`);
await cd.getByRole("button", { name: "Collapse all" }).click();
assert.equal(await cd.locator(".lazy").count(), 0);

// ---- repo tabs stay loaded: A -> B -> A shows the same state without "Loading…" or new requests
const list = view.locator(".list").first();
await list.evaluate((e) => { e.scrollTop = 5600; });
await page.waitForTimeout(300);
await view.locator(".row .rb .s").nth(3).click();
const selText = await view.locator(".row.sel .rb .s").innerText();
const listTop = await list.evaluate((e) => e.scrollTop);
await open("/work/other-repo");
await page.locator(".tabview:not(.off) .workrow .s").filter({ hasNotText: "Checking…" }).waitFor();
await page.waitForTimeout(500);
const before = { Log: await reqs("Log"), Status: await reqs("Status"), Show: await reqs("Show"), Graph: await reqs("Graph"), Refs: await reqs("Refs") };
let sawLoading = false;
const watchLoading = setInterval(() => page.evaluate(() => /Loading…|Checking…/.test(document.querySelector(".tabview:not(.off)")?.innerText ?? "")).then((v) => { sawLoading ||= v; }, () => {}), 20);
await page.locator(".tab .tab-main", { hasText: "demo-repo" }).click();
await page.locator(".tab.on .tab-main", { hasText: "demo-repo" }).waitFor();
await page.waitForTimeout(600);
clearInterval(watchLoading);
assert.equal(sawLoading, false, "no Loading…/Checking… on return");
const after = { Log: await reqs("Log"), Status: await reqs("Status"), Show: await reqs("Show"), Graph: await reqs("Graph"), Refs: await reqs("Refs") };
assert.deepEqual(after, before, "nothing re-fetched when nothing changed");
assert.equal(await view.locator(".row.sel .rb .s").innerText(), selText, "selection kept");
assert.equal(await list.evaluate((e) => e.scrollTop), listTop, "commit list scroll kept");
console.log("tab switch requests (A -> B -> A, nothing changed):", JSON.stringify({ before, after }));

// a change while hidden: the background tab takes the file event, its count is current on return
await page.locator(".tab .tab-main", { hasText: "other-repo" }).click();
await page.locator(".tab.on .tab-main", { hasText: "other-repo" }).waitFor();
await page.evaluate(() => { globalThis.__mockWorkAdd("new-while-hidden.txt"); globalThis.__mockChange("/work/demo-repo", { work: true }); });
await page.waitForTimeout(300);
await page.locator(".tab .tab-main", { hasText: "demo-repo" }).click();
await view.locator(".workrow .s", { hasText: "1 staged file, 300 unstaged files" }).waitFor({ timeout: 2000 });

// ---- request timings: off by default; on from the palette, then a refresh shows up in the list
const palette = async (cmd) => {
  await page.keyboard.press("Meta+Shift+p");
  await page.locator(".overlay input").fill(cmd);
  await page.locator(".overlay li.on").click();
};
await palette("Show Request Timings");
assert.match(await page.locator(".overlay li").first().innerText(), /Turn request timing on/);
await page.locator(".overlay li").first().click();
assert.match(await page.locator(".overlay li").first().innerText(), /Turn request timing off/);
await page.keyboard.press("Escape");
await palette("View: Refresh");
await page.waitForTimeout(400);
await palette("Show Request Timings");
const rowsText = await page.locator(".overlay li").allInnerTexts();
assert.ok(rowsText.some((t) => /Status\s+demo-repo/.test(t) && /ms · wait 0 · call/.test(t)), rowsText.slice(0, 4).join(" / "));
await page.keyboard.press("Escape");

assert.deepEqual(errors, [], "no console/page errors");
console.log("lazy e2e ok");
await browser.close();
