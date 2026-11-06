// Glue between the menu definitions (menu.ts), the command registry and keymap, and the two ways of showing them.
import { api, inTauri } from "./api";
import { hasCommand, menuCaption, onCommandsChanged, runCommand } from "./commands";
import { currentKeymap, justPressed, platform } from "./keys.svelte";
import { accelerator, prettyKeys } from "./keymap";
import { MAIN_MENU, fillMenu, resolveMenu, type MenuAction, type MenuDef, type MenuNode } from "./menu";
import { app } from "./state.svelte";
import { showMenu, type MenuItem } from "./ui.svelte";

/** macOS desktop app: the OS menu bar. Everywhere else the title bar draws the same menus (MenuBar.svelte). */
export const nativeMenu = inTauri && platform === "mac";

const resolve = (native: boolean, defs = MAIN_MENU) =>
  resolveMenu(defs, hasCommand, (command, args) => currentKeymap().bindingFor(command, args)?.keys, native, menuCaption);
const run = (a: MenuAction | undefined) => { if (a) runCommand(a.command, a.args); };
const items = (nodes: MenuNode[], actions: MenuAction[]): (MenuItem | "-")[] => nodes.map((n): MenuItem | "-" => n.caption === "-" ? "-"
  : n.children ? { label: n.caption, children: items(n.children, actions) }
  : { label: n.caption, detail: n.keys && prettyKeys(n.keys, platform), disabled: !n.enabled, run: () => run(actions[Number(n.id)]) });

/** The in-window menus, resolved when opened, so they always match the registry and keymap. */
export function windowMenus(): { caption: string; items: (MenuItem | "-")[] }[] {
  const { nodes, actions } = resolve(false);
  return nodes.map((m) => ({ caption: m.caption, items: items(m.children!, actions) }));
}

export const contextVars = (vars: Record<string, unknown>): Record<string, unknown> =>
  ({ reveal: platform === "mac" ? "Reveal in Finder" : "Open Containing Folder…", ...vars });

/**
 * The one context-menu renderer: `defs` (contextMenus.ts) filled for this target with `vars`, resolved against the
 * registry (missing or refused commands disabled) and keymap, shown at the mouse (right-click) or under a `…` button.
 */
export function showContextMenu(at: HTMLElement | MouseEvent, defs: MenuDef[], vars: Record<string, unknown> | null = {}): void {
  if (at instanceof MouseEvent) { at.preventDefault(); at.stopPropagation(); }
  // null: `defs` are filled already (filling twice would read `$x` inside a filled-in ref name)
  const { nodes, actions } = resolve(false, vars ? fillMenu(defs, contextVars(vars)) : defs);
  if (nodes.length) showMenu(at, items(nodes, actions));
}

/** Edit > Undo/Redo own these in the OS menu (text undo in fields); Repository > Undo/Redo show none, the keymap still runs them. */
const NATIVE_KEYS = new Set(["super+z", "super+shift+z"]);
const withAccels = (nodes: MenuNode[]): MenuNode[] =>
  nodes.map((n) => ({ ...n, accel: n.keys && !NATIVE_KEYS.has(n.keys.join(" ")) ? accelerator(n.keys, platform) : undefined, children: n.children && withAccels(n.children) }));

/** Keep the native menu in step with the registry and keymap; returns the uninstall function. */
export function installNativeMenu(): () => void {
  if (!nativeMenu) return () => {};
  // ids are positions in MAIN_MENU, so they stay valid across rebuilds
  let actions: MenuAction[] = [], sent = "", timer: ReturnType<typeof setTimeout> | undefined;
  const sync = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const r = resolve(true);
      actions = r.actions;
      const menus = withAccels(r.nodes), json = JSON.stringify(menus);
      if (json === sent) return;
      sent = json;
      api.setMenu(menus).catch((e) => { app.notice = `Menu bar: ${e}`; });
    }, 30);
  };
  sync();
  const off = onCommandsChanged(sync);
  // A shortcut the webview already handled may come back as the menu item's accelerator: run it once only.
  const unlisten = api.onMenu((id) => { const a = actions[Number(id)]; if (!a?.keys || !justPressed(a.keys)) run(a); });
  return () => { off(); clearTimeout(timer); void unlisten.then((u) => u()); };
}
