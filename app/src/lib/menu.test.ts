import { test } from "node:test";
import assert from "node:assert/strict";
import { MAIN_MENU, resolveMenu, type MenuNode } from "./menu.ts";
import { Keymap, accelerator } from "./keymap.ts";

const km = new Keymap([
  { keys: ["super+w"], command: "close" },
  { keys: ["super+b"], command: "show_command_palette", args: { command: "checkout_branch" } },
  { keys: ["super+p"], command: "show_command_palette" },
  { keys: ["super+k", "super+b"], command: "toggle_side_bar" },
], "mac");
const has = (c: string) => ["close", "checkout_branch", "show_command_palette", "toggle_side_bar"].includes(c);
const keysFor = (c: string, a: Record<string, unknown>) => km.bindingFor(c, a)?.keys;
const find = (nodes: MenuNode[], caption: string): MenuNode | undefined =>
  nodes.flatMap((n) => (n.caption === caption ? [n] : find(n.children ?? [], caption) ? [find(n.children!, caption)!] : []))[0];

test("menu: registered commands enabled with their keys, missing ones disabled, ids index the actions", () => {
  const { nodes, actions } = resolveMenu(MAIN_MENU, has, keysFor, true);
  const close = find(nodes, "Close Tab")!;
  assert.equal(close.enabled, true);
  assert.deepEqual(close.keys, ["super+w"]);
  assert.deepEqual(actions[Number(close.id)], { command: "close", args: {}, keys: ["super+w"] });
  // show_command_palette {command}: available when that command is, hint from the binding with the same args
  assert.equal(find(nodes, "Check Out Branch…")!.enabled, true);
  assert.deepEqual(find(nodes, "Check Out Branch…")!.keys, ["super+b"]);
  assert.equal(find(nodes, "New Branch…")!.enabled, false);
  assert.deepEqual(find(nodes, "Command Palette…")!.keys, ["super+p"], "the plain binding, not the one with args");
  assert.equal(find(nodes, "Merge into Current Branch…")!.keys, undefined);
  assert.equal(find(nodes, "Clean Up Branches…")!.enabled, false, "cleanup_branches exists only with a repository open");
  // a submenu inside a menu (View > Layout)
  assert.equal(find(nodes, "Layout")!.children!.length, 4);
  assert.equal(find(nodes, "Copy")!.id, "native:copy");
});

test("menu: the in-window bar drops OS items and menus left empty, with no stray separators", () => {
  const { nodes } = resolveMenu(MAIN_MENU, has, keysFor, false);
  const tops = nodes.map((n) => n.caption);
  assert.ok(!tops.includes("Edit") && !tops.includes("Window") && tops.includes("File"));
  assert.equal(find(nodes, "Close Window"), undefined);
  for (const m of nodes) {
    const c = m.children!;
    assert.ok(c[0].caption !== "-" && c.at(-1)!.caption !== "-", m.caption);
    assert.ok(c.every((n, i) => n.caption !== "-" || c[i + 1].caption !== "-"), m.caption);
  }
});

test("accelerators: one chord only, in the native menu's syntax", () => {
  assert.equal(accelerator(["super+shift+p"], "mac"), "Shift+Cmd+P");
  assert.equal(accelerator(["primary+left"], "mac"), "Cmd+LEFT");
  assert.equal(accelerator(["shift+f8"], "mac"), "Shift+F8");
  assert.equal(accelerator(["super+k", "super+b"], "mac"), undefined);
});

test("menu: a command can name its own caption (Undo: commit)", () => {
  const { nodes } = resolveMenu(MAIN_MENU, (c) => c === "git_undo", keysFor, false, (c) => (c === "git_undo" ? "Undo: commit" : undefined));
  const changes = nodes.find((n) => n.caption === "Changes")!.children!;
  assert.deepEqual(changes.slice(-2).map((n) => [n.caption, n.enabled]), [["Undo: commit", true], ["Redo", false]]);
});

test("menu: Go lists repository tabs 1-9 with their Cmd+N keys, and moving the tab", () => {
  const tk = new Keymap([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ keys: [`super+${n}`], command: "select_tab", args: { index: n - 1 } })), "mac");
  const { nodes, actions } = resolveMenu(MAIN_MENU, (c) => c === "select_tab" || c === "move_tab_left", (c, a) => tk.bindingFor(c, a)?.keys, true);
  const t1 = find(nodes, "Tab 1")!, t9 = find(nodes, "Tab 9")!;
  assert.deepEqual([t1.enabled, t1.keys, t9.keys], [true, ["super+1"], ["super+9"]]);
  assert.deepEqual(actions[Number(t9.id)], { command: "select_tab", args: { index: 8 }, keys: ["super+9"] });
  assert.equal(find(nodes, "Tab 10"), undefined);
  assert.deepEqual([find(nodes, "Move Tab Left")!.enabled, find(nodes, "Move Tab Right")!.enabled], [true, false]);
  assert.ok(find(nodes, "Repository Dashboard"));
});

test("menu: Help holds About commit.kiwi & Licenses…", () => {
  const help = MAIN_MENU.find((m) => m.id === "help")!;
  assert.deepEqual(help.children!.map((c) => [c.caption, c.command]), [["About commit.kiwi & Licenses…", "show_about"]]);
});
