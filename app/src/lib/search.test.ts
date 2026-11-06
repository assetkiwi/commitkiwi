import { test } from "node:test";
import assert from "node:assert/strict";
import { KEYWORDS, complete, forGit, isEmptyQuery, parseSearch, suggest } from "./search.ts";

test("parses keywords, quoted values and free text", () => {
  const q = parseSearch(`fix file:src/a.rs from:"Ann Smith" message:"say \\"hi\\"" commit:ab12 contents:x after:2024-01-01 before:"2 weeks ago" branch:feature/x redis`);
  assert.deepEqual(q, {
    text: ["fix", "redis"], message: ['say "hi"'], author: ["Ann Smith"], commit: ["ab12"], file: ["src/a.rs"],
    content: ["x"], branch: ["feature/x"], after: "2024-01-01", before: "2 weeks ago",
  });
});

test("aliases, unknown keywords, empty values", () => {
  const q = parseSearch(`path:a author:bob content:y nope:z file: "two words" after:1 after:2`);
  assert.deepEqual([q.file, q.author, q.content, q.text, q.after], [["a"], ["bob"], ["y"], ["nope:z", "two words"], "2"]);
  assert.ok(isEmptyQuery(parseSearch("  file:  ")));
  assert.ok(!isEmptyQuery(parseSearch("before:x")));
  assert.deepEqual(parseSearch(`message:"unterminated quote`).message, ["unterminated quote"]);
});

test("suggests keywords for the word at the caret", () => {
  // typing `f` lists file:, from:, after:, before:
  assert.deepEqual(suggest("f", 1).map((k) => k.name), ["file", "from", "after", "before"]);
  assert.deepEqual(suggest("x au", 4).map((k) => k.name), ["author"]);
  assert.deepEqual(suggest("", 0), []);
  assert.deepEqual(suggest("file:", 5), []); // keyword already typed
  assert.deepEqual(suggest(`message:"a f`, 12), []); // inside quotes
  assert.ok(KEYWORDS.every((k) => k.desc));
});

test("completes the word at the caret", () => {
  const kw = KEYWORDS.find((k) => k.name === "author")!;
  assert.deepEqual(complete("x au rest", 4, kw), { value: "x author: rest", caret: 9 });
  assert.deepEqual(complete("f", 1, KEYWORDS[0]), { value: "file:", caret: 5 });
});

test("bare dates mean the start of the day for git", () => {
  const q = forGit(parseSearch(`after:2026-10-01 before:"2 weeks ago" fix`));
  assert.deepEqual([q.after, q.before, q.text], ["2026-10-01 00:00", "2 weeks ago", ["fix"]]);
  assert.equal(forGit(parseSearch("x")).after, null);
});
