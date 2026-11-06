<script lang="ts">
  import { app, setDiff } from "../lib/state.svelte";
  const CONTEXTS = [0, 1, 3, 5, 10, 25];
</script>

<div class="dtool" role="toolbar" aria-label="Diff options">
  <div class="seg two" role="tablist">
    <button role="tab" class:on={app.diff.mode === "unified"} aria-selected={app.diff.mode === "unified"} onclick={() => setDiff({ mode: "unified" })}>Unified</button>
    <button role="tab" class:on={app.diff.mode === "split"} aria-selected={app.diff.mode === "split"} onclick={() => setDiff({ mode: "split" })}>Split</button>
  </div>
  <label>Context
    <select value={app.diff.context} onchange={(e) => setDiff({ context: +e.currentTarget.value })}>
      {#each CONTEXTS as c}<option value={c}>{c}</option>{/each}
    </select>
  </label>
  <label><input type="checkbox" checked={app.diff.ignoreWs} onchange={(e) => setDiff({ ignoreWs: e.currentTarget.checked })} /> Ignore whitespace</label>
  <label><input type="checkbox" checked={app.diff.words} onchange={(e) => setDiff({ words: e.currentTarget.checked })} /> Word diff</label>
  <label><input type="checkbox" checked={app.diff.syntax} onchange={(e) => setDiff({ syntax: e.currentTarget.checked })} /> Syntax colors</label>
  <details class="menu editor">
    <summary class="btn sm">Editor…</summary>
    <div class="pop">
      <label>This computer <input value={app.diff.editorLocal} onchange={(e) => setDiff({ editorLocal: e.currentTarget.value })} spellcheck="false" /></label>
      <label>Remote hosts <input value={app.diff.editorRemote} onchange={(e) => setDiff({ editorRemote: e.currentTarget.value })} spellcheck="false" /></label>
      <p class="hint">Command used by “Open”. <code>{"{path}"}</code> and <code>{"{host}"}</code> are filled in; no shell is involved.</p>
    </div>
  </details>
</div>
