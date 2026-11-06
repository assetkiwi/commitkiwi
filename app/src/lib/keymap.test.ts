import { test } from "node:test";
import assert from "node:assert/strict";
import { Keymap, chordFromEvent, matchesContext, normalizeKey, prettyKeys, type Binding } from "./keymap.ts";
import { fuzzy, rank } from "./fuzzy.ts";
import { parseJsonc } from "./jsonc.ts";

const ev = (code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) =>
  ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
const ctx = (modes: Record<string, unknown> = {}, control: string | null = null) => ({ control, modes });

test("key names: aliases, order, primary, literal plus", () => {
  assert.deepEqual(normalizeKey("shift+super+left", "mac"), { mods: ["shift", "super"], key: "left" });
  assert.deepEqual(normalizeKey("command+shift+P", "mac"), normalizeKey("super+shift+p", "mac"));
  assert.deepEqual(normalizeKey("primary+t", "mac")!.mods, ["super"]);
  assert.deepEqual(normalizeKey("primary+t", "linux")!.mods, ["ctrl"]);
  assert.deepEqual(normalizeKey("ctrl++", "linux"), { mods: ["ctrl"], key: "+" });
  assert.equal(normalizeKey("hyper+x", "mac"), null);
  assert.deepEqual(normalizeKey("ctrl+backquote", "mac"), { mods: ["ctrl"], key: "`" }, "the keymap format's name for the backtick key");
  assert.deepEqual(normalizeKey("ctrl+`", "linux"), normalizeKey("ctrl+backquote", "linux"));
  assert.equal(normalizeKey("ctrl+keypad_enter", "linux")!.key, "enter");
});

test("events map by physical key, so Option and Shift cannot change the letter", () => {
  assert.deepEqual(chordFromEvent(ev("KeyP", { metaKey: true, shiftKey: true })), { mods: ["shift", "super"], key: "p" });
  assert.deepEqual(chordFromEvent(ev("Digit1", { metaKey: true })), { mods: ["super"], key: "1" });
  assert.deepEqual(chordFromEvent(ev("BracketLeft", { metaKey: true })), { mods: ["super"], key: "[" });
  assert.deepEqual(chordFromEvent(ev("F5")), { mods: [], key: "f5" });
  assert.equal(chordFromEvent(ev("MetaLeft", { metaKey: true })), null, "a bare modifier is not a chord");
});

test("contexts: modes, control, operators", () => {
  assert.ok(matchesContext([{ key: "search_mode" }], ctx({ search_mode: true })));
  assert.ok(!matchesContext([{ key: "search_mode" }], ctx()));
  assert.ok(matchesContext([{ key: "search_mode", operator: "not_equal" }], ctx()));
  assert.ok(matchesContext([{ key: "control", operand: "commit_table" }], ctx({}, "commit_table")));
  assert.ok(!matchesContext([{ key: "control", operand: "commit_table" }], ctx({}, "filter_input")));
  assert.ok(matchesContext([{ key: "control", operator: "regex_contains", operand: "filter" }], ctx({}, "files_filter")));
  assert.ok(!matchesContext([{ key: "x", operator: "frobnicate" }], ctx()), "unknown operator never fires");
});

test("resolve: last binding wins, context gates, chords wait, user overrides defaults", () => {
  const defaults: Binding[] = [
    { keys: ["super+p"], command: "show_command_palette" },
    { keys: ["escape"], command: "hide_overlay", context: [{ key: "overlay_visible" }] },
    { keys: ["escape"], command: "exit_search", context: [{ key: "search_mode" }] },
    { keys: ["ctrl+k", "ctrl+b"], command: "toggle_side_bar" },
  ];
  const user: Binding[] = [{ keys: ["super+p"], command: "my_palette" }, { keys: ["bogus+x"], command: "ignored" }, { keys: [], command: "ignored" }];
  const km = new Keymap([...defaults, ...user], "mac");
  const press = (code: string, mods = {}, c = ctx()) => km.resolve([chordFromEvent(ev(code, mods))!], c);

  const r = press("KeyP", { metaKey: true });
  assert.equal(r.kind === "run" && r.binding.command, "my_palette");
  assert.equal(press("Escape").kind, "none", "escape does nothing with no mode active");
  const esc = press("Escape", {}, ctx({ overlay_visible: true, search_mode: true }));
  assert.equal(esc.kind === "run" && esc.binding.command, "exit_search", "later matching binding wins");
  const first = km.resolve([chordFromEvent(ev("KeyK", { ctrlKey: true }))!], ctx());
  assert.equal(first.kind, "pending");
  const both = km.resolve([chordFromEvent(ev("KeyK", { ctrlKey: true }))!, chordFromEvent(ev("KeyB", { ctrlKey: true }))!], ctx());
  assert.equal(both.kind === "run" && both.binding.command, "toggle_side_bar");
  assert.equal(km.bindingFor("show_command_palette"), undefined, "overridden command shows no stale key");
  assert.deepEqual(km.bindingFor("my_palette")?.keys, ["super+p"]);
});

test("prettyKeys", () => {
  assert.equal(prettyKeys(["super+shift+p"], "mac"), "⇧⌘P");
  assert.equal(prettyKeys(["super+left"], "mac"), "⌘←");
  assert.equal(prettyKeys(["ctrl+shift+p"], "linux"), "Ctrl+Shift+P");
  assert.equal(prettyKeys(["ctrl+k", "ctrl+b"], "linux"), "Ctrl+K Ctrl+B");
});

test("fuzzy: subsequence, word starts beat scattered letters, positions for bolding", () => {
  assert.deepEqual(fuzzy("bla", "Blame…")!.positions, [0, 1, 2]);
  assert.deepEqual(fuzzy("cb", "Create Branch…")!.positions, [0, 7], "second letter lands on a word start");
  assert.equal(fuzzy("zzz", "Blame…"), null);
  assert.equal(fuzzy("abc", "ab"), null);
  assert.deepEqual(fuzzy("", "anything")!.positions, []);
  const long = "a".repeat(300) + "xyz";
  assert.deepEqual(fuzzy("xyz", long)!.positions, [300, 301, 302], "long text takes the greedy path");
});

test("rank: label match beats detail match; consecutive beats scattered", () => {
  const items = [
    { label: "About", detail: "Build 2132, Stable Channel" },
    { label: "Expand Merge Commits By Default: Toggle", detail: "" },
    { label: "Blame…", detail: "" },
  ];
  const r = rank(items, "bla", (i) => i.label, (i) => i.detail).map((x) => x.item.label);
  assert.equal(r[0], "Blame…");
  assert.ok(r.includes("About"), "matched through its detail text");
  assert.equal(rank(items, "", (i) => i.label).length, 3);
});

test("parseJsonc: comments, trailing commas, urls and slashes inside strings", () => {
  const v = parseJsonc(`[
    // a comment
    { "keys": ["super+shift+x"], "command": "go", "args": {"url": "http://x/y//z"}, }, /* block */
  ]`) as { args: { url: string } }[];
  assert.equal(v.length, 1);
  assert.equal(v[0].args.url, "http://x/y//z");
  assert.deepEqual(parseJsonc("[]"), []);
  assert.throws(() => parseJsonc("[ nope ]"));
});

import { segments } from "./fuzzy.ts";
test("segments split text into matched and plain runs", () => {
  assert.deepEqual(segments("Blame…", [0, 1, 2]), [{ t: "Bla", hit: true }, { t: "me…", hit: false }]);
  assert.deepEqual(segments("a<b>", [1]), [{ t: "a", hit: false }, { t: "<", hit: true }, { t: "b>", hit: false }], "no HTML involved");
  assert.deepEqual(segments("", []), []);
});

test("sublime-style preset: Cmd/Ctrl+1..8 select repo tabs, Cmd+9 stays commit message, merge tool's Cmd+1-3 win there", async () => {
  const { presetBindings } = await import("./defaultKeymap.ts");
  const defaultBindings = (p: "mac" | "linux" | "win") => presetBindings(p, "sublime-style");
  const mac = new Keymap(defaultBindings("mac"), "mac");
  const run = (km: Keymap, key: string, modes: Record<string, unknown> = {}) => {
    const r = km.resolve([normalizeKey(key, km.platform)!], ctx(modes));
    return r.kind === "run" ? [r.binding.command, r.binding.args ?? {}] : r.kind;
  };
  assert.deepEqual(run(mac, "super+1"), ["select_tab", { index: 0 }]);
  assert.deepEqual(run(mac, "super+8"), ["select_tab", { index: 7 }]);
  assert.deepEqual(run(mac, "super+9"), ["navigate_to_commit_message", {}], "no tab 9");
  assert.deepEqual(run(mac, "super+1", { merge_mode: true }), ["focus_left", {}]);
  assert.deepEqual(run(mac, "super+3", { merge_mode: true }), ["focus_right", {}]);
  assert.deepEqual(run(mac, "super+4", { merge_mode: true }), ["select_tab", { index: 3 }], "only 1-3 belong to the merge tool");
  assert.equal(run(mac, "ctrl+1"), "none", "ctrl is not the tab key on macOS");
  for (const p of ["linux", "win"] as const) {
    const km = new Keymap(defaultBindings(p), p);
    assert.deepEqual(run(km, "ctrl+2"), ["select_tab", { index: 1 }], p);
    assert.deepEqual(run(km, "ctrl+2", { merge_mode: true }), ["focus_middle", {}], p);
    assert.deepEqual(run(km, "ctrl+9"), ["navigate_to_commit_message", {}], p);
  }
  // a user's binding (appended after the defaults) takes the key over
  const user = new Keymap([...defaultBindings("mac"), { keys: ["super+1"], command: "toggle_side_bar" }], "mac");
  assert.deepEqual(run(user, "super+1"), ["toggle_side_bar", {}]);
  assert.deepEqual(mac.bindingFor("select_tab", { index: 2 })?.keys, ["super+3"], "menu hint for Repository Tab 3");
});

test("default preset: Cmd/Ctrl+1..9 select tabs, Ctrl+Shift+PageUp/PageDown move one, Cmd/Ctrl+Shift+D the dashboard; not in sublime-style", async () => {
  const { presetBindings } = await import("./defaultKeymap.ts");
  const run = (km: Keymap, key: string) => {
    const r = km.resolve([normalizeKey(key, km.platform)!], ctx({}));
    return r.kind === "run" ? [r.binding.command, r.binding.args ?? {}] : r.kind;
  };
  for (const [p, m] of [["mac", "super"], ["linux", "ctrl"], ["win", "ctrl"]] as const) {
    const km = new Keymap(presetBindings(p), p);
    assert.deepEqual(run(km, `${m}+9`), ["select_tab", { index: 8 }], p);
    assert.deepEqual(run(km, "ctrl+shift+pageup"), ["move_tab_left", {}], p);
    assert.deepEqual(run(km, "ctrl+shift+pagedown"), ["move_tab_right", {}], p);
    assert.deepEqual(run(km, `${m}+shift+d`), ["show_dashboard", {}], p);
    const sub = new Keymap(presetBindings(p, "sublime-style"), p);
    for (const c of ["move_tab_left", "move_tab_right", "show_dashboard"]) assert.equal(sub.bindingFor(c, {}), undefined, `${p} ${c}`);
  }
  assert.equal(prettyKeys(["ctrl+shift+pageup"], "mac"), "⌃⇧PageUp");
});

test("sublime-style preset reproduces the previous defaults exactly, on every platform", async () => {
  const { readFileSync } = await import("node:fs");
  const { presetBindings } = await import("./defaultKeymap.ts");
  // captured from the old defaultKeymap.ts before it became the preset (only the text-field context was renamed)
  const before = JSON.parse(readFileSync(new URL("./presets/sublime-style.expected.json", import.meta.url), "utf8")) as Record<string, Binding[]>;
  for (const p of ["mac", "linux", "win"] as const) {
    const now = presetBindings(p, "sublime-style");
    assert.deepEqual(now, before[p], p);
    // and so every command resolves to the same keys, and every key to the same command
    const a = new Keymap(now, p), b = new Keymap(before[p], p);
    for (const x of before[p]) {
      assert.deepEqual(a.bindingFor(x.command, x.args)?.keys, b.bindingFor(x.command, x.args)?.keys, `${p} ${x.command}`);
      const seq = x.keys.map((k) => normalizeKey(k, p)!);
      for (const modes of [{}, { merge_mode: true }, { search_mode: true }, { overlay_visible: true }, { text_focus: true }]) {
        assert.deepEqual(a.resolve(seq, ctx(modes, "commit_table")), b.resolve(seq, ctx(modes, "commit_table")), `${p} ${x.keys}`);
      }
    }
  }
});

test("default keymap: desktop conventions, the user's file on top, unknown preset = default", async () => {
  const { presetBindings } = await import("./defaultKeymap.ts");
  const run = (km: Keymap, key: string, modes: Record<string, unknown> = {}) => {
    const r = km.resolve(key.split(" ").map((k) => normalizeKey(k, km.platform)!), ctx(modes));
    return r.kind === "run" ? [r.binding.command, r.binding.args ?? {}] : r.kind;
  };
  const mac = new Keymap(presetBindings("mac"), "mac"), linux = new Keymap(presetBindings("linux", "nope"), "linux");
  const expect: [string, string, unknown[]][] = [
    ["super+,", "ctrl+,", ["open_preferences", {}]], ["super+w", "ctrl+w", ["close", {}]], ["super+t", "ctrl+t", ["new_tab", {}]],
    ["super+3", "ctrl+3", ["select_tab", { index: 2 }]], ["super+f", "ctrl+f", ["toggle_search", {}]],
    ["super+shift+p", "ctrl+shift+p", ["show_command_palette", {}]], ["super+p", "ctrl+p", ["quick_switch_repository", {}]],
    ["super+enter", "ctrl+enter", ["commit", {}]], ["super+z", "ctrl+z", ["git_undo", {}]], ["super+shift+z", "ctrl+shift+z", ["git_redo", {}]],
    ["super+b", "ctrl+b", ["toggle_side_bar", {}]], ["f5", "f5", ["refresh", {}]], ["super+r", "ctrl+r", ["refresh", {}]],
    ["super+[", "alt+left", ["navigate_back", {}]], ["super+shift+c", "ctrl+shift+c", ["show_command_palette", { command: "checkout_branch" }]],
  ];
  for (const [m, l, want] of expect) {
    assert.deepEqual(run(mac, m), want, m);
    assert.deepEqual(run(linux, l), want, l);
  }
  assert.equal(run(mac, "super+z", { text_focus: true }), "none", "in a text field ⌘Z is the field's own undo");
  assert.deepEqual(run(mac, "super+1", { merge_mode: true }), ["focus_left", {}]);
  assert.deepEqual(run(mac, "escape", { overlay_visible: true, search_mode: true }), ["hide_overlay", {}]);
  assert.equal(run(mac, "super+k"), "none", "no chords by default");
  const user = new Keymap([...presetBindings("mac"), { keys: ["super+p"], command: "show_command_palette" }], "mac");
  assert.deepEqual(run(user, "super+p"), ["show_command_palette", {}], "the user's file wins over the preset");
  // a different set from the compatibility preset
  const old = presetBindings("mac", "sublime-style").filter((b) => !b.context).map((b) => `${b.keys}>${b.command}${JSON.stringify(b.args ?? {})}`);
  const now = presetBindings("mac").filter((b) => !b.context).map((b) => `${b.keys}>${b.command}${JSON.stringify(b.args ?? {})}`);
  const same = now.filter((x) => old.includes(x)).length;
  assert.ok(same / now.length < 0.5, `${same} of ${now.length} context-free bindings equal the sublime-style preset`);
});
