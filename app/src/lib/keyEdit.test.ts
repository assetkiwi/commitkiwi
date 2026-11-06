import { test } from "node:test";
import assert from "node:assert/strict";
import { NOOP, applyEdit, bindingsOf, buildRows, contextNote, chordSpec, conflictsFor, entrySpans, isModified, keymapEntries, nextSequence, removeBinding, resetAll, resetRow, seqId, setKeys } from "./keyEdit.ts";
import { Keymap, chordFromEvent, normalizeKey, type Binding } from "./keymap.ts";
import { parseJsonc } from "./jsonc.ts";

const ev = (code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) =>
  ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

const DEFAULTS: Binding[] = [
  { keys: ["super+b"], command: "show_command_palette", args: { command: "checkout_branch" } },
  { keys: ["super+k", "super+b"], command: "toggle_side_bar" },
  { keys: ["super+w"], command: "close" },
  { keys: ["escape"], command: "hide_overlay", context: [{ key: "overlay_visible" }] },
];
const close = { command: "close" };

test("chord capture: physical keys to key specs, two-step sequences", () => {
  const k = chordFromEvent(ev("KeyK", { metaKey: true }))!, b = chordFromEvent(ev("KeyB", { metaKey: true }))!;
  assert.equal(chordSpec(chordFromEvent(ev("KeyP", { metaKey: true, shiftKey: true, altKey: true }))!), "alt+shift+super+p");
  assert.equal(chordSpec(chordFromEvent(ev("Comma", { ctrlKey: true }))!), "ctrl+,");
  const seq = nextSequence(nextSequence([], k), b);
  assert.deepEqual(seq.map(chordSpec), ["super+k", "super+b"]);
  assert.deepEqual(nextSequence(seq, k).map(chordSpec), ["super+k"], "a third chord starts over");
  assert.equal(seqId(["command+shift+P"], "mac"), seqId(["super+shift+p"], "mac"));
  assert.equal(seqId(["hyper+x"], "mac"), null);
});

test("entries: user wins, shadowed defaults drop out, rows show their live bindings", () => {
  const e = keymapEntries(DEFAULTS, [{ keys: ["super+w"], command: "noop" }, "junk", { keys: ["super+shift+w"], command: "close" }], "mac");
  assert.equal(bindingsOf(e, close).length, 1);
  assert.equal(bindingsOf(e, close)[0].index, 2, "the junk entry keeps its index");
  assert.ok(e.find((x) => !x.user && x.binding.command === "close")!.shadowed);
  assert.ok(isModified(e, close));
  assert.ok(!isModified(e, { command: "toggle_side_bar" }));
});

test("conflicts: same keys and chord prefixes, own bindings and context ones ignored", () => {
  const e = keymapEntries(DEFAULTS, [], "mac");
  assert.deepEqual(conflictsFor(e, ["super+b"], close, "mac").map((x) => x.binding.command), ["show_command_palette"]);
  assert.deepEqual(conflictsFor(e, ["super+k"], close, "mac").map((x) => x.binding.command), ["toggle_side_bar"], "⌘K would cut off ⌘K ⌘B");
  assert.deepEqual(conflictsFor(e, ["super+w"], close, "mac"), [], "its own key");
  assert.deepEqual(conflictsFor(e, ["escape"], close, "mac"), [], "context bindings are not shadowed");
  const unbound = keymapEntries(DEFAULTS, [{ keys: ["super+b"], command: "noop" }], "mac");
  assert.deepEqual(conflictsFor(unbound, ["super+b"], close, "mac"), [], "a removed default is free");
});

test("set/replace/remove/reset edits behave like the keymap afterwards", () => {
  const p = "mac" as const;
  let text = "";
  const entries = () => keymapEntries(DEFAULTS, parseJsonc(text.trim() ? text : "[]") as unknown[], p);
  const km = () => new Keymap([...DEFAULTS, ...(parseJsonc(text.trim() ? text : "[]") as Binding[])], p);
  const run = (k: string) => { const r = km().resolve([normalizeKey(k, p)!], { control: null, modes: {} }); return r.kind === "run" ? r.binding.command : r.kind; };

  text = applyEdit(text, setKeys(entries(), close, ["super+shift+x"], p, true));
  assert.equal(run("super+shift+x"), "close");
  assert.equal(run("super+w"), NOOP, "replaced default is unbound");
  assert.deepEqual(km().bindingFor("close")?.keys, ["super+shift+x"]);

  text = applyEdit(text, setKeys(entries(), close, ["super+e"], p, true));
  assert.equal(run("super+shift+x"), "none", "replacing again drops the previous user binding");
  assert.equal(run("super+e"), "close");

  text = applyEdit(text, setKeys(entries(), close, ["super+w"], p, true));
  assert.equal(run("super+w"), "close", "back to the default keys");
  assert.equal(bindingsOf(entries(), close).length, 1);

  text = applyEdit(text, resetRow(entries(), close));
  assert.deepEqual(parseJsonc(text), []);
  assert.ok(!isModified(entries(), close));

  // add as another, then remove the default one only
  text = applyEdit(text, setKeys(entries(), close, ["super+e"], p, false));
  const def = bindingsOf(entries(), close).find((x) => !x.user)!;
  text = applyEdit(text, removeBinding(def));
  assert.equal(run("super+w"), NOOP);
  assert.equal(run("super+e"), "close");
  const mine = bindingsOf(entries(), close).find((x) => x.user)!;
  text = applyEdit(text, removeBinding(mine));
  assert.deepEqual(bindingsOf(entries(), close), []);

  // override another command's key: allowed, the other one loses it
  text = applyEdit(text, setKeys(entries(), close, ["super+b"], p, false));
  assert.equal(run("super+b"), "close");
  assert.equal(bindingsOf(entries(), { command: "show_command_palette", args: { command: "checkout_branch" } }).length, 0);

  // args survive: the palette row
  const branch = { command: "show_command_palette", args: { command: "checkout_branch" } };
  text = applyEdit(text, setKeys(entries(), branch, ["super+alt+b"], p, true));
  assert.equal(km().bindingFor("show_command_palette", { command: "checkout_branch" })?.keys[0], "super+alt+b");
});

test("file edits keep comments and unknown entries, and stay valid JSON with comments", () => {
  const text = `// my keys\n[\n\t// mine\n\t{ "keys": ["super+e"], "command": "close" },\n\t{ "keys": ["f1"], "command": "custom_plugin", "args": {"a": "]"} } // trailing\n]\n`;
  assert.equal(entrySpans(text)!.spans.length, 2);
  const added = applyEdit(text, { remove: [], add: [{ keys: ["f2"], command: "refresh" }] });
  assert.match(added, /\/\/ my keys/);
  assert.match(added, /\/\/ trailing/);
  assert.deepEqual((parseJsonc(added) as Binding[]).map((b) => b.command), ["close", "custom_plugin", "refresh"]);
  const removed = applyEdit(added, { remove: [0], add: [] });
  assert.deepEqual((parseJsonc(removed) as Binding[]).map((b) => b.command), ["custom_plugin", "refresh"]);
  assert.match(removed, /\/\/ mine/);
  assert.ok(!removed.includes("super+e"));
  const all = applyEdit(removed, resetAll(removed));
  assert.deepEqual(parseJsonc(all), []);
  assert.match(all, /\/\/ my keys/);
  // the app's own template (comments only) and an empty file
  const tpl = "[\n\t// Your key bindings override the defaults.\n]\n";
  assert.deepEqual(parseJsonc(applyEdit(tpl, { remove: [], add: [{ keys: ["f2"], command: "refresh" }] })), [{ keys: ["f2"], command: "refresh" }]);
  assert.deepEqual(parseJsonc(applyEdit("", { remove: [], add: [{ keys: ["f2"], command: "refresh" }] })), [{ keys: ["f2"], command: "refresh" }]);
  assert.deepEqual(parseJsonc(applyEdit('[{"keys":["f3"],"command":"x"}]', { remove: [], add: [{ keys: ["f2"], command: "y" }] })), [{ keys: ["f3"], command: "x" }, { keys: ["f2"], command: "y" }]);
  assert.throws(() => applyEdit('{"keys": []}', { remove: [], add: [] }), /not a JSON array/);
});

test("rows: menus first with their args, then registered and bound commands; context in words", () => {
  const menus = [{ caption: "File", children: [{ caption: "Close Tab", command: "close" }, { caption: "-" }, { caption: "Copy", command: "native:copy" }] },
    { caption: "Repository", children: [{ caption: "Checkout Branch…", command: "show_command_palette", args: { command: "checkout_branch" } }] }];
  const rows = buildRows(menus, [{ name: "close", caption: "Close Tab" }, { name: "refresh", caption: "Refresh" }], keymapEntries(DEFAULTS, [{ keys: ["f1"], command: "noop" }], "mac"));
  assert.deepEqual(rows.map((r) => `${r.group}:${r.caption}`), ["File:Close Tab", "Repository:Checkout Branch…", "Other:Refresh", "Other:toggle_side_bar", "Other:hide_overlay"]);
  assert.deepEqual(rows[1].args, { command: "checkout_branch" });
  assert.equal(contextNote([{ key: "overlay_visible" }]), "when overlay_visible");
  assert.equal(contextNote([{ key: "control", operand: "commit_table" }, { key: "search_mode", operator: "not_equal" }]), "when control = commit_table, not search_mode");
});
