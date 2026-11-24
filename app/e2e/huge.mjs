// A runaway working copy (20,000 changed files, e.g. a copied vendor folder): the view pages its file cards
// instead of rendering them all. Run: node e2e/huge.mjs (dev server up).
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 850 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.addInitScript(() => { globalThis.__mockBig = 20_000; globalThis.__mockWatchEvents = true; });
await page.goto("http://127.0.0.1:1420");
await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();
await page.getByPlaceholder("~/projects/my-repo").fill("/work/demo-repo");
const t0 = Date.now();
await page.getByRole("button", { name: "Open Repository", exact: true }).click();
const view = page.locator(".tabview:not(.off)");
await view.locator(".workrow .s", { hasText: "20000 unstaged files" }).waitFor();
await view.locator(".workrow").click();
const wd = view.locator(".details.work");
await wd.locator(".file > h3").first().waitFor();
const ms = Date.now() - t0;
console.log(`${await wd.locator(".file > h3").count()} cards, ${await page.evaluate(() => document.querySelectorAll("*").length)} DOM nodes, ${ms} ms`);

assert.equal(await wd.locator(".file > h3").count(), 500, "one page of cards");
assert.equal(await wd.locator(".dtabs .dt").count(), 501, "Summary + one page of tabs");
assert.ok(await page.evaluate(() => document.querySelectorAll("*").length) < 40_000, "bounded DOM");
assert.ok(ms < 5000, `opens quickly (${ms} ms)`);
await wd.getByRole("button", { name: "Show 500 more files" }).click();
assert.equal(await wd.locator(".file > h3").count(), 1000);
// a file beyond the page, picked in the Files column, still gets its tab
await view.getByRole("tab", { name: "Files", exact: true }).click();
await view.locator(".filespane .fr").nth(999).click();
assert.match(await wd.locator(".dtabs .dt.on").innerText(), /f999\.php/);
assert.equal(await wd.locator(".file > h3").count(), 1, "the one file");

assert.deepEqual(errors, [], "no console/page errors");
console.log(`huge e2e ok (${ms} ms)`);
await browser.close();
