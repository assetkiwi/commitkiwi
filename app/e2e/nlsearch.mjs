// Natural-language search, against the Vite dev server (mock backend with a deterministic fake model): the ✨ toggle
// is disabled without a model and opens the download, a sentence becomes a reviewed keyword query (preview, chips,
// Run, Edit as Keywords), Esc cancels the model, junk and failures are handled, the mode persists, and a normal
// search never calls the model. Default key preset (⌥⌘N).
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const open = async () => {
  await page.evaluate(() => { globalThis.__mockLlmSpeed = 0.5; globalThis.__mockLlmCalls = []; });
  await page.getByPlaceholder("~/projects/my-repo").fill("/work/demo-repo");
  await page.getByRole("button", { name: "Open Repository", exact: true }).click();
  await page.locator(".row .rb .s", { hasText: "Move DDEV" }).first().waitFor();
};
await page.goto("http://127.0.0.1:1420");
await open();

const bar = page.locator(".searchbar");
const input = bar.locator("input");
const toggle = bar.locator(".nl-toggle");
const preview = page.locator(".nl-preview");
const info = bar.locator(".info");
const modelCalls = () => page.evaluate(() => (globalThis.__mockLlmCalls ?? []).filter((c) => c.kind === "search"));
const lastSearch = () => page.evaluate(() => globalThis.__mockCalls.filter((c) => c.Search).at(-1).Search.query);
const pick = async (text) => page.locator(".overlay li", { hasText: text }).first().click();

// ---- no model: the toggle shows, disabled, and opens the download
await page.keyboard.press("Meta+f");
await input.waitFor();
assert.equal(await toggle.getAttribute("aria-disabled"), "true");
assert.equal(await toggle.getAttribute("aria-pressed"), "false");
assert.equal(await toggle.getAttribute("title"), "Needs the commit message model: Preferences > Git");
await toggle.click({ force: true }); // aria-disabled: still clickable, it explains and offers the download
await page.locator(".overlay li", { hasText: "Qwen3.5 2B" }).first().waitFor();
await pick("Qwen3.5 2B");
await pick("Download");
await page.getByText("Qwen3.5 2B (Q4_K_M) is ready").waitFor();
assert.equal(await toggle.getAttribute("aria-disabled"), "false");
assert.equal(await toggle.getAttribute("title"), "Describe what you are looking for");

// ---- normal mode never asks the model (autocomplete as before)
await input.fill("");
await page.keyboard.type("fro");
await page.locator("#search-ac li").first().waitFor();
await page.keyboard.press("Tab");
await page.keyboard.type('"Alex Martin"');
await info.filter({ hasText: /results/ }).waitFor();
assert.deepEqual((await lastSearch()).author, ["Alex Martin"]);
assert.equal((await modelCalls()).length, 0, "a normal search makes no model call");

// ---- natural mode: sentence -> Interpreting… -> Esc cancels, the sentence stays
await toggle.click();
assert.equal(await toggle.getAttribute("aria-pressed"), "true");
assert.match(await input.getAttribute("placeholder"), /^Describe the commits/);
assert.equal(await input.inputValue(), "", "the sentence field starts empty");
assert.equal(await page.locator("#search-ac").count(), 0);
const sentence = "commits by alex about tokens last month";
await page.evaluate(() => { globalThis.__mockLlmDelay = 3000; });
await input.fill(sentence);
await input.press("Enter");
await info.filter({ hasText: "Interpreting…" }).waitFor();
await page.keyboard.press("Escape");
await info.filter({ hasText: "Interpreting…" }).waitFor({ state: "detached" });
assert.equal(await input.inputValue(), sentence, "Esc cancels the model, keeps the sentence and the search");
assert.equal(await preview.count(), 0);
await page.waitForTimeout(3200);
assert.equal(await preview.count(), 0, "a cancelled answer never shows");

// ---- the preview: the query (editable) and its terms as chips; the dates were resolved before the model
await page.evaluate(() => { globalThis.__mockLlmDelay = 150; });
await input.press("Enter");
await preview.waitFor();
const d = new Date();
const ymd = (y, m) => { const t = new Date(y, m, 1); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-01`; };
const [from, to] = [ymd(d.getFullYear(), d.getMonth() - 1), ymd(d.getFullYear(), d.getMonth())];
const q = preview.locator("input[data-control=search_preview]");
assert.equal(await q.inputValue(), `author:"Alex Martin" after:${from} before:${to} tokens`);
assert.deepEqual(await preview.locator(".chips li").allInnerTexts(), ['author:"Alex Martin"', `after:${from}`, `before:${to}`, "tokens"]);
const asked = (await modelCalls()).at(-1).input;
assert.equal(asked.sentence, sentence);
assert.deepEqual(asked.dates, [`after:${from}`, `before:${to}`]);
assert.ok(asked.recent_authors.includes("Alex Martin") && asked.known_paths.includes("src") && asked.branches.includes("main"));
assert.ok(asked.keywords.some((k) => k.name === "contents" && k.field === "content"), "the KEYWORDS table goes along");
assert.equal((await lastSearch()).author[0], "Alex Martin", "nothing ran yet");
assert.deepEqual((await lastSearch()).text, []);

// ---- Enter again runs it through the normal search request: filtered results
await input.press("Enter");
await page.waitForFunction(() => globalThis.__mockCalls.filter((c) => c.Search).at(-1).Search.query.text[0] === "tokens");
const ran = await lastSearch();
assert.deepEqual([ran.author, ran.text, ran.after, ran.before], [["Alex Martin"], ["tokens"], `${from} 00:00`, `${to} 00:00`]);
await info.filter({ hasText: /\d+ results/ }).waitFor();
const subjects = await page.locator(".list[data-control=commit_table] .row .s").allInnerTexts();
assert.ok(subjects.length > 0 && subjects.every((s) => s.includes("Replace tokens")), "only matching commits are listed");

// ---- the query is editable before Run
await q.fill('author:"Alex Martin" message:tokens');
await preview.getByRole("button", { name: "Run" }).click();
await page.waitForFunction(() => globalThis.__mockCalls.filter((c) => c.Search).at(-1).Search.query.message[0] === "tokens");
assert.equal((await lastSearch()).after, null);

// ---- junk from the model: left out with a warning, a word of the sentence instead; a failure: one line, sentence kept
await input.fill("show me gibberish please");
await input.press("Enter");
await preview.locator(".warn", { hasText: "Left out nope:" }).waitFor();
assert.equal(await q.inputValue(), "gibberish");
assert.match(await preview.locator(".warn").innerText(), /Left out after:soon \(not a date\)\..*searching for "gibberish" instead/);
await input.fill("explode now");
await input.press("Enter");
await bar.locator(".info.err", { hasText: "mock failure" }).waitFor();
assert.equal(await input.inputValue(), "explode now");

// ---- Edit as Keywords: the bar switches to normal mode with the query filled in
await input.fill("by alex about tokens");
await input.press("Enter");
await preview.waitFor();
await page.waitForFunction(() => document.querySelector(".nl-preview input")?.value === 'author:"Alex Martin" tokens');
await preview.getByRole("button", { name: "Edit as Keywords" }).click();
await preview.waitFor({ state: "detached" });
assert.equal(await toggle.getAttribute("aria-pressed"), "false");
assert.equal(await input.inputValue(), 'author:"Alex Martin" tokens');
assert.match(await input.getAttribute("placeholder"), /^Search commits/);

// ---- keyboard, menu and palette: ⌥⌘N opens the search in natural mode; the palette entry switches it
await page.keyboard.press("Escape");
await input.waitFor({ state: "detached" });
await page.keyboard.press("Meta+Alt+n");
await input.waitFor();
assert.equal(await toggle.getAttribute("aria-pressed"), "true");
await page.keyboard.press("Meta+Shift+p");
await page.locator("[data-control=overlay_input]").fill("natural language");
await pick("Search: Natural Language Mode");
await page.waitForFunction(() => document.querySelector(".nl-toggle")?.getAttribute("aria-pressed") === "false");
await page.locator(".menubar button", { hasText: "Go" }).click();
await page.locator(".popup button", { hasText: "Natural Language Search" }).click();
await page.waitForFunction(() => document.querySelector(".nl-toggle")?.getAttribute("aria-pressed") === "true");

// ---- the mode persists (pref natural_search); after a reload the fake model is gone again: shown off and disabled
await page.reload();
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("commitkiwi.prefs") || "{}"));
assert.equal(saved.natural_search, true);
// the open tab was saved, so it comes back by itself; the New Tab page shows only until it has loaded (clicking
// its Open button meanwhile raced the tab replacing the page)
assert.deepEqual(saved.tabs, [{ location: "local", path: "/work/demo-repo" }]);
await page.locator(".row .rb .s", { hasText: "Move DDEV" }).first().waitFor();
await page.evaluate(() => { globalThis.__mockLlmSpeed = 0.5; });
await page.keyboard.press("Meta+f");
await input.waitFor();
assert.equal(await toggle.getAttribute("aria-disabled"), "true");
assert.equal(await toggle.getAttribute("aria-pressed"), "false");
await toggle.click({ force: true }); // opens the download again; with the model back, natural mode is on without touching the toggle
await pick("Qwen3.5 2B");
await pick("Download");
await page.waitForFunction(() => document.querySelector(".nl-toggle")?.getAttribute("aria-pressed") === "true");
assert.match(await input.getAttribute("placeholder"), /^Describe the commits/);

assert.deepEqual(errors, []);
await browser.close();
console.log("nlsearch e2e ok");
