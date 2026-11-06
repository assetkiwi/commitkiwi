<script lang="ts">
  import { rank, segments } from "../lib/fuzzy";
  import { hideOverlay, pickOverlay, ui } from "../lib/ui.svelte";

  const MAX = 200; // rows rendered; the rest is reachable by typing
  let query = $state("");
  let index = $state(0);
  let input = $state<HTMLInputElement>();

  const step = $derived(ui.overlay);
  const results = $derived(step ? rank(step.items, query, (i) => i.label, (i) => i.detail).slice(0, MAX) : []);

  // a new step (or reopening) starts clean and focused
  $effect(() => { query = step?.value ?? ""; index = step?.selected ?? 0; queueMicrotask(() => { input?.focus(); input?.select(); }); });
  $effect(() => { if (query !== (step?.value ?? "")) index = 0; });
  // Select Theme: show the highlighted row live; closing (picked or not) shows whatever is saved
  $effect(() => {
    const s = step, item = results[index]?.item;
    if (!s?.preview) return;
    s.preview(item);
    return () => s.preview!(undefined);
  });

  function onkeydown(e: KeyboardEvent) {
    const n = results.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n) index = (index + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (step?.text) void pickOverlay({ label: query });
      else if (results[index]) void pickOverlay(results[index].item);
    }
    // Escape is a normal key binding (hide_overlay), so a user can rebind it
  }
  $effect(() => { document.querySelector(".overlay li.on")?.scrollIntoView({ block: "nearest" }); });
</script>

{#if step}
  <div class="scrim" role="presentation" onmousedown={hideOverlay}></div>
  <div class="overlay" role="dialog" aria-label={step.placeholder}>
    <div class="ov-in">
      {#each step.pills ?? [] as p}<span class="pill">{p}</span>{/each}
      <input bind:this={input} bind:value={query} data-control="overlay_input" placeholder={step.placeholder} {onkeydown}
        role="combobox" aria-expanded="true" aria-controls="ov-list" autocomplete="off" spellcheck="false" />
    </div>
    {#if step.error}<div class="ov-err" role="alert">{step.error}</div>{/if}
    {#if !step.text}
    <ul id="ov-list" role="listbox">
      {#each results as r, k (k)}
        <li role="option" aria-selected={k === index} class:on={k === index} onmousemove={() => (index = k)} onmousedown={(e) => { e.preventDefault(); void pickOverlay(r.item); }}>
          <span class="l">{#if r.item.icon}<i class="kind">{r.item.icon}</i>{/if}{#each segments(r.item.label, r.labelPositions) as s}{#if s.hit}<b>{s.t}</b>{:else}{s.t}{/if}{/each}</span>
          {#if r.item.detail}<span class="d">{#each segments(r.item.detail, r.detailPositions) as s}{#if s.hit}<b>{s.t}</b>{:else}{s.t}{/if}{/each}</span>{/if}
        </li>
      {:else}
        <li class="none">No matches</li>
      {/each}
    </ul>
    {/if}
  </div>
{/if}
