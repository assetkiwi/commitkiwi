// Key bindings editor logic: effective bindings per command, conflicts, and edits to the user keymap file made as
// text splices, so comments and entries we don't understand survive. Pure (node-tested).
import { normalizeKey, type Binding, type Chord, type Platform } from "./keymap.ts";

/** Removing a default binding: bind its keys to a command that does nothing. */
export const NOOP = "noop";

/** A chord as a keymap writes it ("super+shift+p"). */
export const chordSpec = (c: Chord): string => [...c.mods, c.key].join("+");
/** Recording: a third chord starts a new sequence (sequences are at most two chords, like ⌘K ⌘B). */
export const nextSequence = (seq: Chord[], c: Chord): Chord[] => (seq.length >= 2 ? [c] : [...seq, c]);

/** Normalised identity of a key sequence ("super+k super+b"), null when a key name is invalid. */
export function seqId(keys: string[], p: Platform): string | null {
  const cs = (keys ?? []).map((k) => (typeof k === "string" ? normalizeKey(k, p) : null));
  return cs.length && cs.every(Boolean) ? (cs as Chord[]).map(chordSpec).join(" ") : null;
}

export const sameArgs = (a?: Record<string, unknown>, b?: Record<string, unknown>): boolean =>
  JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
const ctxOf = (b: Binding): string => JSON.stringify(b.context ?? []);
const isBinding = (b: unknown): b is Binding =>
  !!b && typeof b === "object" && Array.isArray((b as Binding).keys) && typeof (b as Binding).command === "string";

/** One binding of the effective keymap. `index`: position in its list (the user's file for user bindings). */
export interface Entry { binding: Binding; user: boolean; index: number; id: string; shadowed: boolean }

/** Defaults then the user's file (later wins). `shadowed`: a later binding has the same keys and context. */
export function keymapEntries(defaults: Binding[], user: unknown[], p: Platform): Entry[] {
  const list: Omit<Entry, "shadowed">[] = [];
  defaults.forEach((b, index) => { const id = seqId(b.keys, p); if (id) list.push({ binding: b, user: false, index, id }); });
  user.forEach((b, index) => { const id = isBinding(b) && seqId(b.keys, p); if (id) list.push({ binding: b as Binding, user: true, index, id }); });
  return list.map((e, k) => ({ ...e, shadowed: list.slice(k + 1).some((l) => l.id === e.id && ctxOf(l.binding) === ctxOf(e.binding)) }));
}

/** A line of the editor: one command (with args, like `show_command_palette {command: push}`). */
export interface Row { command: string; args?: Record<string, unknown>; caption: string; group: string }
const isRow = (e: Entry, r: Pick<Row, "command" | "args">) => e.binding.command === r.command && sameArgs(e.binding.args, r.args);

/** The row's live bindings (not shadowed), context-free first. */
export const bindingsOf = (entries: Entry[], r: Pick<Row, "command" | "args">): Entry[] =>
  entries.filter((e) => !e.shadowed && isRow(e, r)).sort((a, b) => Number(!!a.binding.context?.length) - Number(!!b.binding.context?.length));

/** Does the user's file change this row (own bindings, or a removed default)? */
export const isModified = (entries: Entry[], r: Pick<Row, "command" | "args">): boolean => resetRow(entries, r).remove.length > 0;

/** Live, context-free bindings that `keys` for row `r` would take over: the same keys, or one is the start of the other. */
export function conflictsFor(entries: Entry[], keys: string[], r: Pick<Row, "command" | "args">, p: Platform): Entry[] {
  const id = seqId(keys, p);
  if (!id) return [];
  return entries.filter((e) => !e.shadowed && !e.binding.context?.length && e.binding.command !== NOOP && !isRow(e, r)
    && (e.id === id || e.id.startsWith(`${id} `) || id.startsWith(`${e.id} `)));
}

/** What to change in the user's file: entries to delete (indices into it) and bindings to append. */
export interface Edit { remove: number[]; add: Binding[] }
const bindingFor = (r: Pick<Row, "command" | "args">, keys: string[]): Binding =>
  r.args && Object.keys(r.args).length ? { keys, command: r.command, args: r.args } : { keys, command: r.command };

/** Give row `r` the keys. `replace`: they become its only (context-free) shortcut; otherwise one more. */
export function setKeys(entries: Entry[], r: Pick<Row, "command" | "args">, keys: string[], p: Platform, replace: boolean): Edit {
  if (!replace) return { remove: [], add: [bindingFor(r, keys)] };
  const id = seqId(keys, p);
  const mine = bindingsOf(entries, r).filter((e) => !e.binding.context?.length);
  const defaults = mine.filter((e) => !e.user);
  const add = defaults.filter((e) => e.id !== id).map((e): Binding => ({ keys: e.binding.keys, command: NOOP }));
  if (!defaults.some((e) => e.id === id)) add.push(bindingFor(r, keys));
  return { remove: mine.filter((e) => e.user).map((e) => e.index), add };
}

/** Remove one binding: a user one is deleted, a default one is unbound (noop on its keys, same context). */
export const removeBinding = (e: Entry): Edit => e.user
  ? { remove: [e.index], add: [] }
  : { remove: [], add: [e.binding.context?.length ? { keys: e.binding.keys, command: NOOP, context: e.binding.context } : { keys: e.binding.keys, command: NOOP }] };

/** Back to the defaults: the user's bindings for the row, and noops that removed one of its defaults. */
export function resetRow(entries: Entry[], r: Pick<Row, "command" | "args">): Edit {
  const defaults = new Set(entries.filter((e) => !e.user && isRow(e, r)).map((e) => e.id + ctxOf(e.binding)));
  return {
    remove: entries.filter((e) => e.user && (isRow(e, r) || (e.binding.command === NOOP && defaults.has(e.id + ctxOf(e.binding))))).map((e) => e.index),
    add: [],
  };
}

/** `{ "keys": ["super+k"], "command": "x" }`: one line per binding. */
export const formatBinding = (b: Binding): string =>
  `{ ${Object.entries(b).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`;

/** Top-level elements of the file's root array as [start, end) offsets, and the offset of its closing `]`; null if
 *  the file is not an array. Skips strings and comments like `parseJsonc`. */
export function entrySpans(text: string): { spans: [number, number][]; close: number } | null {
  const spans: [number, number][] = [];
  let depth = 0, start = -1, last = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 1; continue; }
    if (/\s/.test(c)) continue;
    if (depth === 0) { if (c !== "[") return null; depth = 1; continue; }
    if (depth === 1 && (c === "," || c === "]")) {
      if (start >= 0) spans.push([start, last]);
      start = -1;
      if (c === "]") return { spans, close: i };
      continue;
    }
    if (depth === 1 && start < 0) start = i;
    if (c === '"') { i++; while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1; }
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    last = i + 1;
  }
  return null;
}

/** Reset all: every entry of the file goes (comments outside entries stay). */
export const resetAll = (text: string): Edit => ({ remove: (entrySpans(text.trim() ? text : EMPTY_KEYMAP)?.spans ?? []).map((_, i) => i), add: [] });

export const EMPTY_KEYMAP = "[\n]\n";

/** Apply an edit to the file's text: removed entries are cut out with their comma and line, new ones appended
 *  before the closing `]` (one per line, trailing comma). Everything else is kept byte for byte. */
export function applyEdit(text: string, edit: Edit): string {
  let out = text.trim() ? text : EMPTY_KEYMAP;
  const first = entrySpans(out);
  if (!first) throw new Error("the key bindings file is not a JSON array; fix it with Open as Text");
  const adds = edit.add;
  for (const i of [...new Set(edit.remove)].sort((a, b) => b - a)) {
    const span = first.spans[i];
    if (!span) continue;
    let [s, e] = span;
    while (out[e] === " " || out[e] === "\t") e++;
    if (out[e] === ",") e++;
    while (out[e] === " " || out[e] === "\t") e++;
    let ls = s;
    while (ls > 0 && (out[ls - 1] === " " || out[ls - 1] === "\t")) ls--;
    if (ls === 0 || out[ls - 1] === "\n") { s = ls; if (out[e] === "\n") e++; } // the entry had its own line: drop the line
    out = out.slice(0, s) + out.slice(e);
  }
  if (!adds.length) return out;
  const { spans, close } = entrySpans(out)!;
  if (spans.length) {
    const end = spans[spans.length - 1][1];
    // a comma after the last entry (comments may sit in between)?
    const between = out.slice(end, close).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
    if (!between.includes(",")) { out = `${out.slice(0, end)},${out.slice(end)}`; return applyAppend(out, entrySpans(out)!.close, adds); }
  }
  return applyAppend(out, close, adds);
}

function applyAppend(out: string, close: number, adds: Binding[]): string {
  let at = close;
  while (at > 0 && (out[at - 1] === " " || out[at - 1] === "\t")) at--;
  const lines = adds.map((b) => `\t${formatBinding(b)},\n`).join("");
  return at > 0 && out[at - 1] === "\n" ? out.slice(0, at) + lines + out.slice(at) : `${out.slice(0, close)}\n${lines}${out.slice(close)}`;
}

interface MenuLike { caption: string; command?: string; args?: Record<string, unknown>; children?: MenuLike[] }
/** Every command the editor lists, grouped by main menu (top-level caption), then the rest under "Other": menu items
 *  (with their args), registered commands, and anything a binding names. Menu order first. */
export function buildRows(menus: MenuLike[], commands: { name: string; caption?: string }[], entries: Entry[]): Row[] {
  const rows = new Map<string, Row>();
  const caption = new Map(commands.map((c) => [c.name, c.caption]));
  const put = (command: string, args: Record<string, unknown> | undefined, cap: string, group: string) => {
    if (command === NOOP || command.startsWith("native:")) return;
    const a = args && Object.keys(args).length ? args : undefined;
    const k = command + JSON.stringify(a ?? {});
    if (!rows.has(k)) rows.set(k, { command, args: a, caption: cap, group });
  };
  const walk = (list: MenuLike[], group?: string) => list.forEach((d) => {
    if (d.children) walk(d.children, group ?? d.caption);
    else if (d.command && d.caption !== "-" && group) put(d.command, d.args, d.caption, group);
  });
  walk(menus);
  for (const c of commands) put(c.name, undefined, c.caption ?? c.name, "Other");
  for (const { binding: b } of entries) {
    const target = b.command === "show_command_palette" && typeof b.args?.command === "string" ? b.args.command : null;
    put(b.command, b.args, (target ? caption.get(target) ?? target : caption.get(b.command)) ?? b.command, "Other");
  }
  const groups = [...new Set([...rows.values()].map((r) => r.group))];
  return [...rows.values()].sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group));
}

/** A binding's `context` in words ("when overlay_visible, not text_focus"). */
export const contextNote = (conds: Binding["context"]): string => `when ${(conds ?? []).map((c) => {
  const neg = (c.operator ?? "").startsWith("not_");
  const val = c.operand === undefined || c.operand === true ? "" : c.operand === false ? "" : ` = ${String(c.operand)}`;
  return `${neg !== (c.operand === false) ? "not " : ""}${c.key}${val}`;
}).join(", ")}`;
