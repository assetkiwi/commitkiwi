<script lang="ts">
  import { app, closeTab, hostOf, moveTab, setActive, tabName } from "../lib/state.svelte";
  import { showMenu } from "../lib/ui.svelte";
  import { showContextMenu } from "../lib/mainMenu";
  import { TAB } from "../lib/contextMenus";
  function listMenu(e: MouseEvent) {
    showMenu(e.currentTarget as HTMLElement, [
      ...app.tabs.map((t) => ({ label: tabName(t), checked: app.active === t.id, run: () => setActive(t.id) })),
      "-",
      { label: "New Tab", checked: app.active === "locations", run: () => setActive("locations") },
    ]);
  }

  // Drag to reorder, with pointer events (HTML5 drag and drop belongs to the webview's file drop in Tauri). A press
  // becomes a drag only past DRAG_PX, so clicks and middle-click close work as before; Escape cancels a drag.
  // Tab views are not moved: App.svelte keeps them in a fixed order, so a reorder never touches their state.
  const DRAG_PX = 5;
  let bar = $state<HTMLElement>();
  let press: { id: string; x: number; pointer: number } | null = null;
  /** `gap`: where the tab would land (0 = before the first); `x`: the insertion mark, in the bar's coordinates */
  let drag = $state<{ id: string; gap: number; x: number } | null>(null);

  function down(e: PointerEvent, id: string) {
    if (e.button === 1) e.preventDefault(); // no autoscroll: the middle button closes (auxclick)
    if (e.button !== 0 || (e.target as Element).closest(".x")) return;
    press = { id, x: e.clientX, pointer: e.pointerId };
  }
  function gapAt(clientX: number): { gap: number; x: number } {
    const tabs = [...bar!.querySelectorAll<HTMLElement>(".tab[data-id]")].map((el) => el.getBoundingClientRect());
    if (!tabs.length) return { gap: 0, x: 0 }; // every tab closed mid-drag
    const gap = tabs.findIndex((r) => clientX < r.left + r.width / 2);
    const at = gap < 0 ? tabs.length : gap;
    const edge = at < tabs.length ? tabs[at].left : tabs[tabs.length - 1].right;
    return { gap: at, x: edge - bar!.getBoundingClientRect().left - 1 };
  }
  function move(e: PointerEvent) {
    if (!press || e.pointerId !== press.pointer) return;
    if (!drag) {
      if (Math.abs(e.clientX - press.x) < DRAG_PX) return;
      // from here on the pointer is ours, even outside the window
      bar!.querySelector<HTMLElement>(`.tab[data-id="${CSS.escape(press.id)}"]`)?.setPointerCapture(e.pointerId);
    }
    drag = { id: press.id, ...gapAt(e.clientX) };
  }
  function up(e: PointerEvent) {
    if (!press || e.pointerId !== press.pointer) return;
    const d = drag;
    press = null;
    drag = null;
    if (!d || e.type === "pointercancel") return;
    const from = app.tabs.findIndex((t) => t.id === d.id);
    moveTab(d.id, d.gap > from ? d.gap - 1 : d.gap);
    setActive(d.id); // as browsers do: the tab you dragged is the one you look at
  }
  function key(e: KeyboardEvent) {
    if (e.key !== "Escape" || !drag) return;
    e.preventDefault();
    e.stopPropagation(); // the drag takes this Escape, not the panels behind it
    press = null;
    drag = null;
  }
</script>

<svelte:window onpointermove={move} onpointerup={up} onpointercancel={up} onkeydowncapture={key} />
<nav class="tabbar" class:dragging={!!drag} aria-label="Open repositories" bind:this={bar}>
  {#each app.tabs as t, index (t.id)}
    <div class="tab" class:on={app.active === t.id} class:dirty={t.dirty} class:lifted={drag?.id === t.id} data-id={t.id} role="presentation"
      oncontextmenu={(e) => showContextMenu(e, TAB, { index })} onpointerdown={(e) => down(e, t.id)} onauxclick={(e) => { if (e.button === 1) closeTab(t.id); }}>
      <button class="tab-main" onclick={() => setActive(t.id)} title={`${hostOf(t.location) || "local"}: ${t.path}`}>
        <svg class="i"><use href={hostOf(t.location) ? "#i-server" : "#i-folder"} /></svg>{tabName(t)}
      </button>
      <button class="x" aria-label={`Close ${tabName(t)}`} title={t.dirty ? "Uncommitted changes" : "Close"} onclick={() => closeTab(t.id)}>
        <span class="dot"></span><svg class="i"><use href="#i-x" /></svg>
      </button>
    </div>
  {/each}
  {#if drag}<span class="tab-drop" style:left={`${drag.x}px`} aria-hidden="true"></span>{/if}
  {#if app.active === "dashboard"}
    <div class="tab on"><span class="tab-main"><svg class="i"><use href="#i-panel" /></svg>Dashboard</span></div>
  {:else if app.active === "locations" || !app.tabs.length}
    <div class="tab on"><span class="tab-main"><svg class="i"><use href="#i-folder" /></svg>New Tab</span></div>
  {/if}
  <span class="grow" data-tauri-drag-region></span>
  <button class="ib sm" aria-label="List tabs" title="Tabs" onclick={listMenu}><svg class="i"><use href="#i-down" /></svg></button>
  <button class="ib sm" aria-label="New tab" title="New Tab" onclick={() => setActive("locations")}><svg class="i"><use href="#i-plus" /></svg></button>
</nav>
