// Fewer blinks: a refresh changes the screen in place. Against the Vite dev server (mock backend).
//  - history changes (a ref hidden in the graph, which runs the same reload as a commit or fetch): the commit list is
//    NOT remounted (same row elements), keeps its scroll position and its selected commit, never shows an empty list
//  - a reload that changes nothing touches nothing (no new requests, no rev bump)
//  - the commit detail pane keeps the previous commit (dimmed) until the next one has loaded
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 850 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("http://127.0.0.1:1420");
await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();
await page.getByPlaceholder("~/projects/my-repo").fill("/work/demo-repo");
await page.getByRole("button", { name: "Open Repository", exact: true }).click();
await page.locator(".list .row .rb .s", { hasText: "Move DDEV" }).first().waitFor();

// ---- the list refreshes in place
await page.evaluate(() => {
  const list = document.querySelector(".list");
  list.scrollTop = 112; // two rows down
  globalThis.__rows = [...document.querySelectorAll(".list .row")];
  globalThis.__seenEmpty = false;
  // a list that blanks out (or remounts) would show no rows, or skeleton rows only, at some frame
  new MutationObserver(() => {
    const rows = document.querySelectorAll(".list .row");
    if (!rows.length || [...rows].every((r) => r.querySelector(".sk"))) globalThis.__seenEmpty = true;
  }).observe(list, { childList: true, subtree: true });
});
const before = await page.evaluate(() => ({ top: document.querySelector(".list").scrollTop, sel: document.querySelector(".list .row.sel")?.id }));
await page.getByRole("button", { name: "Hide main", exact: true }).click(); // history changes: tab.rev moves
await page.waitForTimeout(600);
const after = await page.evaluate(() => ({
  top: document.querySelector(".list").scrollTop,
  sel: document.querySelector(".list .row.sel")?.id,
  same: globalThis.__rows.every((r) => r.isConnected),
  empty: globalThis.__seenEmpty,
  rows: document.querySelectorAll(".list .row").length,
}));
assert.ok(after.same, "the row elements are the same ones: the list was not remounted");
assert.equal(after.empty, false, "the list never went empty or all-skeleton");
assert.equal(after.top, before.top, "scroll position kept");
assert.equal(after.sel, before.sel, "selected commit kept");
assert.ok(after.rows > 3);

// ---- a reload that changes nothing does nothing: no rev bump, so no refresh requests
const logs = () => page.evaluate(() => (globalThis.__mockReqs.Log ?? 0) + (globalThis.__mockReqs.Graph ?? 0));
const n0 = await logs();
await page.keyboard.press("Meta+r").catch(() => {}); // View: Refresh when bound; harmless otherwise
await page.evaluate(() => globalThis.__mockChange?.("/work/demo-repo", { refs: true, work: true }));
await page.waitForTimeout(500);
assert.equal(await logs(), n0, "nothing changed: the list was not asked for new pages");

// ---- the detail pane keeps the previous commit while the next loads, dimmed once it takes a moment
await page.locator(".list .row").nth(1).click();
await page.locator(".details .kv").waitFor();
const hash = () => page.locator(".details .kv .mono.link").first().innerText();
const h1 = await hash();
await page.evaluate(() => { globalThis.__mockDelay.Show = 900; });
await page.locator(".list").focus();
await page.keyboard.press("ArrowDown");
await page.waitForFunction(() => document.querySelector(".dscroll.waiting"), null, { timeout: 3000 });
assert.ok(await page.locator(".details .kv").isVisible(), "the previous commit stays on screen while loading");
assert.equal(await hash(), h1, "still the previous commit, consistent");
await page.waitForFunction(() => !document.querySelector(".dscroll.waiting"), null, { timeout: 5000 });
assert.notEqual(await hash(), h1, "then the new commit replaces it");

assert.deepEqual(errors, [], errors.join("\n"));
await browser.close();
console.log("smooth e2e ok");
