import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAnswer, dateTokens, isIsoDate, queryTokens, resolveDates, searchRequest, topAuthors } from "./nlSearch.ts";
import { KEYWORDS, parseSearch } from "./search.ts";

const TODAY = "2026-11-06"; // a Friday
const r = (s: string, today = TODAY) => { const d = resolveDates(s, today); return d && [d.after, d.before]; };

test("relative dates become day ranges", () => {
  assert.deepEqual(r("commits by alex touching the login form last month"), ["2026-10-01", "2026-11-01"]);
  assert.deepEqual(r("what changed today"), ["2026-11-06", "2026-11-07"]);
  assert.deepEqual(r("fixes from Yesterday"), ["2026-11-05", "2026-11-06"]);
  assert.deepEqual(r("this week"), ["2026-11-02", null]);
  assert.deepEqual(r("last week"), ["2026-10-26", "2026-11-02"]);
  assert.deepEqual(r("this month"), ["2026-11-01", null]);
  assert.deepEqual(r("last year"), ["2025-01-01", "2026-01-01"]);
  assert.deepEqual(r("this year"), ["2026-01-01", null]);
  assert.deepEqual(r("in March"), ["2026-03-01", "2026-04-01"]);
  assert.deepEqual(r("in december"), ["2025-12-01", "2026-01-01"], "a later month: last year's");
  assert.deepEqual(r("during march 2024"), ["2024-03-01", "2024-04-01"]);
  assert.deepEqual(r("since Monday"), ["2026-11-02", null]);
  assert.deepEqual(r("since friday"), ["2026-10-30", null], "the same weekday: last week's");
  assert.deepEqual(r("on tuesday"), ["2026-11-03", "2026-11-04"]);
  assert.deepEqual(r("3 days ago"), ["2026-11-03", null]);
  assert.deepEqual(r("two weeks ago"), ["2026-10-23", null]);
  assert.deepEqual(r("a month ago", "2026-03-31"), ["2026-02-28", null], "the day is clamped to the month");
  assert.deepEqual(r("in the last 10 days"), ["2026-10-27", null]);
  assert.deepEqual(r("since last week"), ["2026-10-26", null]);
  assert.deepEqual(r("last month", "2026-01-15"), ["2025-12-01", "2026-01-01"], "across the year");
  assert.equal(resolveDates("refactor the parser", TODAY), null);
  assert.equal(resolveDates("today", "06/11/2026"), null);
  assert.equal(resolveDates("since monday", TODAY)?.phrase, "monday");
  assert.deepEqual(dateTokens(resolveDates("yesterday", TODAY)), ["after:2026-11-05", "before:2026-11-06"]);
  assert.ok(isIsoDate("2024-02-29") && !isIsoDate("2026-02-29") && !isIsoDate("2026-2-01"));
});

test("the model request carries the KEYWORDS table and the resolved dates", () => {
  const req = searchRequest("  by alex last month ", TODAY, { recent_authors: ["Alex Martin"], known_paths: ["src"], branches: ["main"] });
  // the grammar on the Rust side is built from exactly these rows: no second list to drift
  assert.deepEqual(req.keywords, KEYWORDS);
  assert.deepEqual(req.keywords.map((k) => k.name), KEYWORDS.map((k) => k.name));
  assert.equal(req.sentence, "by alex last month");
  assert.deepEqual(req.dates, ["after:2026-10-01", "before:2026-11-01"]);
  assert.deepEqual([req.today, req.recent_authors, req.known_paths, req.branches], [TODAY, ["Alex Martin"], ["src"], ["main"]]);
  // every field the query writer emits is a keyword the parser knows
  const names = new Set(KEYWORDS.map((k) => k.name));
  for (const f of new Set(KEYWORDS.map((k) => k.field))) assert.ok(names.has(f), f);
});

test("authors by frequency", () => {
  assert.deepEqual(topAuthors([{ author: "B" }, { author: "A" }, { author: "B" }, { author: " " }], 5), ["B", "A"]);
  assert.equal(topAuthors(Array.from({ length: 30 }, (_, i) => ({ author: `p${i}` }))).length, 12);
});

test("queries round-trip through the parser", () => {
  const q = parseSearch(`fix "two words" author:"Ann \\"A\\" Lee" file:src/a.rs after:2026-01-01 branch:main`);
  const s = queryTokens(q).join(" ");
  assert.equal(s, `author:"Ann \\"A\\" Lee" file:src/a.rs branch:main after:2026-01-01 fix "two words"`);
  assert.deepEqual(parseSearch(s), q);
});

test("the answer is checked like a typed query", () => {
  const month = resolveDates("last month", TODAY);
  assert.deepEqual(checkAnswer(`author:"Alex Martin" login form after:2026-10-01 before:2026-11-01`, "by alex about login last month", month),
    { query: `author:"Alex Martin" after:2026-10-01 before:2026-11-01 login form`, warnings: [] });
  // resolved dates win over the model's
  assert.equal(checkAnswer("after:2025-01-01 fix", "fixes last month", month).query, "after:2026-10-01 before:2026-11-01 fix");
  // unknown keywords, bad and made-up dates, a second contents:, a non-hex commit
  const bad = checkAnswer(`nope:x after:2026-02-31 content:a content:b commit:zz fix`, "fixes", null);
  assert.equal(bad.query, "content:a fix");
  assert.deepEqual(bad.warnings, ["Left out nope: (not a search keyword).", "Left out after:2026-02-31 (not a date).", "Kept the first of 2 content: terms (only one is supported).", "Left out commit:zz (not a commit hash)."]);
  assert.deepEqual(checkAnswer("before:2026-01-01 fix", "a fix", null).warnings, ["Left out before:2026-01-01 (the request names no date)."]);
  assert.equal(checkAnswer("before:2026-01-01 fix", "a fix before 2026", null).query, "before:2026-01-01 fix");
  // nothing usable: the longest real word of the sentence, plus the dates
  const fb = checkAnswer("nope:x", "commits touching the authentication middleware last month", month);
  assert.equal(fb.query, "after:2026-10-01 before:2026-11-01 authentication");
  assert.match(fb.warnings.at(-1)!, /searching for "authentication" instead/);
  assert.deepEqual(checkAnswer("after:2026-10-01", "commits from last month", month), { query: "after:2026-10-01 before:2026-11-01", warnings: [] });
  assert.throws(() => checkAnswer("", "the commits", null), /Could not turn that into a search/);
});
