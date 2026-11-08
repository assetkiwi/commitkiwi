// One registry for everything a key, menu or the palette can trigger. Command names are the compatible ones
// (`new_tab`, `navigate_back`, ...), so keymap, command and menu files written for Sublime Merge work unchanged.
import { app } from "./state.svelte";
import { noteCommand, setRerun } from "./ui.svelte";

export interface CommandDef {
  run: (args: Record<string, unknown>) => void | Promise<void>;
  /** shown in the palette when set */
  caption?: string;
  /** the main menu's caption instead of its own (Undo: commit) */
  menuCaption?: string;
  /** refused, and why: the menu item shows disabled, the palette leaves it out, a key press shows the reason */
  disabled?: string;
}

const registry = new Map<string, CommandDef>();
const listeners = new Set<() => void>();

/** Called when commands come and go or the keymap reloads (the menu bar shows both). Returns the unsubscribe. */
export function onCommandsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const commandsChanged = (): void => listeners.forEach((fn) => fn());
/** Registered and not refused right now (what enables a menu item). */
export const hasCommand = (name: string): boolean => !!registry.get(name) && !registry.get(name)!.disabled;
export const menuCaption = (name: string): string | undefined => registry.get(name)?.menuCaption;

/** Returns an unregister function; it only removes this exact definition (a view may have replaced it since). */
export function registerCommand(name: string, def: CommandDef): () => void {
  registry.set(name, def);
  commandsChanged();
  return () => { if (registry.get(name) === def) { registry.delete(name); commandsChanged(); } };
}

/** False when nothing is registered under `name` (the key press then falls through to the browser). */
export function runCommand(name: string, args: Record<string, unknown> = {}): boolean {
  const cmd = registry.get(name);
  if (!cmd) return false;
  if (cmd.disabled) { app.notice = cmd.disabled; return true; }
  noteCommand(name);
  Promise.resolve()
    .then(() => cmd.run(args))
    .catch((e) => { app.notice = String(e); });
  return true;
}

setRerun((name) => { runCommand(name); });

/** Every registered command (the key bindings editor lists them all). */
export const registeredCommands = (): { name: string; caption?: string }[] => [...registry].map(([name, d]) => ({ name, caption: d.caption }));

