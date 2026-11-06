<script lang="ts">
  import { complete, parseSearch, suggest, type Keyword } from "../lib/search";
  import { registerCommand, runCommand } from "../lib/commands";
  import { tabScope } from "../lib/tabScope";
  import { api } from "../lib/api";
  import { interpretSearch, llm } from "../lib/llm.svelte";
  import { queryTokens } from "../lib/nlSearch";
  import { app, setPreference, type Tab } from "../lib/state.svelte";

  let { value = $bindable(), info, error = false, onstep, onclose, focusKey, tab }: {
    value: string;
    /** "12 results", an error, … */
    info: string;
    error?: boolean;
    /** Enter / Shift+Enter: next / previous result */
    onstep: (dir: 1 | -1) => void;
    onclose: () => void;
    /** changes whenever the bar should take focus (open, toggle_search while open) */
    focusKey: number;
    /** natural-language mode reads hints (authors, paths, branches) from it */
    tab: Tab;
  } = $props();

  let input = $state<HTMLInputElement>();
  let caret = $state(0);
  let index = $state(0);
  let dismissed = $state(false);
  // natural-language mode (the ✨ toggle): a sentence; the model's query shows for review and runs only on Run
  const available = $derived(llm.models.some((m) => m.installed));
  const natural = $derived(app.prefs.natural_search && available);
  let sentence = $state("");
  let busy = $state(false);
  let nlError = $state("");
  let preview = $state<{ query: string; warnings: string[]; for: string } | null>(null);
  let nlSeq = 0;
  const chips = $derived(preview ? queryTokens(parseSearch(preview.query)) : []);

  const items = $derived(dismissed || natural ? [] : suggest(value, caret));
  $effect(() => { void focusKey; void natural; queueMicrotask(() => input?.focus()); });
  $effect(() => { void items.length; index = 0; });
  // Escape closes the list first (a key binding: hide_auto_complete), then the search; in natural mode it cancels the
  // model's run or closes the preview first, the same way
  const scope = tabScope();
  $effect(() => { scope.modes.auto_complete_visible = items.length > 0 || (natural && (busy || !!preview)); return () => { scope.modes.auto_complete_visible = false; }; });
  $effect(() => {
    if (scope.active()) return registerCommand("hide_auto_complete", { run: () => { if (!natural) dismissed = true; else if (busy) cancel(); else preview = null; } });
  });
  $effect(() => () => { if (busy) void api.llmStop(); }); // closing the bar stops the model

  const sync = () => { caret = input?.selectionStart ?? value.length; };
  function insert(kw: Keyword) {
    const r = complete(value, caret, kw);
    value = r.value;
    queueMicrotask(() => { input?.setSelectionRange(r.caret, r.caret); sync(); });
  }
  function onkeydown(e: KeyboardEvent) {
    const n = items.length;
    if (n && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      index = (index + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
    } else if (n && (e.key === "Tab" || e.key === "Enter")) {
      e.preventDefault();
      insert(items[index]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      onstep(e.shiftKey ? -1 : 1);
    }
  }

  async function interpret() {
    const text = sentence.trim();
    if (!text || busy) return;
    const n = ++nlSeq;
    busy = true;
    nlError = "";
    try {
      const r = await interpretSearch(tab, text);
      if (n === nlSeq) preview = { ...r, for: text };
    } catch (e) {
      if (n === nlSeq) nlError = String(e instanceof Error ? e.message : e).split("\n")[0];
    } finally {
      if (n === nlSeq) busy = false;
    }
  }
  function cancel() {
    nlSeq++;
    busy = false;
    void api.llmStop();
  }
  const run = () => { if (preview?.query.trim()) value = preview.query; };
  function editAsKeywords() {
    if (!preview) return;
    value = preview.query;
    preview = null;
    setPreference("natural_search", false);
  }
  function onNaturalKey(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (preview && preview.for === sentence.trim()) run(); // Enter again runs what is shown
    else void interpret();
  }
</script>

<div class="searchbar">
  <svg class="i"><use href="#i-search" /></svg>
  {#if natural}
    <input bind:this={input} bind:value={sentence} data-control="search_input" placeholder="Describe the commits: by Alex touching the login form last month"
      onkeydown={onNaturalKey} oninput={() => (nlError = "")} aria-label="Describe what you are looking for" autocomplete="off" spellcheck="false" />
  {:else}
    <input bind:this={input} bind:value data-control="search_input" placeholder="Search commits: text, or file: from: after: before: message: author: commit: contents:"
      oninput={() => { dismissed = false; sync(); }} onkeyup={sync} onclick={sync} {onkeydown} onblur={() => (dismissed = true)} onfocus={() => (dismissed = false)}
      role="combobox" aria-expanded={items.length > 0} aria-controls="search-ac" aria-label="Search commits" autocomplete="off" spellcheck="false" />
  {/if}
  {#if natural && busy}<span class="info" role="status">Interpreting…</span>
  {:else if natural && nlError}<span class="info err" role="alert" title={nlError}>{nlError}</span>
  {:else if info}<span class="info" class:err={error} role="status">{info}</span>{/if}
  <button class="ib nl-toggle" class:on={natural} class:off={!available} aria-pressed={natural} aria-disabled={!available} aria-label="Natural language search"
    title={available ? "Describe what you are looking for" : "Needs the commit message model: Preferences > Git"}
    onclick={() => runCommand("toggle_natural_search")}>✨</button>
  <button class="ib" title="Close Search" aria-label="Close search" onclick={onclose}><svg class="i"><use href="#i-x" /></svg></button>
  {#if items.length}
    <ul id="search-ac" class="ac" role="listbox">
      {#each items as k, i (k.name)}
        <li role="option" aria-selected={i === index} class:on={i === index} onmousemove={() => (index = i)} onmousedown={(e) => { e.preventDefault(); insert(k); }}>
          <span class="kw">{k.name}:</span><span class="d">{k.desc}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>
{#if natural && preview}
  <div class="nl-preview" role="group" aria-label="Interpreted search">
    <div class="nl-line">
      <input class="q" bind:value={preview.query} data-control="search_preview" aria-label="Keyword query" spellcheck="false" autocomplete="off"
        onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); run(); } }} />
      <button class="btn sm" onclick={run}>Run</button>
      <button class="btn sm" onclick={editAsKeywords}>Edit as Keywords</button>
    </div>
    {#if chips.length}<ul class="chips" aria-label="Search terms">{#each chips as c, i (i)}<li>{c}</li>{/each}</ul>{/if}
    {#if preview.warnings.length}<p class="warn" role="status">{preview.warnings.join(" ")}</p>{/if}
  </div>
{/if}

<style>
  .searchbar { position: relative; flex: none; display: flex; align-items: center; gap: 8px; padding: 4px 10px 4px 14px; border-bottom: 1px solid var(--border); background: var(--surface); }
  .searchbar > .i { color: var(--muted); flex: none; }
  input { flex: 1; min-width: 0; height: 28px; border: 0; outline: 0; background: none; color: var(--text); font-size: 13px; font-family: var(--font-mono); }
  .info { flex: none; color: var(--muted); font-size: 12px; white-space: nowrap; }
  .info.err { color: var(--danger); white-space: normal; max-width: 50%; }
  .nl-toggle { font-size: 13px; line-height: 1; filter: grayscale(1); opacity: 0.7; }
  .nl-toggle.on { filter: none; opacity: 1; box-shadow: inset 0 0 0 1px var(--sel-ring); background: var(--sel); }
  .nl-toggle.off { opacity: 0.35; cursor: default; }
  .ac { position: absolute; z-index: 30; top: 100%; left: 36px; min-width: 320px; margin: 2px 0 0; padding: 4px; list-style: none; border-radius: 8px;
    background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow); }
  .ac li { display: flex; gap: 14px; align-items: baseline; padding: 5px 10px; border-radius: 6px; cursor: default; }
  .ac li.on { background: var(--sel); box-shadow: inset 0 0 0 1px var(--sel-ring); }
  .kw { font-family: var(--font-mono); color: var(--accent-text); min-width: 72px; }
  .d { color: var(--muted); font-size: 12px; }
  .nl-preview { flex: none; padding: 4px 10px 6px 36px; border-bottom: 1px solid var(--border); background: var(--surface); }
  .nl-preview .nl-line { display: flex; align-items: center; gap: 8px; }
  .nl-preview .q { height: 24px; padding: 0 6px; border-radius: 6px; background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--border); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 0; padding: 0; list-style: none; }
  .chips li { padding: 1px 6px; border-radius: 4px; background: var(--surface-2); color: var(--accent-text); font-family: var(--font-mono); font-size: 11px; }
  .warn { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
</style>
