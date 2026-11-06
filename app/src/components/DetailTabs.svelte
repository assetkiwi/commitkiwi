<script lang="ts">
  // The details pane's tab strip: Summary, then one closable tab per changed file.
  let { tabs, active, onpick, onclose }: {
    tabs: { key: string; label: string; title: string; badge: string }[];
    /** key of the open file tab; null = Summary */
    active: string | null;
    onpick: (key: string | null) => void;
    onclose: (key: string) => void;
  } = $props();

  let strip = $state<HTMLDivElement>();
  $effect(() => { void active; strip?.querySelector(".dt.on")?.scrollIntoView({ block: "nearest", inline: "nearest" }); });
</script>

<div class="dtabs" role="tablist" aria-label="Details" bind:this={strip}>
  <div class="dt" class:on={active === null}>
    <button role="tab" aria-selected={active === null} onclick={() => onpick(null)}>Summary</button>
  </div>
  {#each tabs as t (t.key)}
    <div class="dt" class:on={active === t.key} title={t.title}>
      <button role="tab" aria-selected={active === t.key} onclick={() => onpick(t.key)}><span class="st st-{t.badge}">{t.badge}</span>{t.label}</button>
      <button class="x" aria-label="Close {t.title}" onclick={() => onclose(t.key)}><svg class="i"><use href="#i-x" /></svg></button>
    </div>
  {/each}
</div>
