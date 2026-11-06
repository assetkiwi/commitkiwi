// The optional commit message model, against the Vite dev server (mock backend that fakes the download and the model):
// the palette downloads/deletes it with a confirmation, the empty message box shows a suggestion as its placeholder
// while something is staged, Tab takes it, typing hides it, and the palette can switch suggestions off.
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
await page.goto("http://127.0.0.1:1420");
await page.evaluate(() => { globalThis.__mockLlmSpeed = 0.5; }); // the fake download takes about a second
await page.getByPlaceholder("~/projects/my-repo").fill("/work/demo-repo");
await page.getByRole("button", { name: "Open Repository", exact: true }).click();
await page.locator(".row .rb .s", { hasText: "Move DDEV" }).first().waitFor();

const palette = async (text, item) => {
  await page.keyboard.press("Meta+Shift+P");
  await page.locator("[data-control=overlay_input]").fill(text);
  await page.locator(".overlay li", { hasText: item }).first().click();
};
const pick = async (text) => page.locator(".overlay li", { hasText: text }).first().click();
// the message text without the placeholder (it renders inside the editor)
const msg = () => page.evaluate(() => [...document.querySelectorAll(".commitbox .cm-line")].map((l) => (l.querySelector(".cm-placeholder") ? "" : l.textContent)).join("\n"));

// ---- the working directory has one staged file; without a model nothing is suggested
await page.locator(".workrow").click();
await page.locator(".workrow .s", { hasText: "1 staged file" }).waitFor();
const box = page.locator(".commitbox .msged");
const placeholder = box.locator(".cm-placeholder");
assert.equal((await placeholder.innerText()).trim(), "Commit Message");
await page.waitForTimeout(2200);
assert.equal(await page.locator(".commitbox .sugg").count(), 0, "no model downloaded: no suggestion");

// ---- palette: download with a confirmation step that names the size and the source
await palette("download commit", "Download Commit Message Model…");
await page.locator(".overlay li", { hasText: "Qwen3.5 2B" }).first().waitFor();
assert.match(await page.locator(".overlay li", { hasText: "Qwen3.5 2B" }).first().innerText(), /1\.28 GB.*Recommended/s);
await pick("Qwen3.5 2B");
await page.locator("[data-control=overlay_input]").waitFor();
assert.match(await page.locator(".overlay input").first().getAttribute("placeholder"), /1\.28 GB from huggingface\.co/);
await pick("Cancel");
await page.locator(".overlay").waitFor({ state: "detached" });
assert.equal(await page.locator("[data-testid=model-download]").count(), 0, "Cancel starts nothing");

await palette("download commit", "Download Commit Message Model…");
await pick("Qwen3.5 2B");
await pick("Download");
await page.locator("[data-testid=model-download]").waitFor();
await page.locator("[data-testid=model-download]").waitFor({ state: "detached" });
await page.getByText("Qwen3.5 2B (Q4_K_M) is ready").waitFor();

// ---- the suggestion appears in the placeholder after a pause, with the Tab hint
const sugg = page.locator(".commitbox .sugg");
await sugg.waitFor({ timeout: 8000 });
assert.match(await sugg.innerText(), /^feat\(mock\): change 1 file\s*\n?\s*- first file: README\.md\s*Tab$/);
const asked = await page.evaluate(() => globalThis.__mockLlmInput);
assert.deepEqual(asked.files.map((f) => [f.path, f.status]), [["README.md", "M"]]);
assert.equal(asked.branch, "feature/d11-upgrade-C");
assert.ok(asked.recent.length > 0 && asked.recent.every((s) => typeof s === "string"));
assert.equal((await msg()).trim(), "", "a suggestion is not text yet");
if (process.env.SHOTS_DIR) await page.locator(".commitbox").screenshot({ path: `${process.env.SHOTS_DIR}/llm-suggestion.png` });

// ---- Tab takes it; the box now holds the message and the commit button works with it
await page.locator(".commitbox .cm-content").click();
await page.keyboard.press("Tab");
await page.waitForFunction(() => document.querySelector(".commitbox .cm-content")?.textContent?.startsWith("feat(mock): change 1 file"));
assert.equal(await box.locator(".cm-placeholder").count(), 0);
assert.equal(await page.locator(".commitbox .split.commit .primary").first().isEnabled(), true);

// ---- clearing the box brings the suggestion back at once (kept per staged state); typing hides it
await page.keyboard.press("Meta+a");
await page.keyboard.press("Backspace");
await sugg.waitFor({ timeout: 3000 });
await page.keyboard.type("my own");
await page.waitForFunction(() => !document.querySelector(".commitbox .sugg"));

// ---- Tab without a suggestion does not insert anything
await page.keyboard.press("Meta+a");
await page.keyboard.press("Backspace");
await sugg.waitFor({ timeout: 3000 });
await palette("suggestions", "Commit Message Suggestions: Toggle"); // off
await page.waitForFunction(() => !document.querySelector(".commitbox .sugg"));
await page.locator(".commitbox .cm-content").click();
await page.keyboard.press("Tab");
assert.equal((await msg()).trim(), "", "no suggestion: Tab leaves the box empty");
await palette("suggestions", "Commit Message Suggestions: Toggle"); // on again
await sugg.waitFor({ timeout: 3000 });

// ---- palette: Generate Commit Message fills the box now
await palette("generate commit", "Generate Commit Message");
await page.waitForFunction(() => document.querySelector(".commitbox .cm-content")?.textContent?.startsWith("feat(mock)"));

// ---- the suggestion follows what is staged: one more file -> a new suggestion; nothing staged -> none; staged again -> one
await page.locator(".commitbox .cm-content").click();
await page.keyboard.press("Meta+a");
await page.keyboard.press("Backspace");
await sugg.waitFor({ timeout: 3000 });
await page.getByRole("button", { name: "Stage composer.json" }).click();
await page.locator(".workrow .s", { hasText: "2 staged files" }).waitFor();
await page.waitForFunction(() => /change 2 files/.test(document.querySelector(".commitbox .sugg")?.textContent ?? ""), null, { timeout: 8000 });
await page.keyboard.press("Meta+Shift+r"); // unstage all
await page.waitForFunction(() => !document.querySelector(".commitbox .sugg"));
await page.getByRole("button", { name: "Stage README.md" }).click();
await page.waitForFunction(() => /change 1 file\b/.test(document.querySelector(".commitbox .sugg")?.textContent ?? ""), null, { timeout: 8000 });

// ---- delete: asks first; afterwards the suggestion is gone and the model can be downloaded again
await page.locator(".commitbox .cm-content").click();
await page.keyboard.press("Meta+a");
await page.keyboard.press("Backspace");
await palette("delete commit", "Delete Commit Message Model…");
await pick("Qwen3.5 2B");
assert.match(await page.locator(".overlay input").first().getAttribute("placeholder"), /Delete Qwen3\.5 2B/);
await pick("Delete");
await page.getByText("Qwen3.5 2B (Q4_K_M) deleted").waitFor();
await page.waitForFunction(() => !document.querySelector(".commitbox .sugg"));
await palette("download commit", "Download Commit Message Model…");
await page.locator(".overlay li", { hasText: "Qwen3.5 2B" }).first().waitFor();
await page.keyboard.press("Escape");

// ---- cancelling a running download keeps it restartable
await page.evaluate(() => { globalThis.__mockLlmSpeed = 0.01; });
await palette("download commit", "Download Commit Message Model…");
await pick("Qwen2.5-Coder");
await pick("Download");
await page.locator("[data-testid=model-download]").waitFor();
await page.locator("[data-testid=model-download] button", { hasText: "Cancel" }).click();
await page.locator("[data-testid=model-download]").waitFor({ state: "detached" });
await page.getByText("cancelled").first().waitFor();

assert.deepEqual(errors, []);
await browser.close();
console.log("llm e2e ok");
