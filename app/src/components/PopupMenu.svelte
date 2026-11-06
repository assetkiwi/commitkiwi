<script lang="ts">
  import { ui, type MenuItem } from "../lib/ui.svelte";

  let el = $state<HTMLUListElement>();
  let subEl = $state<HTMLUListElement>();
  const menu = $derived(ui.menu);
  /** the open submenu (one level, as in the commit menu): its parent row and items */
  let sub = $state<{ at: number; items: (MenuItem | "-")[]; anchor: DOMRect } | null>(null);
  const close = () => { ui.menu = null; };
  // keep it on screen: flip left/up when it would overflow the window
  let pos = $state({ x: 0, y: 0 });
  let subPos = $state({ x: 0, y: 0 });
  $effect(() => {
    sub = null;
    if (!menu || !el) return;
    const r = el.getBoundingClientRect();
    pos = { x: Math.max(4, Math.min(menu.x, innerWidth - r.width - 4)), y: Math.max(4, Math.min(menu.y, innerHeight - r.height - 4)) };
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  });
  $effect(() => {
    if (!sub || !subEl) return;
    const r = subEl.getBoundingClientRect(), a = sub.anchor;
    const x = a.right + r.width + 4 > innerWidth ? a.left - r.width : a.right;
    subPos = { x: Math.max(4, x), y: Math.max(4, Math.min(a.top - 4, innerHeight - r.height - 4)) };
  });
  function pick(item: MenuItem) { close(); item.run?.(); }
  function openSub(e: Event, i: number, item: MenuItem, focus: boolean) {
    const anchor = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (sub?.at !== i) sub = { at: i, items: item.children!, anchor };
    if (focus) queueMicrotask(() => subEl?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
  }
  function onkeydown(e: KeyboardEvent, inSub: boolean) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === "ArrowLeft" && inSub) {
      e.preventDefault();
      const at = sub!.at;
      sub = null;
      el?.querySelectorAll<HTMLButtonElement>(":scope > li > button")[at]?.focus();
      return;
    }
    if (e.key === "ArrowRight" && !inSub) {
      const btn = document.activeElement as HTMLElement;
      if (btn?.dataset.sub !== undefined) { e.preventDefault(); btn.click(); }
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const list = inSub ? subEl! : el!;
    const btns = [...list.querySelectorAll<HTMLButtonElement>(":scope > li > button:not(:disabled)")];
    const at = btns.indexOf(document.activeElement as HTMLButtonElement);
    btns[(at + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length]?.focus();
  }
</script>

{#snippet rows(items: (MenuItem | "-")[], inSub: boolean)}
  {#each items as item, i}
    {#if item === "-"}<li class="sep" role="separator"></li>
    {:else if item.children}
      <li role="none"><button role="menuitem" aria-haspopup="menu" aria-expanded={sub?.at === i} data-sub="" class:open={sub?.at === i}
        onmouseenter={(e) => openSub(e, i, item, false)} onclick={(e) => openSub(e, i, item, true)}>
        <span class="ck"></span><span class="l">{item.label}</span><span class="d">›</span>
      </button></li>
    {:else}
      <li role="none"><button role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"} aria-checked={item.checked} disabled={item.disabled}
        onmouseenter={() => { if (!inSub) sub = null; }} onclick={() => pick(item)}>
        <span class="ck">{item.checked ? "✓" : ""}</span><span class="l">{item.label}</span>{#if item.detail}<span class="d">{item.detail}</span>{/if}
      </button></li>
    {/if}
  {/each}
{/snippet}

{#if menu}
  <div class="scrim" role="presentation" onmousedown={close} oncontextmenu={(e) => { e.preventDefault(); close(); }}></div>
  <ul class="popup" role="menu" bind:this={el} style:left="{pos.x}px" style:top="{pos.y}px" onkeydown={(e) => onkeydown(e, false)}>
    {@render rows(menu.items, false)}
  </ul>
  {#if sub}
    <ul class="popup" role="menu" aria-label="Submenu" bind:this={subEl} style:left="{subPos.x}px" style:top="{subPos.y}px" onkeydown={(e) => onkeydown(e, true)}>
      {@render rows(sub.items, true)}
    </ul>
  {/if}
{/if}
