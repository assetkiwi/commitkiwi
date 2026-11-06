import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { THEME_VARIABLES, contrast, parseTheme, resolveTheme } from "./themes.ts";

const builtin = (f: string) => parseTheme(readFileSync(new URL(`./themes/${f}.theme.json`, import.meta.url), "utf8"));
const KIWI = [builtin("kiwi-light"), builtin("kiwi-dark")];

test("Kiwi themes: WCAG AA (4.5:1) for text, links, buttons and diff add/del tints", () => {
  const pairs: [string, string][] = [
    ["--text", "--bg"], ["--text", "--surface"], ["--text", "--surface-2"], ["--text", "--sel"], ["--text", "--hover"],
    ["--text-2", "--surface"], ["--text-2", "--bg"], ["--muted", "--surface"], ["--muted", "--bg"],
    ["--accent-text", "--surface"], ["--accent-text", "--accent-soft"], ["--on-accent", "--accent"],
    ["--primary-text", "--primary-bg"], ["--primary-text", "--primary-hover"], ["--danger", "--surface"],
    ["--add-fg", "--add-bg"], ["--del-fg", "--del-bg"], ["--text", "--add-bg"], ["--text", "--del-bg"],
    ["--text", "--add-gutter"], ["--text", "--del-gutter"], ["--conflict-fg", "--band-conflict"], ["--text", "--band"],
  ];
  assert.equal(contrast("#ffffff", "#000000"), 21);
  assert.equal(contrast("#777777", "#777777"), 1);
  for (const t of KIWI) {
    for (const [fg, bg] of pairs) {
      const r = contrast(t.variables[fg], t.variables[bg]);
      assert.ok(r >= 4.5, `${t.name}: ${fg} on ${bg} is ${r.toFixed(2)}:1`);
    }
  }
});

test("Kiwi themes use only known variables, the site's tokens and Figtree first", () => {
  const [light, dark] = KIWI;
  assert.deepEqual([light.name, light.kind, dark.name, dark.kind], ["Kiwi Light", "light", "Kiwi Dark", "dark"]);
  assert.deepEqual([light.variables["--bg"], light.variables["--surface-2"], light.variables["--primary-bg"]], ["#f8fbf4", "#f0f7e8", "#f59e0b"]);
  assert.match(light.variables["--font-ui"], /^"Figtree", system-ui/);
  for (const t of KIWI) for (const k of Object.keys(t.variables)) assert.ok((THEME_VARIABLES as readonly string[]).includes(k), k);
});

test("theme files: validation and extends", () => {
  const user = parseTheme(`{
    // a comment
    "name": "Moss", "kind": "dark", "extends": "Kiwi Dark",
    "variables": { "--accent": "#70a040", },
  }`);
  const r = resolveTheme("Moss", [...KIWI, user])!;
  assert.equal(r.variables["--accent"], "#70a040");
  assert.equal(r.variables["--bg"], "#0c0f09", "inherited");
  assert.equal(resolveTheme("nope", KIWI), null);
  const loop = [{ id: "a", name: "a", kind: "light" as const, extends: "b", variables: { "--bg": "#000000" } }, { id: "b", name: "b", kind: "light" as const, extends: "a", variables: {} }];
  assert.equal(resolveTheme("a", loop)!.variables["--bg"], "#000000", "a cycle stops");
  assert.throws(() => parseTheme("[]"), /object/);
  assert.throws(() => parseTheme(`{ "name": "x", "kind": "blue" }`), /kind/);
  assert.throws(() => parseTheme(`{ "name": "x", "kind": "light", "variables": { "--nope": "red" } }`), /unknown variable --nope/);
  assert.throws(() => parseTheme(`{ "name": "x", "kind": "light", "variables": { "--bg": "red; color: x" } }`), /bad value/);
  assert.throws(() => parseTheme(`{ "kind": "light" }`), /name/);
});
