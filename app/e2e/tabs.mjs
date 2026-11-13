// Tab reordering: drag a tab past the threshold (insertion mark, it lands where the mark was), plain clicks and
// middle-click close still work, Escape cancels a drag, Move Tab Left/Right from the keys, palette and Go menu,
// ⌘1… follow the new order, the order survives a reload, and a reorder keeps each tab's loaded view (same DOM,
// scroll position, no new requests). Default key preset. Against the Vite dev server (mock backend).
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const ctx = await browser.newContext({ viewport: { width: 1300, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("http://127.0.0.1:1420");
await page.evaluate(() => localStorage.removeItem("commitkiwi.prefs"));
await page.reload();

const openRepo = async (path) => {
  await page.getByPlaceholder("~/projects/my-repo").fill(path);
  await page.getByRole("button", { name: "Open Repository", exact: true }).click();
  await page.locator(".tab.on .tab-main", { hasText: path.split("/").pop() }).waitFor();
};
const names = async () => (await page.locator(".tabbar .tab[data-id] .tab-main").allInnerTexts()).map((t) => t.trim());
const active = async () => (await page.locator(".tabbar .tab.on .tab-main").innerText()).trim();
const tab = (name) => page.locator(".tabbar .tab[data-id]", { hasText: name });
const box = async (name) => (await tab(name).boundingBox());
const reqs = () => page.evaluate(() => ({ ...globalThis.__mockReqs }));

await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();
for (const [i, p] of ["/work/alpha", "/work/beta", "/work/gamma", "/work/delta"].entries()) {
  if (i) await page.getByRole("button", { name: "New tab", exact: true }).click();
  await openRepo(p);
}
assert.deepEqual(await names(), ["alpha", "beta", "gamma", "delta"]);

// ---- give alpha some loaded state: a scrolled commit list, a selected commit; mark its view's DOM node
await tab("alpha").locator(".tab-main").click();
const view = page.locator(".tabview:not(.off)");
const list = view.locator(".list[data-control=commit_table]");
await list.locator(".row").first().waitFor();
await list.evaluate((e) => { e.scrollTop = 4000; });
await page.waitForTimeout(300);
await list.locator(".row").nth(3).click();
const selected = await list.locator(".row.sel .s").first().innerText();
const top = await list.evaluate((e) => e.scrollTop);
await view.evaluate((e) => { e.dataset.mark = "alpha-view"; });
const before = await reqs();

// ---- a press that moves less than the threshold is a click: no drag, the tab is selected
const b = await box("gamma");
await page.mouse.move(b.x + 20, b.y + b.height / 2);
await page.mouse.down();
await page.mouse.move(b.x + 23, b.y + b.height / 2);
assert.equal(await page.locator(".tab-drop").count(), 0, "no insertion mark under the threshold");
await page.mouse.up();
assert.equal(await active(), "gamma");
assert.deepEqual(await names(), ["alpha", "beta", "gamma", "delta"]);

// ---- drag alpha past gamma: the mark shows between gamma and delta, alpha lands there and is active
const a = await box("alpha"), d = await box("delta");
await page.mouse.move(a.x + 20, a.y + a.height / 2);
await page.mouse.down();
await page.mouse.move(a.x + 40, a.y + a.height / 2, { steps: 3 });
await page.locator(".tab-drop").waitFor();
await page.mouse.move(d.x + 5, d.y + d.height / 2, { steps: 8 });
const mark = await page.locator(".tab-drop").boundingBox();
assert.ok(Math.abs(mark.x - d.x) < 4, `mark at delta's left edge (${mark.x} vs ${d.x})`);
assert.ok(await tab("alpha").evaluate((e) => e.classList.contains("lifted")));
await page.mouse.up();
assert.equal(await page.locator(".tab-drop").count(), 0);
assert.deepEqual(await names(), ["beta", "gamma", "alpha", "delta"]);
assert.equal(await active(), "alpha");

// the moved tab kept its view: same DOM node, scroll position and selection, and nothing was requested again
assert.equal(await view.getAttribute("data-mark"), "alpha-view", "the view was not remounted or moved");
assert.equal(await list.evaluate((e) => e.scrollTop), top, "scroll position kept");
assert.equal(await list.locator(".row.sel .s").first().innerText(), selected, "selection kept");
const after = await reqs();
for (const k of ["Open", "Refs", "Count", "Log", "Graph"]) // (Status is polled on a timer)
  assert.equal(after[k] ?? 0, before[k] ?? 0, `no new ${k} request`);

// ---- Escape cancels a drag (and does nothing else); the order stays
const g = await box("gamma");
await page.mouse.move(g.x + 20, g.y + g.height / 2);
await page.mouse.down();
await page.mouse.move(g.x - 120, g.y + g.height / 2, { steps: 6 });
await page.locator(".tab-drop").waitFor();
await page.keyboard.press("Escape");
assert.equal(await page.locator(".tab-drop").count(), 0);
await page.mouse.up();
assert.deepEqual(await names(), ["beta", "gamma", "alpha", "delta"]);
assert.equal(await active(), "alpha", "a cancelled drag selects nothing");

// ---- keys: ⌃⇧PageUp / PageDown move the active tab; ⌘1… follow the new order
await page.keyboard.press("Control+Shift+PageUp");
assert.deepEqual(await names(), ["beta", "alpha", "gamma", "delta"]);
await page.keyboard.press("Control+Shift+PageUp");
await page.keyboard.press("Control+Shift+PageUp"); // already first: stays
assert.deepEqual(await names(), ["alpha", "beta", "gamma", "delta"]);
await page.keyboard.press("Control+Shift+PageDown");
assert.deepEqual(await names(), ["beta", "alpha", "gamma", "delta"]);
await page.keyboard.press("Meta+1");
assert.equal(await active(), "beta");
await page.keyboard.press("Meta+2");
assert.equal(await active(), "alpha");
await page.keyboard.press("Meta+4");
assert.equal(await active(), "delta");

// ---- palette and the Go menu
await page.keyboard.press("Meta+Shift+p");
await page.locator("[data-control=overlay_input]").fill("move tab left");
assert.match(await page.locator(".overlay li.on").innerText(), /Move Tab Left\s+⌃⇧PageUp/);
await page.keyboard.press("Enter");
assert.deepEqual(await names(), ["beta", "alpha", "delta", "gamma"]);
await page.locator(".menubar button", { hasText: "Go" }).click();
await page.locator(".popup button", { hasText: "Move Tab Right" }).click();
assert.deepEqual(await names(), ["beta", "alpha", "gamma", "delta"]);

// ---- middle-click closes a tab (not a drag, not a select)
await tab("beta").click({ button: "middle" });
assert.deepEqual(await names(), ["alpha", "gamma", "delta"]);
assert.equal(await active(), "delta");

// ---- the order is saved and comes back after a reload
await tab("delta").locator(".tab-main").click();
await page.keyboard.press("Control+Shift+PageUp");
await page.keyboard.press("Control+Shift+PageUp");
assert.deepEqual(await names(), ["delta", "alpha", "gamma"]);
assert.deepEqual((await page.evaluate(() => JSON.parse(localStorage.getItem("commitkiwi.prefs")).tabs)).map((t) => t.path), ["/work/delta", "/work/alpha", "/work/gamma"]);
await page.reload();
await page.waitForFunction(() => document.querySelectorAll(".tabbar .tab[data-id]").length === 3);
assert.deepEqual(await names(), ["delta", "alpha", "gamma"]);
assert.equal(await active(), "delta");
await page.keyboard.press("Meta+3");
assert.equal(await active(), "gamma");

// ---- Switch Repository to a recent (not open) repo opens it in the current tab, in place
await page.keyboard.press("Meta+p");
await page.locator(".overlay li", { hasText: "beta" }).waitFor();
await page.keyboard.type("beta");
await page.keyboard.press("Enter");
await page.locator(".tab.on .tab-main", { hasText: "beta" }).waitFor();
assert.deepEqual(await names(), ["delta", "alpha", "beta"]);
// ...and an open one is focused, not replaced
await page.keyboard.press("Meta+p");
await page.keyboard.type("delta");
await page.keyboard.press("Enter");
await page.locator(".tab.on .tab-main", { hasText: "delta" }).waitFor();
assert.deepEqual(await names(), ["delta", "alpha", "beta"]);

assert.deepEqual(errors, []);
await browser.close();
console.log("tabs e2e ok");
