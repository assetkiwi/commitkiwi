// UI smoke test against the Vite dev server (browser mock backend). Run: pnpm e2e (dev server must be up).
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { sublimeStyle } from "./preset.mjs";

const shots = process.env.SHOTS_DIR;
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, colorScheme: "light", permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
await sublimeStyle(page);
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("http://127.0.0.1:1420");

// --- open a local repo
await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();
await page.getByPlaceholder("~/projects/my-repo").fill("/work/demo-repo");
await page.getByRole("button", { name: "Open Repository", exact: true }).click();
await page.locator(".tab.on .tab-main", { hasText: "demo-repo" }).waitFor();
await page.locator(".row .rb .s", { hasText: "Move DDEV" }).first().waitFor();
assert.match(await page.locator(".branch").innerText(), /feature\/d11-upgrade-C.*↑2 ↓0/s);
assert.ok((await page.locator(".side li").count()) >= 7, "sidebar lists refs");
assert.ok(await page.locator(".row .ref.head", { hasText: "feature/d11-upgrade-C" }).count() >= 1, "head badge on first row");

// --- file counts arrive lazily (debounced stats request)
await page.locator(".row .cnt").first().waitFor({ timeout: 3000 });

// --- virtualization: 50k commits, but only a screenful of rows in the DOM
const total = await page.locator(".list > div").first().evaluate((e) => e.getBoundingClientRect().height);
assert.ok(total > 50_000 * 56, `spacer covers all commits (${total})`);
assert.ok((await page.locator(".row").count()) < 60, "rows are virtualized");
await page.locator(".list").evaluate((e) => (e.scrollTop = 20_000 * 56));
await page.locator("#row-20000 .rb .s").waitFor({ timeout: 3000 }); // page 40 loaded on demand
await page.locator("#row-20003 .cnt").waitFor({ timeout: 3000 }); // and its counts
assert.ok((await page.locator(".row").count()) < 60, "still virtualized after jump");

// --- keyboard selection
await page.locator(".list").focus();
await page.keyboard.press("Home");
await page.locator("#row-0.sel").waitFor();
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
await page.locator("#row-2.sel").waitFor();
await page.locator(".msg", { hasText: "Update the scaffolded" }).waitFor();
await page.keyboard.press("End");
await page.locator("#row-49999.sel").waitFor();

await page.keyboard.press("Home");
// ================= M2 =================
await page.locator("#row-0.sel").waitFor();

// --- graph lanes: the merge at row 0 is a hollow node and opens a second lane that row 1 passes through
await page.locator("#row-0 svg circle[fill='var(--surface)']").waitFor({ timeout: 3000 });
await page.locator("#row-1 svg path").nth(1).waitFor({ state: "attached", timeout: 3000 }); // a vertical line has no area, so it is never "visible"
assert.ok((await page.locator("#row-1 svg path").count()) >= 2, "second lane drawn");

// --- commit detail: message, files, small commits start expanded, diffs have numbers and colors
await page.locator(".msg", { hasText: "Moves the platform to PHP 8.3" }).waitFor();
assert.equal(await page.locator(".file").count(), 6);
// F5: side-by-side is the default; a band (with "Show entire file") sits above each hunk
await page.locator(".sp .half.add", { hasText: '"php": "^8.3"' }).first().waitFor();
await page.locator(".sp .half.del", { hasText: '"php": "^8.1"' }).first().waitFor();
assert.ok(await page.locator(".file", { hasText: "composer.json" }).locator(".sp.cband").count() >= 2, "a band per hunk");
// binary (not an image): only how many bytes changed (bodies mount near the view: scroll there first)
await page.locator(".file", { hasText: "font.woff2" }).scrollIntoViewIfNeeded();
await page.locator(".file", { hasText: "font.woff2" }).getByText("Binary file: 882 bytes changed (5,120 → 6,002)").waitFor();
await page.getByRole("tab", { name: "Unified" }).first().click();
await page.locator(".diff .ln.add", { hasText: '"php": "^8.3"' }).first().waitFor();
await page.locator(".diff .ln.del", { hasText: '"php": "^8.1"' }).first().waitFor();
await page.locator(".imgdiff img").first().waitFor(); // logo.png is an image: shown, not "Binary file"
await page.getByText("Renamed from docs/old-name.md").waitFor();
assert.match(await page.locator(".kv .stats").innerText(), /^6 files changed: −2 \+26/);
if (shots) await page.screenshot({ path: `${shots}/m2-detail.png` });

// --- collapsing a file hides its diff
const firstHeader = page.locator(".file .fh").first();
await firstHeader.click();
assert.equal(await firstHeader.getAttribute("aria-expanded"), "false");
await firstHeader.click();

// ================= F4: commit summary =================
// key/value table: hash, tree, author, date (+ "committed on" when it differs), parents, branches, stats
const kv = async () => Object.fromEntries(await page.locator(".kv tr").evaluateAll((rows) => rows.map((r) => [r.querySelector("th").textContent.trim(), r.querySelector("td").textContent.trim()])));
const k0 = await kv();
assert.deepEqual(Object.keys(k0), ["Commit Hash", "Tree", "Author", "Date", "Parents", "Branches", "Stats"]);
assert.equal(k0["Commit Hash"], "00000000c3f19a2ec3f19a2ec3f19a2ec3f19a2e");
assert.match(k0.Author, /John Smith <john@example\.com>$/);
assert.match(k0.Date, /^\w{3}, \d{1,2} \w{3}, \d{4}, \d\d:\d\d · committed on \w{3}, /);
assert.equal(k0.Parents, "00000006, 00000001"); // a merge
assert.match(k0.Branches, /feature\/d11-upgrade-C.*origin\/feature\/d11-upgrade-C/);
// tab strip: Summary + a tab per file with its status; a file tab shows only that file; × closes it
const dtabs = () => page.locator(".details .dt [role=tab]").allInnerTexts();
assert.deepEqual((await dtabs()).map((t) => t.replace(/\s+/g, " ").trim()), ["Summary", "M composer.json", "M config.yaml", "A new_feature.module", "R renamed.md", "M logo.png", "M font.woff2"]);
await page.getByRole("tab", { name: "composer.json" }).click();
await page.waitForFunction(() => document.querySelectorAll(".content .file").length === 1);
await page.locator(".content .file .diff .ln.add").first().waitFor();
assert.equal(await page.locator(".kv").count(), 0, "a file tab has no summary");
await page.getByRole("button", { name: "Close composer.json" }).click();
await page.locator(".kv").waitFor();
assert.equal(await page.getByRole("tab", { name: "composer.json" }).count(), 0, "closed tab is gone");
// Collapse all / Expand all
await page.getByRole("button", { name: "Collapse all" }).click();
assert.equal(await page.locator(".content .file .diff").count(), 0);
await page.getByRole("button", { name: "Expand all" }).click();
await page.locator(".content .file .diff").first().waitFor();
if (shots) await page.screenshot({ path: `${shots}/f4-summary.png` });


// ================= M4: diff polish =================
const cj = page.locator(".file", { hasText: "composer.json" });
const diffCalls = () => page.evaluate(() => globalThis.__mockDiffCalls);

// image diff: before and after, each a real <img> from base64 (loaded async after Expand all)
await page.locator(".file", { hasText: "logo.png" }).scrollIntoViewIfNeeded();
await page.locator(".imgdiff img").nth(1).waitFor();
assert.equal(await page.locator(".imgdiff img").count(), 2);
assert.ok((await page.locator(".imgdiff img").first().getAttribute("src")).startsWith("data:image/png;base64,"));

// syntax colors and word-level marks on the paired -/+ lines
await cj.locator(".diff .ln.add .hljs-string").first().waitFor();
assert.ok((await cj.locator(".diff .ln.add mark.wd").allInnerTexts()).includes("3")); // "^8.1" -> "^8.3": the changed word is marked
assert.ok((await cj.locator(".diff .ln.del mark.wd").allInnerTexts()).includes("1"));
assert.ok(!(await cj.locator(".diff .ln.add mark.wd").allInnerTexts()).includes("php"), "shared words are not marked");
assert.ok((await cj.locator(".diff .ln.ctx").count()) >= 2, "default 3 lines of context");

// context option goes to git and the diff reloads
await page.getByLabel("Context").selectOption("0");
await page.waitForFunction(() => globalThis.__mockDiffCalls.some((c) => c.context === 0));
await page.waitForFunction(() => document.querySelectorAll(".file .diff .ln.ctx").length === 0);
await page.getByLabel("Context").selectOption("3");
await cj.locator(".diff .ln.ctx").first().waitFor();

// ignore whitespace goes to git too
await page.getByLabel("Ignore whitespace").check();
await page.waitForFunction(() => globalThis.__mockDiffCalls.some((c) => c.ignore_ws === true));
await page.getByLabel("Ignore whitespace").uncheck();

// toggles remove the decorations
await page.getByLabel("Word diff").uncheck();
await page.waitForFunction(() => document.querySelectorAll("mark.wd").length === 0);
await page.getByLabel("Word diff").check();
await page.getByLabel("Syntax colors").uncheck();
await page.waitForFunction(() => document.querySelectorAll(".file .diff [class*=hljs]").length === 0);
await page.getByLabel("Syntax colors").check();
await cj.locator(".diff .ln.add .hljs-string").first().waitFor();

// layout: with one very long line in the diff, unified rows must share one width (backgrounds span the scroll width)...
const widths = await cj.locator(".diff .ln:not(.cband)").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
assert.ok(new Set(widths).size === 1 && widths.length > 5, `unified rows differ in width: ${[...new Set(widths)]}`);
// ...while the hunk bands stay as wide as the visible pane, so their buttons never scroll away
const bandW = await cj.locator(".diff .cband").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
const paneW = await cj.locator(".diff").first().evaluate((e) => e.clientWidth);
assert.ok(bandW.length && bandW.every((w) => w <= paneW + 1), `hunk bands wider than the pane: ${bandW} vs ${paneW}`);

// split view: deletions and additions side by side on one row; settings persist
await page.getByRole("tab", { name: "Split" }).click();
await cj.locator(".sp .half.del").first().waitFor();
assert.ok(await cj.locator(".sp").filter({ has: page.locator(".half.del") }).filter({ has: page.locator(".half.add") }).count(), "del + add share a row");
assert.equal(await cj.locator(".diff .ln").count(), 0, "unified rows are gone");
// ...and in split view the divider must sit at the same x on every row, with nothing leaking out of its half
const geo = await cj.locator(".sp:not(.hunk)").evaluateAll((rows) => rows.map((r) => {
  const [l, rt] = [...r.querySelectorAll(".half")].map((h) => h.getBoundingClientRect());
  const box = r.parentElement.getBoundingClientRect();
  return { divider: Math.round(rt.left), leftOverflow: [...r.querySelectorAll(".half")][0].scrollWidth - Math.round(l.width), right: Math.round(rt.right), box: Math.round(box.right) };
}));
assert.ok(geo.length > 4);
assert.equal(new Set(geo.map((g) => g.divider)).size, 1, `divider moves between rows: ${JSON.stringify([...new Set(geo.map((g) => g.divider))])}`);
assert.ok(geo.every((g) => g.right <= g.box + 1), "right half stays inside the diff container");
assert.ok(await cj.locator(".sp .half.add", { hasText: "a very long added line" }).count() >= 1);
if (shots) await cj.screenshot({ path: `${shots}/m4-split-long.png` });
assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("commitkiwi.prefs")).diff_style), "split");
if (shots) await page.screenshot({ path: `${shots}/m4-split.png` });

// hunk history: lists commits that touched the lines; clicking one jumps to it
await cj.locator(".sp.hunk").first().getByRole("button", { name: "History" }).click();
await cj.locator(".hhist li").nth(0).waitFor();
assert.equal(await cj.locator(".hhist li").count(), 3);
await cj.locator(".hhist li button").first().click();
await page.locator("#row-20.sel").waitFor({ timeout: 3000 });

// open in editor: argument template + absolute path, nothing else
await page.locator(".list").focus();
await page.keyboard.press("Home");
await page.locator("#row-0.sel").waitFor();
await page.locator(".msg").waitFor();
await page.locator(".file", { hasText: "composer.json" }).locator(".diff, .sp").first().waitFor();
await page.getByRole("button", { name: "File actions for composer.json" }).click();
await page.getByRole("menuitem", { name: "Open in Editor" }).click();
const ed = await page.evaluate(() => globalThis.__mockEditor);
assert.deepEqual(ed.at(-1), { template: "open -t {path}", path: "/work/demo-repo/composer.json", host: "" });

// the rest of the test runs in the default side-by-side view

// --- copy hash puts the full oid on the clipboard
await page.getByTitle("Copy full hash").click();
assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "00000000c3f19a2ec3f19a2ec3f19a2ec3f19a2e");
await page.getByRole("button", { name: "Commit actions" }).click();
await page.getByRole("menuitem", { name: "Copy Message" }).click();
assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Moves the platform to PHP 8\.3/);

// --- parent chip jumps to the parent row
await page.locator(".kv .parent").first().click(); // first parent of the merge at row 0 (the side branch is rows 1-5)
await page.locator("#row-6.sel").waitFor();

// --- sidebar branch click locates the commit far down the list (virtualized) and selects it
await page.locator(".side li button", { hasText: /^main$/ }).click();
await page.locator("#row-900.sel").waitFor({ timeout: 3000 });
assert.ok((await page.locator(".row").count()) < 60, "still virtualized after sidebar jump");

// --- Files pane: lazy tree, folders first, expand, open file, blame, history, jump back
await page.getByRole("tab", { name: "Files", exact: true }).click();
await page.getByRole("tab", { name: "Tree", exact: true }).click();
await page.locator(".tn", { hasText: "README.md" }).waitFor();
const names = await page.locator(".tree .tn .t").allInnerTexts();
assert.deepEqual(names, ["src", "vendor", "README.md", "composer.json"], "dirs and submodules first");
await page.locator(".tn", { hasText: "src" }).first().click();
await page.locator(".tn", { hasText: "Controller" }).waitFor();
await page.locator(".tn", { hasText: "index.php" }).click();
await page.locator(".fv-head .path", { hasText: "src/index.php" }).waitFor();
await page.locator(".diff.code .ln", { hasText: "line 40 of src/index.php" }).waitFor();
await page.getByRole("tab", { name: "Blame" }).click();
await page.locator(".blame .grp .bl .link").first().waitFor();
assert.ok((await page.locator(".blame .grp").count()) >= 5, "blame groups by commit");
if (shots) await page.screenshot({ path: `${shots}/m2-blame.png` });
await page.getByRole("tab", { name: "History" }).click();
await page.locator(".hist li").first().waitFor();
assert.equal(await page.locator(".hist li").count(), 100);
await page.getByRole("button", { name: "Load more" }).click();
await page.waitForFunction(() => document.querySelectorAll(".hist li").length === 130);
await page.locator(".hist li").nth(1).click(); // commit (1*7)=row 7
await page.locator("#row-7.sel").waitFor({ timeout: 3000 });
assert.equal(await page.getByRole("tab", { name: "Commits" }).getAttribute("aria-selected"), "true");

// --- "View file" from a commit opens it in the Files pane with the tree following
await page.keyboard.press("Home");
await page.locator(".list").focus();
await page.keyboard.press("Home");
await page.locator("#row-0.sel").waitFor();
await page.getByRole("button", { name: "File actions for composer.json" }).click();
await page.getByRole("menuitem", { name: "Blame", exact: true }).click(); // F8: Blame replaced F4's View File
await page.locator(".fv-head .path", { hasText: "composer.json" }).waitFor();
await page.locator(".tn.sel", { hasText: "composer.json" }).waitFor();
// deleted files have no "View file"
await page.getByRole("tab", { name: "Commits", exact: true }).click();
await page.locator("#row-0.sel").waitFor();

// ================= M3 + F4: working directory summary =================
const mock = (key) => page.evaluate((k) => globalThis[k], key);
const appliedCount = async (n) => { await page.waitForFunction((n) => globalThis.__mockApplied.length >= n, n); return mock("__mockApplied"); };
const wd = page.locator(".details.work");
const unstagedFile = (name) => wd.locator(".file:not(:has(.st-S))", { hasText: name });
const stagedFile = (name) => wd.locator(".file:has(.st-S)", { hasText: name });
const pendingRow = (text) => page.waitForFunction((t) => document.querySelector(".workrow .s")?.textContent === t, text);
await page.locator(".workrow").click();
await page.locator(".workrow .s", { hasText: "1 staged file, 4 unstaged files" }).waitFor();
assert.equal(await page.locator(".workrow .m").innerText(), "Commit Changes");
assert.equal(await page.locator("#row-0.sel").count(), 0, "commit list shows no selection while working copy is open");
// every changed file stacked: unstaged ones expanded with their diff, staged ones collapsed below
assert.deepEqual(await wd.locator(".wsec .fh").allInnerTexts(), ["Working Directory", "Staged Files"]);
assert.equal(await wd.locator(".file").count(), 5);
await unstagedFile("composer.json").locator(".wdiff .diff").waitFor();
assert.equal(await stagedFile("README.md").locator(".diff").count(), 0);
assert.deepEqual((await wd.locator(".dt [role=tab]").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()),
  ["Summary", "M composer.json", "M README.md", "? new_feature.php", "? debug.log", "S README.md"]);
assert.equal(await page.locator(".commitbox .who").innerText(), "Jane Doe <jane@example.com>");

// --- the diff options bar is on the Working Directory too (same settings as commit views)
const cjw = unstagedFile("composer.json");
await wd.locator(".dtool").waitFor();
await cjw.locator(".wdiff .sp").first().waitFor();
await wd.locator(".dtool").getByRole("tab", { name: "Unified" }).click();
await page.waitForFunction(() => !document.querySelector(".details.work .wdiff .sp") && document.querySelector(".details.work .wdiff .ln"));
await wd.locator(".dtool").getByRole("tab", { name: "Split" }).click();
await cjw.locator(".wdiff .sp").first().waitFor();
await wd.getByLabel("Context").selectOption("5");
await page.waitForFunction(() => globalThis.__mockDiffCalls.some((c) => c.work && c.context === 5));
await wd.getByLabel("Context").selectOption("3");
// ignoring whitespace: the diff comes from git -w and offers no hunk/line staging (git apply could not match it)
await wd.getByLabel("Ignore whitespace").check();
await page.waitForFunction(() => globalThis.__mockDiffCalls.some((c) => c.work && c.ignore_ws === true));
await page.waitForFunction(() => ![...document.querySelectorAll(".details.work .wdiff button")].some((b) => /Stage Hunk|Discard Hunk/.test(b.textContent)));
await wd.getByLabel("Ignore whitespace").uncheck();
await cjw.getByRole("button", { name: "Stage Hunk" }).first().waitFor();
if (shots) await page.screenshot({ path: `${shots}/wd-diff-options.png` });

// --- line staging sends a patch with ONLY the picked line (unpicked + dropped, unpicked - kept as context)
// gutter click selects the line; its hunk's band swaps [Discard Hunk][Stage Hunk] for the line buttons
await cjw.locator(".wdiff .sp .half.add", { hasText: "added line" }).locator(".n").click();
await cjw.locator(".wdiff .sp .half.add.picked", { hasText: "added line" }).waitFor();
assert.equal(await cjw.getByRole("button", { name: "Stage Hunk" }).count(), 1, "only the untouched hunk keeps its hunk buttons");
await cjw.getByRole("button", { name: "Stage Lines" }).click();
let applied = await appliedCount(1);
assert.equal(applied.length, 1);
assert.equal(applied[0].mode, "stage");
assert.ok(applied[0].patch.includes("+added line"), applied[0].patch);
assert.ok(!applied[0].patch.includes("+kept") && !applied[0].patch.includes("new one"), applied[0].patch);
assert.ok(applied[0].patch.includes(" gone"), "unpicked deletion becomes context");
assert.match(applied[0].patch, /^diff --git a\/composer\.json b\/composer\.json\n/);

// --- hunk staging
await cjw.locator(".wdiff .diff .hunk").first().getByRole("button", { name: "Stage Hunk" }).click();
applied = await appliedCount(2);
assert.ok(applied[1].patch.includes("-old one") && applied[1].patch.includes("+new one") && !applied[1].patch.includes("added line"));

// --- shift-click on the left gutter picks a range of deletions only, across hunks; Discard Lines confirms
await cjw.locator(".sp .half.del", { hasText: "old one" }).locator(".n").click();
await cjw.locator(".sp .half.del", { hasText: "gone" }).locator(".n").click({ modifiers: ["Shift"] });
assert.equal(await cjw.locator(".sp .half.picked").count(), 2);
await cjw.getByRole("button", { name: "Discard Lines" }).first().click();
await cjw.getByRole("button", { name: "Really discard lines" }).first().click();
applied = await appliedCount(3);
assert.equal(applied[2].mode, "discard");
assert.ok(applied[2].patch.includes("-old one") && applied[2].patch.includes("-gone") && !applied[2].patch.includes("+added line"), applied[2].patch);
// --- "Show entire file" fills the gaps from the file contents on both sides, and toggles back
assert.equal(await cjw.locator(".sp .half", { hasText: "/* line 10 */" }).count(), 0);
await cjw.getByRole("button", { name: "Show entire file" }).first().click();
await cjw.locator(".sp .half", { hasText: "/* line 10 */" }).first().waitFor();
assert.equal(await cjw.locator(".sp .half", { hasText: "/* line 10 */" }).count(), 2);
assert.deepEqual(await cjw.locator(".sp:not(.cband)").last().locator(".n").evaluateAll((els) => els.map((e) => e.dataset.n)), ["25", "26"], "old side ends at 25, new side at 26");
await cjw.getByRole("button", { name: "Show entire file" }).first().click();
await page.waitForFunction(() => ![...document.querySelectorAll(".sp .half")].some((h) => h.textContent.includes("/* line 10 */")));
// --- whole-file highlighting (Lezer) on the untracked PHP file
await unstagedFile("new_feature.php").locator(".tok-keyword").first().waitFor();
if (shots) await wd.screenshot({ path: `${shots}/f5-workdir-split.png` });

// --- whole-file [Stage] moves the file to Staged Files; there [Unstage] and the hunk's Unstage (reverse patch)
await page.getByRole("button", { name: "Stage composer.json" }).click();
await pendingRow("2 staged files, 3 unstaged files");
await stagedFile("composer.json").locator(".fh").click(); // staged files start collapsed
await stagedFile("composer.json").locator(".wdiff .diff .hunk").first().getByRole("button", { name: "Unstage Hunk" }).click();
applied = await appliedCount(4);
assert.equal(applied[3].mode, "unstage");

// --- a file tab shows that file alone with its band buttons; × closes it
await wd.getByRole("tab", { name: "new_feature.php" }).click();
await page.waitForFunction(() => document.querySelectorAll(".details.work .file").length === 1);
assert.equal(await wd.locator(".wsec").count(), 0);
await wd.getByRole("button", { name: "Close web/new_feature.php" }).click();
await wd.locator(".wsec").first().waitFor();
assert.equal(await wd.getByRole("tab", { name: "new_feature.php" }).count(), 0);

// --- discard needs confirmation; cancel keeps the file, confirm sends Discard for exactly that path
await page.getByRole("button", { name: "Discard web/new_feature.php" }).click();
await page.getByRole("button", { name: "Cancel" }).first().click();
assert.equal(await unstagedFile("new_feature.php").count(), 1);
assert.equal((await mock("__mockCalls")).filter((c) => c.Discard).length, 0);
await page.getByRole("button", { name: "Discard web/new_feature.php" }).click();
await page.getByRole("button", { name: "Delete file" }).click();
await unstagedFile("new_feature.php").waitFor({ state: "detached" });
assert.deepEqual((await mock("__mockCalls")).find((c) => c.Discard).Discard.paths, ["web/new_feature.php"]);

// --- ignore an untracked file (its … menu)
await page.getByRole("button", { name: "File actions for debug.log" }).click();
await page.getByRole("menuitem", { name: "Ignore" }).click();
await unstagedFile("debug.log").waitFor({ state: "detached" });
assert.equal((await mock("__mockCalls")).find((c) => c.Ignore).Ignore.path, "debug.log");

// --- commit box: disabled without a message, Line/Column while typing, commits with sign-off and clears
// the commit message editor (CodeMirror): its text, without the placeholder
await page.evaluate(() => { globalThis.__msgText = () => [...document.querySelectorAll(".commitbox .cm-line")].map((l) => (l.querySelector(".cm-placeholder") ? "" : l.textContent)).join("\n"); });
const msgText = () => page.evaluate(() => globalThis.__msgText());
const commitBtn = page.locator(".commitbox .split.commit .primary").first();
assert.match(await commitBtn.innerText(), /Commit 2 files/);
assert.equal(await commitBtn.isDisabled(), true, "needs a message");
await page.getByLabel("Commit message").fill("Add the new feature\n\nWith a body");
assert.equal(await page.locator(".commitbox .who").innerText(), "Line 3, Column 12");
await page.getByLabel("Sign off").check();
await commitBtn.click();
await page.waitForFunction(() => globalThis.__mockCommits.length === 1);
const c = (await mock("__mockCommits"))[0];
assert.deepEqual([c.message, c.amend, c.signoff, c.no_verify], ["Add the new feature\n\nWith a body", false, true, false]);
assert.equal(await msgText(), "");
await pendingRow("1 unstaged file");
await page.getByRole("button", { name: "Nothing to commit" }).waitFor();

// --- amend: the checkbox and the ▾ menu's "Amend Previous Commit" are one state; it prefills the HEAD message
await page.getByLabel("Amend").check();
await page.waitForFunction(() => /Move DDEV/.test(globalThis.__msgText()));
assert.match(await commitBtn.innerText(), /Amend commit/);
await page.getByRole("button", { name: "Advanced commit options" }).click();
assert.deepEqual(await page.locator(".popup button .l").allInnerTexts(),
  ["Amend Previous Commit (--amend)", "Commit without Commit Hooks (--no-verify)", "Amend Commit without Commit Hooks (--amend --no-verify)"]);
assert.equal(await page.getByRole("menuitemcheckbox", { name: "Amend Previous Commit (--amend)" }).getAttribute("aria-checked"), "true");
await page.getByRole("menuitemcheckbox", { name: "Amend Previous Commit (--amend)" }).click();
assert.equal(await page.getByLabel("Amend").isChecked(), false);
assert.equal(await msgText(), "");
// amend without hooks from the menu
await page.getByLabel("Commit message").fill("Hookless");
await page.getByRole("button", { name: "Advanced commit options" }).click();
assert.equal(await page.getByRole("menuitem", { name: "Commit without Commit Hooks (--no-verify)" }).isDisabled(), true, "nothing staged");
await page.getByRole("menuitem", { name: "Amend Commit without Commit Hooks (--amend --no-verify)" }).click();
await page.waitForFunction(() => globalThis.__mockCommits.length === 2);
const c2 = (await mock("__mockCommits"))[1];
assert.deepEqual([c2.message, c2.amend, c2.no_verify], ["Hookless", true, true]);

// --- message history: the ▾ in the box, and ⌘; (show_commit_message_history)
await page.getByRole("button", { name: "Message history" }).click();
await page.getByRole("menuitem", { name: "Add the new feature" }).click();
assert.match(await msgText(), /With a body/);
await page.getByLabel("Commit message").fill("");
await page.locator(".dscroll").click({ position: { x: 5, y: 5 } });
await page.keyboard.press("Meta+;");
await page.getByRole("menuitem", { name: "Hookless" }).waitFor();
await page.keyboard.press("Escape");

// --- stage_all (⌘K ⌘A) and unstage_all (⇧⌘R)
await page.keyboard.press("Meta+k"); await page.keyboard.press("Meta+a");
await pendingRow("1 staged file");
assert.deepEqual((await mock("__mockCalls")).filter((c) => c.Stage).at(-1).Stage.paths, ["README.md"]);
await page.keyboard.press("Meta+Shift+r");
await pendingRow("1 unstaged file");
assert.deepEqual((await mock("__mockCalls")).filter((c) => c.Unstage).at(-1).Unstage.paths, ["README.md"]);
// ⌘9 focuses the commit message
await page.keyboard.press("Meta+9");
assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Commit message");
if (shots) await page.screenshot({ path: `${shots}/f4-work.png` });

// --- no identity configured: "Click here to set user details" asks name + email and sets them
await page.evaluate(() => { globalThis.__mockIdentity = ""; });
await page.locator("#row-3").click();
await page.locator(".workrow").click();
await page.getByRole("button", { name: "Click here to set user details" }).click();
await page.locator(".overlay .pill", { hasText: "User Details" }).waitFor();
await page.keyboard.type("New Name"); await page.keyboard.press("Enter");
await page.keyboard.type("new@example.com"); await page.keyboard.press("Enter");
await page.locator(".commitbox .who", { hasText: "New Name <new@example.com>" }).waitFor();
assert.deepEqual((await mock("__mockCalls")).find((c) => c.SetIdentity).SetIdentity, { repo: "/work/demo-repo", name: "New Name", email: "new@example.com" });

// --- merge in progress: prefilled message, unmerged file with an orange band and [Resolve ▾][Stage], merge buttons
await page.evaluate(() => globalThis.__mockMerge());
await page.keyboard.press("F5");
await page.locator(".workrow .m", { hasText: "Merge Changes" }).waitFor();
await page.waitForFunction(() => globalThis.__msgText().startsWith("Merge branch 'feature/d11-upgrade-B'"));
const lock = wd.locator(".file.conflict", { hasText: "composer.lock" });
await lock.locator(".wdiff .sp .half.add", { hasText: "<<<<<<< HEAD" }).waitFor();
assert.equal(await lock.locator(".diff.selectable").count(), 0, "no line staging on a conflicted file");
await page.getByRole("button", { name: "Resolve options for composer.lock" }).click();
assert.deepEqual(await page.locator(".popup button .l").allInnerTexts(), ["Resolve Using Ours", "Resolve Using Theirs", "Open in Editor"]);
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "Abort merge" }).waitFor();
if (shots) await page.screenshot({ path: `${shots}/f4-merge.png` });
await page.getByRole("button", { name: "Stage all unmerged files to continue" }).click();
await page.locator(".commitbox .split.commit .primary", { hasText: "Commit 1 file" }).waitFor();
assert.deepEqual((await mock("__mockCalls")).filter((c) => c.Stage).at(-1).Stage.paths, ["composer.lock"]);
await commitBtn.click();
await page.waitForFunction(() => globalThis.__mockCommits.length === 3);
assert.equal((await mock("__mockCommits"))[2].message, "Merge branch 'feature/d11-upgrade-B' into feature/d11-upgrade-C", "git's # lines are stripped");
await pendingRow("1 unstaged file");
// a second merge, aborted (with confirmation); the prefilled message goes with it
await page.evaluate(() => globalThis.__mockMerge());
await page.keyboard.press("F5");
await page.getByRole("button", { name: "Abort merge" }).click();
await page.getByRole("button", { name: "Really abort the merge" }).click();
await page.waitForFunction(() => globalThis.__mockCalls.some((c) => c.AbortMerge));
await pendingRow("1 unstaged file");
await page.waitForFunction(() => globalThis.__msgText() === "");

// --- a stash row in Locations opens the stash in the details pane
await page.locator(".side .go.stash").click();
await page.locator(".kv", { hasText: "stash@{0}" }).waitFor();
assert.match(await page.locator(".msg").innerText(), /^WIP on feature\/d11-upgrade-C/);
assert.ok(await page.locator(".content .file").count() >= 1);

// leaving the working copy: picking a commit brings back the commit view and its selection
await page.locator("#row-3").click();
await page.locator("#row-3.sel").waitFor();
await page.locator(".kv").waitFor();

// ================= F2: shell =================
// title bar shows the active repo's path; the toolbar no longer has a theme button
assert.equal((await page.locator(".titlebar > b").innerText()).trim(), "/work/demo-repo");
assert.equal(await page.evaluate(() => document.title), "/work/demo-repo");
assert.equal(await page.locator(".toolbar .theme").count(), 0);

// dirty repo: the tab shows a dot instead of the close button
await page.locator(".tab.on.dirty").waitFor();

// tab context menu: Set Alias…, Close Tab; the alias replaces the name and persists
await page.locator(".tab.on").click({ button: "right" });
assert.deepEqual(await page.locator(".popup button .l").allInnerTexts(), ["Set Alias…", "Close Tab"]);
await page.getByRole("menuitem", { name: "Set Alias" }).click();
await page.locator(".overlay .pill", { hasText: "Set Alias" }).waitFor();
assert.equal(await page.locator(".overlay input").inputValue(), "demo-repo", "starts with the current name");
await page.keyboard.type("Demo");
await page.keyboard.press("Enter");
await page.locator(".tab.on .tab-main", { hasText: "Demo" }).waitFor();
assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("commitkiwi.prefs")).aliases["local|/work/demo-repo"]), "Demo");
await page.locator(".tab.on").click({ button: "right" });
await page.getByRole("menuitem", { name: "Set Alias" }).click();
await page.keyboard.press("Backspace"); // the text is selected: this empties it
await page.keyboard.press("Enter");
await page.locator(".tab.on .tab-main", { hasText: "demo-repo" }).waitFor();

// tab list: open tabs (current ticked), then New Tab; Escape closes
await page.getByRole("button", { name: "List tabs" }).click();
assert.deepEqual(await page.locator(".popup button .l").allInnerTexts(), ["demo-repo", "New Tab"]);
assert.equal(await page.getByRole("menuitemcheckbox", { name: "demo-repo" }).getAttribute("aria-checked"), "true");
await page.keyboard.press("Escape");
await page.locator(".popup").waitFor({ state: "detached" });

// side bar layouts: menu with the current one ticked; each layout's columns; the choice persists
const cols = () => page.locator(".main > .left").evaluateAll((els) => els.map((e) => [...e.classList].find((c) => c.startsWith("col-")) + ":" +
  [...e.querySelectorAll(":scope > .colbar .seg button, :scope > .colbar .colhead")].map((b) => b.textContent.trim()).join("|")));
const pickLayout = async (name) => { await page.getByRole("button", { name: "Side bar layout" }).click(); await page.getByRole("menuitemcheckbox", { name }).click(); };
assert.deepEqual(await cols(), ["col-locations:Locations", "col-tabs:Commits|Files"], "default: Two Columns, Files on Right");
await page.getByRole("button", { name: "Side bar layout" }).click();
assert.deepEqual(await page.locator(".popup button .l").allInnerTexts(), ["One Column", "Two Columns, Files on Left", "Two Columns, Files on Right", "Three Columns"]);
assert.equal(await page.getByRole("menuitemcheckbox", { name: "Two Columns, Files on Right" }).getAttribute("aria-checked"), "true");
await page.keyboard.press("Escape");
await pickLayout("Three Columns");
assert.deepEqual(await cols(), ["col-locations:Locations", "col-commits:Commits", "col-files:Files"]);
await page.locator(".col-files .tn", { hasText: "README.md" }).waitFor();
await page.locator(".col-commits .row").first().waitFor();
if (shots) await page.screenshot({ path: `${shots}/f2-three-columns.png` });
assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("commitkiwi.prefs")).side_bar_layout), "columns");
await pickLayout("One Column");
assert.deepEqual(await cols(), ["col-tabs:Locations|Commits|Files"]);
await page.getByRole("tab", { name: "Locations" }).click();
await page.locator(".col-tabs .side li", { hasText: "main" }).first().waitFor();
await page.getByRole("tab", { name: "Commits", exact: true }).click();
await pickLayout("Two Columns, Files on Left");
assert.deepEqual(await cols(), ["col-tabs:Locations|Files", "col-commits:Commits"]);
await page.keyboard.press("Meta+k"); await page.keyboard.press("Meta+b"); // hiding the side bar closes every column
assert.deepEqual(await cols(), []);
await page.keyboard.press("Meta+k"); await page.keyboard.press("Meta+b");
await pickLayout("Two Columns, Files on Right");
assert.deepEqual(await cols(), ["col-locations:Locations", "col-tabs:Commits|Files"]);

// back / forward through the selection history
await page.locator("#row-3").click();
await page.locator("#row-5").click();
await page.locator("#row-5.sel").waitFor();
await page.getByRole("button", { name: "Back", exact: true }).click();
await page.locator("#row-3.sel").waitFor();
await page.keyboard.press("Meta+ArrowRight"); // navigate_forward
await page.locator("#row-5.sel").waitFor();

// stash options: flags accumulate as pills, `stash` runs the command; the console button reports it
const calls = async (k) => (await mock("__mockCalls")).filter((c) => c[k]);
await page.getByRole("button", { name: "Stash options" }).click();
await page.locator(".overlay .pill", { hasText: "Stash" }).waitFor();
assert.deepEqual(await page.locator(".overlay li .l").allInnerTexts(), ["stash", "--include-untracked", "--keep-index", "--staged"]);
assert.match(await page.locator(".overlay li").first().innerText(), /Select to run command/);
if (shots) await page.screenshot({ path: `${shots}/f2-stash.png` });
await page.keyboard.type("untracked");
await page.keyboard.press("Enter");
await page.locator(".overlay .pill", { hasText: "--include-untracked" }).waitFor();
assert.equal(await page.locator(".overlay li", { hasText: "--include-untracked" }).count(), 0, "a chosen flag leaves the list");
await page.locator(".overlay li", { hasText: "stash" }).first().click();
await page.waitForFunction(() => globalThis.__mockCalls.some((c) => c.Stash));
assert.deepEqual((await calls("Stash"))[0].Stash.flags, ["--include-untracked"]);
await page.waitForFunction(() => /git stash push --include-untracked: ok/.test(document.querySelector(".console")?.title ?? ""));
await page.getByRole("button", { name: "Pop stash" }).click();
await page.waitForFunction(() => globalThis.__mockCalls.some((c) => c.PopStash));
await page.getByRole("button", { name: "Console" }).click();
const con = page.locator(".console-panel");
await con.waitFor();
const conRows = async () => (await con.locator(".job .cmd").allInnerTexts());
assert.deepEqual((await conRows()).slice(0, 3), ["git stash pop", "git stash push --include-untracked", "git merge --abort"], "newest first; working-directory writes are logged too");
assert.deepEqual((await con.locator(".job").first().locator(".k").allInnerTexts()), ["Command", "Status", "Date"]);
assert.equal(await con.locator(".job.on .stat").innerText(), "Success", "the newest is selected");
assert.equal(await con.locator(".out").innerText(), "No Output");
await page.keyboard.press("Escape");
await con.waitFor({ state: "detached" });

// ================= F7: console + journal =================
const jobsFrom = async (n) => (await mock("__mockJobs")).slice(n);
const conState = () => page.locator(".branchbox .console").getAttribute("class");
const setMock = (key, kind, v) => page.evaluate(([k, kind, v]) => { if (v === null) delete globalThis[k][kind]; else globalThis[k][kind] = v; }, [key, kind, v]);
const job = (label) => con.locator(".job", { has: page.locator(".cmd", { hasText: new RegExp(`^${label}$`) }) }).first();
// a slow fetch runs; push and stash pressed meanwhile wait in order (no "still running" refusal), then run one by one
let n0 = (await mock("__mockJobs")).length;
await setMock("__mockSlow", "Fetch", 1500);
await page.getByRole("button", { name: "Pull options" }).click();
await page.locator(".overlay li", { has: page.locator(".l", { hasText: /^fetch$/ }) }).click();
await page.locator(".branchbox .console .spinner").waitFor();
await page.getByRole("button", { name: "Push", exact: true }).click();
await page.getByRole("button", { name: "Stash", exact: true }).click();
await page.keyboard.press("Control+Backquote"); // toggle_console
await con.waitFor();
assert.deepEqual((await conRows()).slice(0, 3), ["git stash push", "git push", "git fetch"]);
assert.deepEqual(await con.locator(".job .stat").allInnerTexts().then((s) => s.slice(0, 3)), ["Queued", "Queued", "Running…"]);
assert.equal(await con.getByRole("button", { name: /^Cancel/ }).count(), 3, "queued and running rows can be cancelled");
// progress streams into the output pane while it runs; \r redraws the counter line
await job("git fetch").locator(".pick").click();
await con.locator(".out", { hasText: "Receiving objects:  40%" }).waitFor();
if (shots) await page.screenshot({ path: `${shots}/f7-console-queue.png` });
await page.waitForFunction(() => document.querySelector(".branchbox .console")?.classList.contains("ok"), null, { timeout: 8000 });
assert.deepEqual(await jobsFrom(n0), ["Fetch", "Push", "Stash"], "strict FIFO");
assert.match(await con.locator(".out").innerText(), /Receiving objects: 100% \(5\/5\), done\.\nFrom origin/);
assert.ok(!(await con.locator(".out").innerText()).includes("40%"), "the progress line was redrawn, not appended");

// cancel a queued command: it never runs; the running one finishes
n0 = (await mock("__mockJobs")).length;
await page.getByRole("button", { name: "Pull options" }).click();
await page.locator(".overlay li", { has: page.locator(".l", { hasText: /^fetch$/ }) }).click();
await page.getByRole("button", { name: "Push", exact: true }).click();
await job("git push").getByRole("button", { name: /^Cancel/ }).click();
assert.equal(await job("git push").locator(".stat").innerText(), "Cancelled");
await page.waitForFunction(() => document.querySelector(".branchbox .console")?.classList.contains("ok"), null, { timeout: 8000 });
assert.deepEqual(await jobsFrom(n0), ["Fetch"], "the cancelled push never started");
// cancel the running command: its git is killed (mock: Cancel request), no error banner
await page.getByRole("button", { name: "Pull options" }).click();
await page.locator(".overlay li", { has: page.locator(".l", { hasText: /^fetch$/ }) }).click();
await job("git fetch").locator(".stat", { hasText: "Running…" }).waitFor();
await job("git fetch").getByRole("button", { name: /^Cancel/ }).click();
await job("git fetch").locator(".stat", { hasText: "Cancelled" }).waitFor();
assert.equal(await page.locator(".banner").count(), 0, "cancelling is not an error");
await setMock("__mockSlow", "Fetch", null);

// a failing command: red console button, its stderr in the output pane and the banner; the commands queued behind it are not run
n0 = (await mock("__mockJobs")).length;
await setMock("__mockSlow", "Push", 600);
await setMock("__mockFail", "Push", "error: failed to push some refs to 'origin'\nhint: Updates were rejected because the remote contains work that you do not have locally.");
await page.getByRole("button", { name: "Push", exact: true }).click();
await page.getByRole("button", { name: "Stash", exact: true }).click();
await page.waitForFunction(() => document.querySelector(".branchbox .console")?.classList.contains("failed"));
assert.deepEqual(await jobsFrom(n0), ["Push"]);
assert.equal(await job("git push").locator(".stat").innerText(), "Failed");
assert.equal(await job("git stash push").locator(".stat").innerText(), "Cancelled");
await job("git push").locator(".pick").click();
assert.match(await con.locator(".out .err").innerText(), /failed to push some refs[\s\S]*Updates were rejected/);
await job("git stash push").locator(".pick").click();
assert.match(await con.locator(".out").innerText(), /Not run: an earlier command failed/);
assert.match(await page.locator(".banner").innerText(), /failed to push some refs/);
if (shots) await page.screenshot({ path: `${shots}/f7-console-failed.png` });
await setMock("__mockFail", "Push", null);
await setMock("__mockSlow", "Push", null);
await page.getByRole("button", { name: "Dismiss" }).click();
await page.getByRole("button", { name: "Console" }).click(); // the button toggles it closed
await con.waitFor({ state: "detached" });
assert.match(await conState(), /\bfailed\b/);

// branch field: Checkout overlay with local branches (L) and tags (T), the current branch preselected
await page.locator(".branch").click();
await page.locator(".overlay .pill", { hasText: "Checkout" }).waitFor();
assert.equal(await page.locator(".overlay input").getAttribute("placeholder"), "Branch or Tag Name");
assert.match((await page.locator(".overlay li.on .l").innerText()).trim(), /^L\s*feature\/d11-upgrade-C$/);
assert.ok((await page.locator(".overlay li .kind").allInnerTexts()).includes("T"));
if (shots) await page.screenshot({ path: `${shots}/f2-checkout.png` });
await page.keyboard.type("main");
await page.keyboard.press("Enter");
await page.waitForFunction(() => globalThis.__mockCalls.some((c) => c.Checkout));
assert.equal((await calls("Checkout"))[0].Checkout.name, "main");
await page.locator(".branch .mono", { hasText: /^main$/ }).waitFor();
await page.keyboard.press("Meta+b"); // the sublime-style preset's key for the same overlay
await page.keyboard.type("upgrade-C");
await page.keyboard.press("Enter");
await page.locator(".branch .mono", { hasText: "feature/d11-upgrade-C" }).waitFor();

// pull options list; push runs straight away
const [nFetch, nPush] = [(await calls("Fetch")).length, (await calls("Push")).length]; // the F7 tests ran some already
await page.getByRole("button", { name: "Pull options" }).click();
assert.equal(await page.locator(".overlay li").count(), 7);
await page.locator(".overlay li", { hasText: "fetch --prune" }).click();
await page.waitForFunction((n) => globalThis.__mockCalls.filter((c) => c.Fetch).length > n, nFetch);
assert.deepEqual((await calls("Fetch")).at(-1).Fetch.flags, ["--prune"]);
await page.getByRole("button", { name: "Push", exact: true }).click();
await page.waitForFunction((n) => globalThis.__mockCalls.filter((c) => c.Push).length > n, nPush);
assert.deepEqual((await calls("Push")).at(-1).Push.flags, []);

// … menu: copy the repository path
await page.getByRole("button", { name: "More actions" }).click();
await page.getByRole("menuitem", { name: "Copy Repository Path" }).click();
assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "/work/demo-repo");

// inactive window dims
await page.evaluate(() => window.dispatchEvent(new Event("blur")));
assert.equal(await page.evaluate(() => document.documentElement.classList.contains("inactive")), true);
await page.evaluate(() => window.dispatchEvent(new Event("focus")));
assert.equal(await page.evaluate(() => document.documentElement.classList.contains("inactive")), false);
if (shots) await page.screenshot({ path: `${shots}/f2-shell.png` });

// ================= F3: sidebar =================
const prefs = () => page.evaluate(() => JSON.parse(localStorage.getItem("commitkiwi.prefs")));
const lastCount = async () => (await calls("Count")).at(-1).Count.hidden;
const leaf = (name) => page.locator(".side li").filter({ has: page.locator(".t", { hasText: new RegExp(`^${name.replace(/[.]/g, "\\.")}$`) }) });
// Locations: uppercase counted sections; `/` names become folders (the current branch's folder starts open)
assert.deepEqual(await page.locator(".side .st").allInnerTexts(), ["BRANCHES (3)", "REMOTES (2)", "TAGS (2)", "STASHES (1)", "SUBMODULES (1)", "WORKTREES (2)"]);
await page.locator(".side li.folder", { hasText: "feature" }).waitFor();
await leaf("d11-upgrade-C").and(page.locator(".head")).waitFor();
assert.equal(await leaf("main").count(), 1, "origin/ folder starts closed");
await page.locator(".side li.folder", { hasText: "origin" }).click();
assert.equal(await leaf("main").count(), 2);
// eye: hide a branch (reloads the list without it, persisted per repo), show it again
await leaf("main").first().hover();
await page.getByRole("button", { name: "Hide main", exact: true }).click();
await leaf("main").and(page.locator(".hid")).waitFor();
await page.waitForFunction(() => globalThis.__mockCalls.filter((c) => c.Count).at(-1)?.Count.hidden.includes("refs/heads/main"));
assert.deepEqual((await prefs()).hidden_refs, { "local|/work/demo-repo": ["refs/heads/main"] });
await page.getByRole("button", { name: "Show main", exact: true }).click();
await page.waitForFunction(() => globalThis.__mockCalls.filter((c) => c.Count).at(-1)?.Count.hidden.length === 0);
assert.deepEqual((await prefs()).hidden_refs, {});
// alt-click: show only this ref; palette "Show All Hidden Branches" undoes it
await leaf("v2.4.0").hover();
await page.getByRole("button", { name: "Hide v2.4.0" }).click({ modifiers: ["Alt"] });
await page.waitForFunction(() => globalThis.__mockCalls.filter((c) => c.Count).at(-1)?.Count.hidden.length === 6);
assert.ok(!(await lastCount()).includes("refs/tags/v2.4.0"));
await page.keyboard.press("Meta+p"); await page.keyboard.type("show all hidden"); await page.keyboard.press("Enter");
await page.waitForFunction(() => globalThis.__mockCalls.filter((c) => c.Count).at(-1)?.Count.hidden.length === 0);
// filter (⇧⌘F): folders open, empty sections go, Escape closes
await page.keyboard.press("Meta+Shift+f");
await page.getByRole("textbox", { name: "Filter locations" }).waitFor();
await page.keyboard.type("upgrade");
assert.deepEqual(await page.locator(".side .st").allInnerTexts(), ["BRANCHES (2)", "REMOTES (1)", "STASHES (1)", "WORKTREES (1)"]);
await page.locator(".side li", { hasText: "d11-upgrade-B" }).waitFor();
await page.keyboard.press("Escape");
await page.getByRole("textbox", { name: "Filter locations" }).waitFor({ state: "detached" });
assert.equal(await page.locator(".side .st").count(), 6);
// worktrees: current one bold, branch pill; clicking jumps to its commit
assert.match(await page.locator(".side li.head", { hasText: "demo-repo" }).last().innerText(), /demo-repo/);
assert.equal(await page.locator(".side li", { hasText: "demo-repo-hotfix" }).locator(".wb").innerText(), "main");
await page.locator(".side li", { hasText: "demo-repo-hotfix" }).locator(".go").click();
await page.locator("#row-900.sel").waitFor({ timeout: 3000 });
// gear menus (Submodule/Worktree Section menus)
await page.locator(".side .sh", { hasText: "SUBMODULES" }).hover();
await page.getByRole("button", { name: "SUBMODULES options" }).click();
assert.deepEqual(await page.locator(".popup button .l").allInnerTexts(), ["Add Submodule…", "Update All Submodules", "Sync All Submodule URLs"]);
await page.getByRole("menuitem", { name: "Sync All Submodule URLs" }).click();
await page.waitForFunction(() => globalThis.__mockCalls.some((c) => c.SyncSubmodules));
await page.locator(".side .sh", { hasText: "WORKTREES" }).hover();
await page.getByRole("button", { name: "WORKTREES options" }).click();
assert.deepEqual(await page.locator(".popup button .l").allInnerTexts(), ["Add Worktree…"]);
await page.getByRole("menuitem", { name: "Add Worktree…" }).click();
await page.locator(".overlay .pill", { hasText: "Add Worktree" }).waitFor();
await page.keyboard.type("../wt");
await page.keyboard.press("Enter");
await page.locator(".overlay .pill", { hasText: "../wt" }).waitFor();
const counts0 = (await calls("Count")).length;
await page.locator(".overlay li", { hasText: "New branch" }).click();
await page.waitForFunction(() => globalThis.__mockCalls.some((c) => c.AddWorktree));
assert.deepEqual((await calls("AddWorktree"))[0].AddWorktree, { repo: "/work/demo-repo", path: "../wt", branch: null });
await page.waitForFunction((n) => globalThis.__mockCalls.filter((c) => c.Count).length > n, counts0); // the tab reloads after a write
await page.waitForTimeout(150);

// commit rows: HEAD subject bold, lane-coloured pill + `⑂ +N`, text indented by that row's own graph width
await page.locator(".list").evaluate((el) => { el.scrollTop = 0; }); // a reload keeps the scroll position (it no longer remounts)
await page.locator("#row-0").click();
await page.locator("#row-0.sel").waitFor();
await page.locator("#row-0 .s.headc").waitFor();
assert.equal(await page.locator("#row-1 .s.headc").count(), 0);
assert.match(await page.locator("#row-0 .ref").getAttribute("style"), /--lc: var\(--lane\d\)/);
assert.equal(await page.locator("#row-0 .refmore").innerText(), "⑂ +1");
assert.equal(await page.locator("#row-1").evaluate((e) => e.style.paddingLeft), "48px");
assert.equal(await page.locator("#row-10").evaluate((e) => e.style.paddingLeft), "36px");
// ← collapses the merge (its side branch rows 1-5 go), → expands it
await page.keyboard.press("ArrowLeft");
await page.locator("#row-1").waitFor({ state: "detached" });
assert.equal(await page.locator("#row-6").evaluate((e) => e.style.top), "60px", "row 6 moves up to position 1");
await page.locator("#row-0 path.plus").waitFor({ state: "attached" });
await page.keyboard.press("ArrowRight");
await page.locator("#row-1").waitFor();
// multi-select: shift-click a range, cmd-click adds; details diff from the oldest one's parent
await page.locator("#row-6").click();
await page.locator("#row-8").click({ modifiers: ["Shift"] });
assert.equal(await page.locator(".row.sel").count(), 3);
await page.locator(".kv .diffing", { hasText: "00000009 (parent of 00000008)" }).waitFor();
assert.ok((await kv())["Diffing From"]);
await page.waitForFunction(() => globalThis.__mockCalls.some((c) => c.Show?.from === "00000008c3f19a2ec3f19a2ec3f19a2ec3f19a2e"));
await page.locator("#row-10").click({ modifiers: ["Meta"] });
assert.equal(await page.locator(".row.sel").count(), 4);
await page.keyboard.press("Shift+ArrowUp"); // extends from the anchor (row 10) up to row 9
assert.equal(await page.locator(".row.sel").count(), 2);
await page.locator("#row-3").click();
assert.equal(await page.locator(".row.sel").count(), 1);
await page.locator(".kv .diffing").waitFor({ state: "detached" });

// Files column: Changes = the selected commit's files; picking one shows only that file
await page.getByRole("tab", { name: "Files", exact: true }).click();
await page.getByRole("tab", { name: "Changes", exact: true }).click();
await page.locator(".fsec", { hasText: "CHANGES (6)" }).waitFor();
await page.locator(".fr", { hasText: "composer.json" }).click();
await page.locator(".fr.sel", { hasText: "composer.json" }).waitFor();
await page.waitForFunction(() => document.querySelectorAll(".content .file").length === 1);
assert.match(await page.locator(".content .file").innerText(), /composer\.json/);
// ...and with the working copy selected: its files by status
await page.getByRole("tab", { name: "Commits", exact: true }).click();
await page.locator(".workrow").click();
await page.getByRole("tab", { name: "Files", exact: true }).click();
const secs = await page.locator(".fsec").allInnerTexts();
assert.ok(secs.length && secs.every((t) => /^(UNMERGED|MODIFIED|UNTRACKED|STAGED) \(\d+\)$/.test(t)), secs.join());
await page.locator(".fr").first().click();
await page.locator(".details.work .dt.on", { hasText: await page.locator(".fr").first().innerText() }).waitFor(); // its file tab opens
// Tree: count, filter (⌥⌘F) lists matching paths, Escape closes it
await page.getByRole("tab", { name: "Tree", exact: true }).click();
await page.locator(".fsec", { hasText: "TREE (5)" }).waitFor();
await page.keyboard.press("Meta+Alt+f");
await page.getByRole("textbox", { name: "Filter files" }).waitFor();
await page.keyboard.type("home");
assert.deepEqual(await page.locator(".filespane .fr").allInnerTexts(), ["src/Controller/Home.php"]);
await page.locator(".filespane .fr").click();
await page.locator(".fv-head .path", { hasText: "src/Controller/Home.php" }).waitFor();
await page.getByRole("textbox", { name: "Filter files" }).focus();
await page.keyboard.press("Escape");
await page.getByRole("textbox", { name: "Filter files" }).waitFor({ state: "detached" });
if (shots) await page.screenshot({ path: `${shots}/f3-files.png` });
await page.getByRole("tab", { name: "Commits", exact: true }).click();

// --- theme toggle + persistence (a palette command; no toolbar button)
const toggleTheme = async () => { await page.keyboard.press("Meta+p"); await page.keyboard.type("toggle light"); await page.keyboard.press("Enter"); };
await toggleTheme();
assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
if (shots) await page.screenshot({ path: `${shots}/m1-dark.png` });
await toggleTheme();
assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
if (shots) await page.screenshot({ path: `${shots}/m1-light.png` });
await toggleTheme(); // leave dark saved

// --- errors from the backend are shown, not swallowed
await page.getByRole("button", { name: "New tab", exact: true }).click();
await page.getByPlaceholder("~/projects/my-repo").fill("/work/missing");
await page.getByRole("button", { name: "Open Repository", exact: true }).click();
await page.getByRole("alert").filter({ hasText: "not a git repository" }).waitFor();

// --- remote tab via host picker
await page.getByRole("tab", { name: "Remote (SSH)" }).click();
await page.getByPlaceholder("example-host  or  user@host").fill("example-host");
await page.getByPlaceholder("~/projects/my-repo").fill("~/projects/site");
await page.getByRole("button", { name: "Open Repository", exact: true }).click();
await page.locator(".tab.on .tab-main", { hasText: "site" }).waitFor();
assert.equal((await page.locator(".titlebar > b").innerText()).trim(), "example-host:~/projects/site");
if (shots) await page.getByRole("button", { name: "New tab", exact: true }).click(), await page.screenshot({ path: `${shots}/m1-locations.png` });

// --- Add Repositories from Folder…: scan (mock), checklist, add to the switcher without opening tabs
const tabsBefore = await page.locator(".tabbar .tab").count();
await page.locator(".menubar button", { hasText: "File" }).click();
await page.locator(".popup button", { has: page.locator(".l", { hasText: /^Add Repositories from Folder…$/ }) }).click();
const dlg = page.getByRole("dialog", { name: "Add Repositories from Folder" });
await dlg.getByPlaceholder("~/projects").fill("/work");
await dlg.getByRole("button", { name: "Scan" }).click();
await dlg.locator(".ar-list li").nth(3).waitFor();
assert.equal(await dlg.locator(".ar-list li.known").count(), 1, "demo-repo is already known");
assert.equal(await dlg.locator(".ar-list li.known input").isDisabled(), true);
await dlg.getByRole("button", { name: "Add 3 repositories" }).waitFor();
await dlg.getByRole("button", { name: "Select none" }).click();
assert.equal(await dlg.getByRole("button", { name: "Add 0 repositories" }).isDisabled(), true);
await dlg.getByLabel("Depth").fill("2");
await dlg.getByRole("button", { name: "Scan" }).click();
await dlg.getByRole("button", { name: "Add 2 repositories" }).waitFor(); // gamma is 3 deep
assert.deepEqual(await page.evaluate(() => globalThis.__mockCalls.filter((c) => c.ScanRepos).map((c) => c.ScanRepos)), [{ root: "/work", depth: 3 }, { root: "/work", depth: 2 }]);
await dlg.locator(".ar-list label", { hasText: "/work/alpha" }).locator("input").uncheck();
await dlg.getByRole("button", { name: "Add 1 repository" }).click();
await dlg.waitFor({ state: "detached" });
assert.equal(await page.locator(".tabbar .tab").count(), tabsBefore, "bulk add opens no tabs");
const recentPaths = await page.evaluate(() => JSON.parse(localStorage.getItem("commitkiwi.prefs")).recent.map((r) => `${r.location}|${r.path}`));
assert.ok(recentPaths.includes("local|/work/clients/beta") && !recentPaths.includes("local|/work/alpha"), recentPaths.join());
await page.keyboard.press("Meta+Shift+o");
await page.locator(".overlay li", { hasText: "/work/clients/beta" }).waitFor();
await page.keyboard.press("Escape");
// remote scans go to the host's agent; the New Tab page has the same entry point
await page.getByRole("button", { name: "New tab", exact: true }).click();
await page.getByRole("button", { name: "Add Repositories from Folder…" }).click();
await dlg.getByRole("tab", { name: "Remote (SSH)" }).click();
await dlg.getByPlaceholder("example-host  or  user@host").fill("example-host");
await dlg.getByPlaceholder("~/projects").fill("~/projects");
await dlg.getByRole("button", { name: "Scan" }).click();
await dlg.getByRole("button", { name: "Add 3 repositories" }).waitFor(); // depth 2 is remembered; nothing known on example-host under /home/user/projects
assert.deepEqual(await page.evaluate(() => globalThis.__mockCalls.filter((c) => c.ScanRepos).at(-1).ScanRepos), { root: "~/projects", depth: 2 });
await page.keyboard.press("Escape");
await dlg.waitFor({ state: "detached" });

// --- reload restores both tabs, the active tab, the theme and recent list
await page.locator(".tabbar .tab-main", { hasText: "demo-repo" }).click();
await page.reload();
await page.locator(".tabbar .tab-main", { hasText: "demo-repo" }).waitFor();
await page.locator(".tabbar .tab-main", { hasText: "site" }).waitFor();
assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
assert.equal(await page.locator(".tabbar .tab").count(), 2); // 2 repos (New Tab shows only while it is open)
await page.locator(".tab.on .tab-main", { hasText: "demo-repo" }).waitFor(); // active tab restored

// --- closing the active tab falls back sensibly
await page.getByRole("button", { name: "Close site" }).click();
assert.equal(await page.locator(".tabbar .tab").count(), 1);
await page.getByRole("button", { name: "Close demo-repo" }).click();
await page.getByRole("button", { name: "Open Repository", exact: true }).waitFor();

assert.deepEqual(errors, [], "no console/page errors");
await browser.close();
console.log("e2e ok");
