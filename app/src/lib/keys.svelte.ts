import { api } from "./api";
import { presetBindings } from "./defaultKeymap";
import { Keymap, chordFromEvent, normalizeKey, sameChord, type Binding, type Chord, type Platform } from "./keymap";
import { commandsChanged, runCommand } from "./commands";
import { parseJsonc } from "./jsonc";
import { app } from "./state.svelte";
import { ui } from "./ui.svelte";

/** The user's key bindings (an older `Default.sublime-keymap` is read while this file does not exist). */
export const KEYMAP_FILE = "keymap.json";
export const platform: Platform =
  typeof navigator === "undefined" ? "linux" : navigator.userAgent.includes("Mac") ? "mac" : navigator.userAgent.includes("Win") ? "win" : "linux";

let keymap = new Keymap(presetBindings(platform), platform);
export const currentKeymap = (): Keymap => keymap;
let user: Binding[] = [];

/** The active preset (`keymap_preset`), then the user's file on top (later bindings win). */
function rebuild(): void {
  keymap = new Keymap([...presetBindings(platform, app.prefs.keymap_preset), ...user], platform);
  commandsChanged();
}

/** Re-read the user's file. A broken file is reported, never fatal. */
export async function loadKeymap(): Promise<void> {
  user = [];
  try {
    const text = await api.readConfig(KEYMAP_FILE);
    if (text.trim()) {
      const parsed = parseJsonc(text);
      if (!Array.isArray(parsed)) throw new Error("the file must contain a JSON array");
      user = parsed as Binding[];
    }
  } catch (e) {
    app.notice = `Could not read your key bindings (${KEYMAP_FILE}): ${e instanceof Error ? e.message : e}`;
  }
  rebuild();
}

let lastKey: { chord: Chord; at: number } | undefined;
/** True when `keys` (one chord) was just pressed in the webview. A native menu item with that accelerator then fired
 *  for the same press, which the keymap already handled (or deliberately left to a text field), so it must not run again. */
export const justPressed = (keys: string[]): boolean => {
  const c = keys.length === 1 ? normalizeKey(keys[0], platform) : null;
  return !!c && !!lastKey && performance.now() - lastKey.at < 500 && sameChord(c, lastKey.chord);
};

const CHORD_TIMEOUT_MS = 1500;
// Typing in a text field is never a shortcut, except modified keys and these.
const ALWAYS = /^(escape|f\d{1,2})$/;
const EDITING = /^(left|right|up|down|home|end|backspace|delete)$/;

/** Capture-phase listener, so a binding wins over the focused widget. Returns the uninstall function. */
export function installKeys(): () => void {
  let seq: Chord[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = () => { seq = []; clearTimeout(timer); };

  const onKey = (e: KeyboardEvent) => {
    const chord = chordFromEvent(e);
    if (!chord) return;
    lastKey = { chord, at: performance.now() };
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (el?.closest("[data-keyrecord]")) return; // the key bindings editor is recording this press
    const editable = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    if (editable && !chord.mods.some((m) => m !== "shift") && !ALWAYS.test(chord.key)) return reset();
    if (editable && EDITING.test(chord.key)) return reset(); // ⌘← in a text field moves the caret, it is not "back"


    // text_focus: lets ⌘Z mean git undo only outside text fields (inside, the field's own undo)
    const ctx = { control: el?.closest("[data-control]")?.getAttribute("data-control") ?? null, modes: { ...ui.modes, ...ui.tabModes[app.active], text_focus: editable } };
    seq.push(chord);
    let r = keymap.resolve(seq, ctx);
    if (r.kind === "none" && seq.length > 1) { seq = [chord]; r = keymap.resolve(seq, ctx); } // a broken chord: try this key alone
    if (r.kind === "pending") {
      e.preventDefault();
      clearTimeout(timer);
      timer = setTimeout(reset, CHORD_TIMEOUT_MS);
      return;
    }
    reset();
    if (r.kind === "run" && runCommand(r.binding.command, r.binding.args ?? {})) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  const onFocus = () => { void loadKeymap(); }; // pick up edits to the keymap file made in an editor
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("focus", onFocus);
  // switching the preset (Preferences, settings.json) applies at once
  let preset = app.prefs.keymap_preset;
  const offPreset = $effect.root(() => { $effect(() => { if (app.prefs.keymap_preset !== preset) { preset = app.prefs.keymap_preset; rebuild(); } }); });
  return () => { offPreset(); window.removeEventListener("keydown", onKey, true); window.removeEventListener("focus", onFocus); reset(); };
}
