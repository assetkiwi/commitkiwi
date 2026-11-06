// Regression: in a horizontally scrolling unified diff every row (and its green/red background) must span the
// full scroll width, and the hunk band must stay in view. Needs no dev server: it loads app.css into a page.
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sublimeStyle } from "./preset.mjs";

const css = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
const [short, long] = ["short line", "x".repeat(300)];
const html = `<style>${css}</style><body><div style="width:600px"><div class="file card"><div class="diff mono">
<div class="ln hunk cband"><span class="acts"><button>Stage Hunk</button></span></div>
<div class="ln ctx"><span>1</span><span>1</span><span>${short}</span></div>
<div class="ln add"><span></span><span>2</span><span>${short}</span></div>
<div class="ln del"><span>3</span><span></span><span>${short}</span></div>
<div class="ln ctx"><span>4</span><span>4</span><span>${long}</span></div>
</div></div></div></body>`;

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
await sublimeStyle(page);
await page.setContent(html);
await page.evaluate(() => { document.querySelector(".diff").scrollLeft = 400; });
const m = await page.evaluate(() => {
  const d = document.querySelector(".diff"), box = d.getBoundingClientRect(), band = d.querySelector(".cband").getBoundingClientRect();
  return { client: d.clientWidth, scroll: d.scrollWidth, rows: [...d.querySelectorAll(".ln:not(.cband)")].map((r) => Math.round(r.getBoundingClientRect().width)), bandLeft: Math.round(band.left - box.left), bandW: Math.round(band.width) };
});
await browser.close();
assert.ok(m.scroll > m.client + 500, "the long line makes the diff scroll");
assert.ok(m.rows.every((w) => w >= m.scroll - 1), `every row spans the scroll width: ${JSON.stringify(m)}`);
assert.ok(m.bandLeft <= 1 && m.bandW <= m.client + 1, `the hunk band stays in view while scrolled: ${JSON.stringify(m)}`);
console.log("rowwidth e2e ok");
