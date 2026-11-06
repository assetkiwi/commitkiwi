<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { ago, colorFor, initials } from "../lib/format";
  import { highlightLine } from "../lib/highlight";
  import { isImage, langFor } from "../lib/lang";
  import { app, openInEditor, type Tab } from "../lib/state.svelte";
  import type { BlameLine, Blob, Commit, ImageData } from "../lib/types";

  const FIRST = 1500, MORE = 3000, HISTORY_PAGE = 100;
  let { tab, oid, path, start = "file", onjump }: { tab: Tab; oid: string; path: string; /** the mode it opens in (Blame…, File History…) */ start?: "file" | "blame" | "history"; onjump: (oid: string) => void } = $props();
  let mode = $state<"file" | "blame" | "history">("file");

  let blob = $state<Blob | null>(null);
  let image = $state<ImageData | null>(null);
  const lang = $derived(app.diff.syntax ? langFor(path) : null);
  const picture = $derived(isImage(path));
  let blame = $state.raw<BlameLine[] | null>(null);
  let history = $state.raw<Commit[] | null>(null);
  let more = $state(false); // another history page may exist
  let error = $state("");
  let limit = $state(FIRST);

  const fail = (e: unknown) => (error = String(e));
  onMount(() => {
    if (picture) api.image(tab.location, tab.path, oid, path).then((i) => (image = i)).catch(fail);
    else api.blob(tab.location, tab.path, oid, path).then((b) => (blob = b)).catch(fail);
    if (start === "history" || (start === "blame" && !picture)) pick(start);
  });

  function pick(m: typeof mode) {
    mode = m;
    error = "";
    limit = FIRST;
    if (m === "blame" && !blame) api.blame(tab.location, tab.path, oid, path).then((b) => (blame = b)).catch(fail);
    if (m === "history" && !history) loadHistory(0);
  }
  async function loadHistory(skip: number) {
    try {
      const page = await api.fileLog(tab.location, tab.path, oid, path, skip, HISTORY_PAGE);
      history = [...(history ?? []), ...page];
      more = page.length === HISTORY_PAGE;
    } catch (e) { fail(e); }
  }
  const lines = $derived(blob?.text ? blob.text.split("\n").slice(0, blob.text.endsWith("\n") ? -1 : undefined) : []);
  const short = (o: string) => o.slice(0, 8);
</script>

<div class="card hdr fv-head">
  <h1 class="mono path">{path}</h1>
  <button class="btn sm" title="Open the working-tree file in your editor" onclick={() => openInEditor(tab, path)}>Open</button>
  <div class="seg three" role="tablist">
    {#each ["file", "blame", "history"] as const as m}
      <button role="tab" class:on={mode === m} aria-selected={mode === m} onclick={() => pick(m)}>{m === "file" ? "File" : m === "blame" ? "Blame" : "History"}</button>
    {/each}
  </div>
</div>

{#if error}<p class="err" role="alert">{error}</p>{/if}

{#if mode === "file"}
  {#if !blob && !image && !error}<p class="hint">Loading…</p>{/if}
  {#if image}
    <div class="card file"><div class="checker big"><img src={`data:${image.mime};base64,${image.base64}`} alt={path} /></div></div>
    <p class="hint">{image.size.toLocaleString()} bytes</p>
  {:else if blob?.binary}
    <p class="hint">Binary file, {blob.size.toLocaleString()} bytes.</p>
  {:else if blob}
    <div class="card file"><div class="diff mono code">
      {#each lines.slice(0, limit) as l, k}<div class="ln ctx"><span>{k + 1}</span><span>{@html highlightLine(l, lang)}</span></div>{/each}
    </div></div>
    {#if lines.length > limit}<button class="more" onclick={() => (limit += MORE)}>Show {Math.min(MORE, lines.length - limit)} more of {lines.length - limit} lines</button>{/if}
    {#if blob.truncated}<p class="hint">Showing the first 1 MB of {blob.size.toLocaleString()} bytes.</p>{/if}
  {/if}
{:else if mode === "blame"}
  {#if !blame && !error}<p class="hint">Loading…</p>{/if}
  {#if blame}
    <div class="card file"><div class="diff mono code blame">
      {#each blame.slice(0, limit) as l, k}
        {@const first = k === 0 || blame[k - 1].oid !== l.oid}
        <div class="ln ctx" class:grp={first}>
          <span class="bl">{#if first}<button class="link mono" title="Show commit" onclick={() => onjump(l.oid)}>{short(l.oid)}</button><span class="who">{l.author} · {ago(l.time)}</span>{/if}</span>
          <span>{k + 1}</span><span>{@html highlightLine(l.text, lang)}</span>
        </div>
      {/each}
    </div></div>
    {#if blame.length > limit}<button class="more" onclick={() => (limit += MORE)}>Show {Math.min(MORE, blame.length - limit)} more of {blame.length - limit} lines</button>{/if}
  {/if}
{:else}
  {#if !history && !error}<p class="hint">Loading…</p>{/if}
  {#if history}
    <ul class="hist card">
      {#each history as c (c.oid)}
        <li><button onclick={() => onjump(c.oid)}>
          <span class="av" style:background={colorFor(c.email)}>{initials(c.author)}</span>
          <span class="rb"><span class="s">{c.subject}</span><span class="m">{c.author} · {ago(c.time)} · <span class="mono">{short(c.oid)}</span></span></span>
        </button></li>
      {/each}
    </ul>
    {#if more}<button class="more" onclick={() => loadHistory(history!.length)}>Load more</button>{/if}
    {#if !history.length}<p class="hint">No history for this path.</p>{/if}
  {/if}
{/if}
