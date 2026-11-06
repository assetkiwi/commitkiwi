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

export function showOverlay(step: OverlayStep): void {
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
  if (next) ui.overlay = next;
  else if (ui.overlay === step) hideOverlay();
}
