// A recent repository whose folder is gone is dropped from the list when opened, with a notice.
// Against the Vite dev server (mock backend).
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
const recent = [{ location: "local", path: "/work/missing-repo" }, { location: "local", path: "/work/demo-repo" }];
await page.goto("http://127.0.0.1:1420");
await page.evaluate((recent) => localStorage.setItem("commitkiwi.prefs", JSON.stringify({ recent, tabs: [] })), recent);
await page.reload();
await page.locator(".recent li button", { hasText: "missing-repo" }).click();
await page.locator(".banner", { hasText: /Removed \/work\/missing-repo/ }).waitFor();
assert.equal(await page.locator(".recent li button", { hasText: "missing-repo" }).count(), 0);
assert.equal(await page.locator(".recent li button", { hasText: "demo-repo" }).count(), 1);
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("commitkiwi.prefs")).recent.map((r) => r.path));
assert.deepEqual(saved, ["/work/demo-repo"]);
await browser.close();
console.log("gone ok");
