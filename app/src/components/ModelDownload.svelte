<script lang="ts">
  // Progress of the commit message model download: a small pill at the bottom, with Cancel. Resumes where it stopped.
  import { api } from "../lib/api";
  import { llm, sizeLabel } from "../lib/llm.svelte";
  const pct = $derived(llm.progress ? Math.min(100, Math.floor((llm.progress.done / Math.max(1, llm.progress.total)) * 100)) : 0);
</script>

{#if llm.progress}
  <div class="dl" role="status" aria-live="polite" data-testid="model-download">
    <span class="t">Downloading {llm.progress.name}</span>
    <span class="bar" role="progressbar" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100"><i style:width="{pct}%"></i></span>
    <span class="n">{pct}% · {sizeLabel(llm.progress.done)} of {sizeLabel(llm.progress.total)}</span>
    <button type="button" class="link" onclick={() => void api.llmCancel()}>Cancel</button>
  </div>
{/if}

<style>
  .dl { position: fixed; left: 12px; bottom: 12px; z-index: 40; display: flex; align-items: center; gap: 10px; padding: 7px 12px;
    background: var(--panel, #2b2b2b); border: 1px solid var(--border, #444); border-radius: 6px; font-size: 12px; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35); }
  .t { font-weight: 600; }
  .bar { width: 140px; height: 6px; background: var(--border, #444); border-radius: 3px; overflow: hidden; display: inline-block; }
  .bar i { display: block; height: 100%; background: var(--accent, #6ea8fe); }
  .n { opacity: 0.75; font-variant-numeric: tabular-nums; }
</style>
