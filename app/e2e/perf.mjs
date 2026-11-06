// Perf harness (not an assertion test): a 300-file working copy and a 300-file commit (mock `__mockBig`), Expand
// all in each, then numbers: time until the page settles, DOM nodes, JS heap, diff/ReadFile requests, long tasks.
// Run: node e2e/perf.mjs (dev server up). Prints one JSON object per view.
import { chromium } from "playwright-core";
import { sublimeStyle } from "./preset.mjs";

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--js-flags=--expose-gc", "--enable-precise-memory-info"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 850 } })).newPage();
await sublimeStyle(page);
await page.addInitScript(() => {
  globalThis.__mockBig = true;
  globalThis.__long = { n: 0, ms: 0 };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { globalThis.__long.n++; globalThis.__long.ms += e.duration; } }).observe({ entryTypes: ["longtask"] });
});
await page.goto("http://127.0.0.1:1420");
await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();
await page.getByPlaceholder("~/projects/my-repo").fill("/work/demo-repo");
await page.getByRole("button", { name: "Open Repository", exact: true }).click();
await page.locator(".row .rb .s", { hasText: "Move DDEV" }).first().waitFor();

const sample = () => page.evaluate(() => {
  globalThis.gc?.();
  return {
    dom: document.querySelectorAll("*").length,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    diffReqs: globalThis.__mockDiffCalls.length,
    readFile: globalThis.__mockCalls.filter((r) => r && typeof r === "object" && "ReadFile" in r).length,
    longN: globalThis.__long.n, longMs: Math.round(globalThis.__long.ms),
  };
});
/** wait until requests and DOM size stop changing for 1 s (cap 90 s) */
async function settle() {
  let last = "", since = Date.now();
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    const s = await page.evaluate(() => [globalThis.__mockDiffCalls.length, document.querySelectorAll("*").length, document.querySelectorAll(".pad.hint").length].join());
    if (s !== last) { last = s; since = Date.now(); }
    else if (Date.now() - since > 1000) return Date.now() - since;
    await page.waitForTimeout(100);
  }
  return 0;
}
async function measure(name, expand) {
  await settle();
  const a = await sample();
  const t0 = Date.now();
  await expand();
  const quiet = await settle();
  const ms = Date.now() - t0 - quiet;
  const b = await sample();
  // scroll through the whole page and back: what the DOM holds at the end
  const scroller = page.locator(".dscroll").first();
  const t1 = Date.now();
  for (let k = 0; k < 40; k++) { await scroller.evaluate((e, k) => { e.scrollTop = (e.scrollHeight * k) / 39; }, k); await page.waitForTimeout(30); }
  await settle();
  const scrollMs = Date.now() - t1;
  const c = await sample();
  console.log(JSON.stringify({
    view: name, expandMs: ms, domBefore: a.dom, domExpanded: b.dom, domAfterScroll: c.dom, heapMBBefore: a.heapMB, heapMBExpanded: b.heapMB, heapMBAfterScroll: c.heapMB,
    diffReqsOnExpand: b.diffReqs - a.diffReqs, readFileOnExpand: b.readFile - a.readFile, diffReqsAfterScroll: c.diffReqs - a.diffReqs, readFileAfterScroll: c.readFile - a.readFile,
    longTasksOnExpand: b.longN - a.longN, longTaskMsOnExpand: b.longMs - a.longMs, scrollMs, longTaskMsScroll: c.longMs - b.longMs,
  }));
}

await page.locator(".workrow").click();
await page.locator(".details.work .wsec .fh", { hasText: "Working Directory" }).waitFor();
await measure("working-dir", () => page.locator(".details.work .wsec .fh", { hasText: "Working Directory" }).click());
// one 5000-line file (big/f50.php) coming into view: time to its rows, long tasks, the DOM it adds
{
  await page.locator(".dscroll").first().evaluate((e) => { e.scrollTop = 0; });
  await settle();
  const a = await sample();
  const t0 = Date.now();
  await page.locator(".details.work .file", { has: page.locator(".path", { hasText: /\/f50\.php$/ }) }).evaluate((f) => f.scrollIntoView({ block: "start" }));
  await page.locator(".details.work .file", { has: page.locator(".path", { hasText: /\/f50\.php$/ }) }).locator(".diff .half").first().waitFor();
  const ms = Date.now() - t0;
  await settle();
  const b = await sample();
  const rows = await page.locator(".details.work .file", { has: page.locator(".path", { hasText: /\/f50\.php$/ }) }).evaluate((f) => f.querySelectorAll("*").length);
  console.log(JSON.stringify({ view: "5000-line file", msToRows: ms, nodesInThatFile: rows, domTotal: b.dom, longTasks: b.longN - a.longN, longTaskMs: b.longMs - a.longMs }));
}
await page.locator(".row .rb .s", { hasText: "Move DDEV" }).first().click();
await page.getByRole("button", { name: "Expand all" }).waitFor();
await measure("commit", () => page.getByRole("button", { name: "Expand all" }).click());
await browser.close();
