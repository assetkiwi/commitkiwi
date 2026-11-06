// Key bindings: the common keymap JSON schema, key names and `context` rules. Pure and import-free.
export type Platform = "mac" | "linux" | "win";
type Mod = "ctrl" | "alt" | "shift" | "super";
export interface Chord { mods: Mod[]; key: string }
export interface Condition { key: string; operator?: string; operand?: unknown; match_all?: boolean }
export interface Binding { keys: string[]; command: string; args?: Record<string, unknown>; context?: Condition[] }
export interface KeyContext { control: string | null; modes: Record<string, unknown> }

const MOD_ALIAS: Record<string, Mod | "primary"> = {
  ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", altgr: "alt", shift: "shift",
  super: "super", command: "super", cmd: "super", meta: "super", primary: "primary",
};
const ORDER: Mod[] = ["ctrl", "alt", "shift", "super"];

// Key names for punctuation and keypad keys, as keymap files write them.
const KEY_ALIAS: Record<string, string> = {
  backquote: "`", equals: "=", forward_slash: "/", minus: "-", plus: "+", keypad_enter: "enter", keypad_minus: "-", keypad_plus: "+",
  return: "enter", esc: "escape", "": "space",
};

export function normalizeKey(spec: string, platform: Platform): Chord | null {
  const parts = spec.toLowerCase().split("+");
  // a literal "+" key is written "ctrl++"
  const key = spec.endsWith("++") ? "+" : parts[parts.length - 1];
  const mods = new Set<Mod>();
  for (const p of spec.endsWith("++") ? parts.slice(0, -2) : parts.slice(0, -1)) {
    const m = MOD_ALIAS[p];
    if (!m) return null;
    mods.add(m === "primary" ? (platform === "mac" ? "super" : "ctrl") : m);
  }
  return { mods: ORDER.filter((m) => mods.has(m)), key: KEY_ALIAS[key] ?? key };
}

const NAMED: Record<string, string> = {
  Escape: "escape", Enter: "enter", NumpadEnter: "enter", Tab: "tab", Backspace: "backspace", Delete: "delete", Space: "space",
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", PageUp: "pageup", PageDown: "pagedown",
  Home: "home", End: "end", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",", Period: ".",
  Slash: "/", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`",
};

/** Physical key (by `code`), so Option/Shift never turn "p" into "π" or "P". null for bare modifier presses. */
export function chordFromEvent(e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): Chord | null {
  let key = NAMED[e.code];
  if (!key) {
    const k = /^Key([A-Z])$/.exec(e.code), d = /^Digit(\d)$/.exec(e.code), f = /^F(\d{1,2})$/.exec(e.code);
    key = k ? k[1].toLowerCase() : d ? d[1] : f ? `f${f[1]}` : "";
  }
  if (!key) return null;
  const on: Record<Mod, boolean> = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, super: e.metaKey };
  return { mods: ORDER.filter((m) => on[m]), key };
}

export const sameChord = (a: Chord, b: Chord): boolean => a.key === b.key && a.mods.join() === b.mods.join();

function test(c: Condition, ctx: KeyContext): boolean {
  const actual = c.key === "control" ? ctx.control : ctx.modes[c.key];
  const operand = c.operand === undefined ? true : c.operand;
  const op = c.operator ?? "equal";
  const s = String(actual ?? "");
  switch (op) {
    case "equal": return actual === operand || (typeof operand === "boolean" && Boolean(actual) === operand);
    case "not_equal": return !(actual === operand || (typeof operand === "boolean" && Boolean(actual) === operand));
    case "regex_match": return new RegExp(`^(?:${operand})$`).test(s);
    case "not_regex_match": return !new RegExp(`^(?:${operand})$`).test(s);
    case "regex_contains": return new RegExp(String(operand)).test(s);
    case "not_regex_contains": return !new RegExp(String(operand)).test(s);
    default: return false; // unknown operator: never fire rather than fire wrongly
  }
}
export const matchesContext = (conds: Condition[] | undefined, ctx: KeyContext): boolean =>
  (conds ?? []).every((c) => test(c, ctx));

export type Resolution = { kind: "run"; binding: Binding } | { kind: "pending" } | { kind: "none" };

export class Keymap {
  private readonly parsed: { binding: Binding; chords: Chord[] }[];
  readonly platform: Platform;
  /** Later bindings win, so pass defaults first and the user's file after. */
  constructor(bindings: Binding[], platform: Platform) {
    this.platform = platform;
    this.parsed = bindings.flatMap((binding) => {
      const chords = (binding.keys ?? []).map((k) => normalizeKey(k, platform));
      return chords.length && chords.every(Boolean) && typeof binding.command === "string" ? [{ binding, chords: chords as Chord[] }] : [];
    });
  }

  resolve(seq: Chord[], ctx: KeyContext): Resolution {
    let pending = false;
    for (let i = this.parsed.length - 1; i >= 0; i--) {
      const { binding, chords } = this.parsed[i];
      if (chords.length < seq.length || !seq.every((c, k) => sameChord(c, chords[k]))) continue;
      if (!matchesContext(binding.context, ctx)) continue;
      if (chords.length === seq.length) return { kind: "run", binding };
      pending = true;
    }
    return { kind: pending ? "pending" : "none" };
  }

  /** The binding to show next to a command: the last one, unless a later binding took over the same keys.
   *  With `args`, only bindings with exactly those args count (a menu item for `show_command_palette {command: push}`). */
  bindingFor(command: string, args?: Record<string, unknown>): Binding | undefined {
    const id = (i: number) => JSON.stringify([this.parsed[i].chords, this.parsed[i].binding.context ?? []]);
    for (let i = this.parsed.length - 1; i >= 0; i--) {
      if (this.parsed[i].binding.command !== command) continue;
      if (args && JSON.stringify(this.parsed[i].binding.args ?? {}) !== JSON.stringify(args)) continue;
      const shadowed = this.parsed.slice(i + 1).some((_, k) => id(i + 1 + k) === id(i));
      if (!shadowed) return this.parsed[i].binding;
    }
    return undefined;
  }
}

const ACCEL_MOD: Record<Mod, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", super: "Cmd" };
/** One chord as a native menu accelerator ("Shift+Cmd+P"); undefined for key sequences, which a native menu can't show. */
export function accelerator(keys: string[], platform: Platform): string | undefined {
  const c = keys.length === 1 ? normalizeKey(keys[0], platform) : null;
  return c ? [...c.mods.map((m) => ACCEL_MOD[m]), c.key.toUpperCase()].join("+") : undefined;
}

const GLYPH: Record<string, string> = { super: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
const KEYNAME: Record<string, string> = { left: "←", right: "→", up: "↑", down: "↓", enter: "↵", escape: "Esc", tab: "Tab", backspace: "⌫", space: "Space", pageup: "PageUp", pagedown: "PageDown" };
/** `["super+shift+p"]` -> "⇧⌘P" on mac, "Ctrl+Shift+P" elsewhere. */
export function prettyKeys(keys: string[], platform: Platform): string {
  return keys.map((k) => {
    const c = normalizeKey(k, platform);
    if (!c) return k;
    const key = KEYNAME[c.key] ?? c.key.toUpperCase();
    if (platform === "mac") return [...c.mods.filter((m) => m !== "super").map((m) => GLYPH[m]), ...(c.mods.includes("super") ? [GLYPH.super] : []), key].join("");
    return [...c.mods.map((m) => m[0].toUpperCase() + m.slice(1)), key].join("+");
  }).join(" ");
}
