// UI-wide state that key bindings can test (`context`) and the overlay widget (palette, option lists, prompts).
export interface OverlayItem { label: string; detail?: string; value?: unknown; /** one-letter kind badge (L = local branch, T = tag) */ icon?: string }
export interface OverlayStep {
  placeholder: string;
  /** earlier answers of a multi-step prompt, shown as pills before the input */
  pills?: string[];
  items: OverlayItem[];
  /** free text: Enter picks `{ label: <typed text> }` and the list is hidden */
  text?: boolean;
  /** starting text of the input */
  value?: string;
  /** shown under the input (a rejected name, say) */
  error?: string;
  /** row selected when the step opens (the current branch, say) */
  selected?: number;
  /** the highlighted row changed (undefined: the overlay closed); Select Theme previews with it */
  preview?: (item: OverlayItem | undefined) => void;
  /** return the next step to continue, nothing to finish */
  pick: (item: OverlayItem) => void | OverlayStep | Promise<void | OverlayStep>;
  /** pill `index` was removed: the step to show instead. Default: the step where that pill was answered, else the
   *  command's own first step; set it when later answers should survive or a pill was filled in by default */
  unpill?: (index: number) => OverlayStep | null | void;
}

export const ui = $state({
  sidebar: true,
  // compatible keymap context key names, so imported `context` entries keep working
  modes: {
    overlay_visible: false, search_mode: false, console_visible: false, blame_mode: false,
    tree_mode: false, merge_mode: false, command_status_visible: false, preferences: false, auto_complete_visible: false,
  } as Record<string, boolean>,
  /** modes owned by a repo tab (search_mode, console_visible, merge_mode, auto_complete_visible), by tab id:
   *  every open tab stays mounted, so only the visible tab's count (keys.svelte.ts merges them in) */
  tabModes: {} as Record<string, Record<string, boolean>>,
  overlay: null as OverlayStep | null,
  menu: null as PopupMenu | null,
  /** the Add Repositories from Folder… dialog (counts as an overlay, so Escape/hide_overlay closes it) */
  addRepos: false,
  /** the Preferences window's open page, null when closed (`preferences` mode, a keymap context key) */
  prefsPage: null as string | null,
  /** the forge each repo tab's requests go to, once Create Pull/Merge Request found out (the command's caption) */
  forgeKinds: {} as Record<string, "github" | "gitlab">,
});

export function showPreferences(page = "appearance"): void {
  ui.prefsPage = page;
  ui.modes.preferences = true;
}
export function closePreferences(): void {
  ui.prefsPage = null;
  ui.modes.preferences = false;
}

/** `children`: a submenu (opens to the side) */
export interface MenuItem { label: string; detail?: string; checked?: boolean; disabled?: boolean; run?: () => void; children?: (MenuItem | "-")[] }
/** A dropdown or context menu at a screen position; `"-"` is a separator. */
export interface PopupMenu { x: number; y: number; items: (MenuItem | "-")[] }

/** Open a menu under `anchor` (a toolbar button) or at a mouse position. */
export function showMenu(at: HTMLElement | MouseEvent, items: (MenuItem | "-")[]): void {
  if (at instanceof MouseEvent) { ui.menu = { x: at.clientX, y: at.clientY, items }; return; }
  const r = at.getBoundingClientRect();
  ui.menu = { x: r.left, y: r.bottom + 4, items };
}

// The steps that led to the shown one (removing a pill goes back to where it was answered), and the command that
// opened the prompt (its first step, when the answer came from arguments or a default). Not reactive: only read on removal.
let trail: OverlayStep[] = [];
let opener: string | null = null;
let lastCommand: string | null = null;
/** commands.ts calls this for every command run, so the prompt it opens knows its command */
export const noteCommand = (name: string): void => { lastCommand = name; };

export function showOverlay(step: OverlayStep): void {
  trail = [];
  opener = lastCommand;
  ui.addRepos = false;
  ui.overlay = step;
  ui.modes.overlay_visible = true;
}

export function showAddRepos(): void {
  ui.overlay = null;
  ui.addRepos = true;
  ui.modes.overlay_visible = true;
}

export function hideOverlay(): void {
  ui.overlay = null;
  ui.addRepos = false;
  ui.modes.overlay_visible = false;
}

export async function pickOverlay(item: OverlayItem): Promise<void> {
  const step = ui.overlay;
  if (!step) return;
  const next = await step.pick(item);
  if (next) { if (ui.overlay === step) trail.push(step); ui.overlay = next; }
  else if (ui.overlay === step) hideOverlay();
}

/** Remove pill `i` from the prompt: the first pill (the command) goes back to the command palette; a later one to the
 *  step that answered it, so only the options that still fit what is left are offered. */
export function removePill(i: number): void {
  const step = ui.overlay;
  if (!step || i < 0 || i >= (step.pills?.length ?? 0)) return;
  if (i > 0) {
    const own = step.unpill?.(i);
    if (own) { ui.overlay = own; return; }
    let k = trail.length - 1;
    while (k >= 0 && (trail[k].pills?.length ?? 0) !== i) k--;
    if (k >= 0) { ui.overlay = trail[k]; trail = trail.slice(0, k); return; }
  }
  // the command pill, or an answer that came from arguments: the command again without them (it asks), else the palette
  const name = i > 0 && opener && opener !== "show_command_palette" ? opener : "show_command_palette";
  hideOverlay();
  rerun(name);
}
let rerun: (name: string) => void = () => {};
/** commands.ts registers how to run a command by name (this module stays free of imports) */
export const setRerun = (fn: (name: string) => void): void => { rerun = fn; };
