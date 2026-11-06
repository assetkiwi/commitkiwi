<script lang="ts">
  // The diff widget shared by commit diffs and working-copy diffs: side-by-side (or unified) rows, a context
  // band above every hunk ("Show entire file" toggle on the left, the caller's hunk buttons on the right),
  // gutter line selection, whole-file highlighting, and the binary/image cases.
  import type { Snippet } from "svelte";
  import type { SvelteSet } from "svelte/reactivity";
  import { api } from "../lib/api";
  import { binarySummary, fileLines, fullRows, rangePick, splitRows, type DiffRow } from "../lib/diff";
  import { isImage, langFor } from "../lib/lang";
  import { makeRenderer } from "../lib/render";
  import { app, type Tab } from "../lib/state.svelte";
  import type { Blob, FileRev } from "../lib/types";
  import { DIFF_FIRST, DIFF_MORE, diffQueue } from "../lib/lazy";
  import ImageDiff from "./ImageDiff.svelte";

  // render in chunks so a 100k-line diff never freezes the UI
  let { tab, path, rows, binary, before, after, picked = null, band, below, full = $bindable(false), limit = $bindable(DIFF_FIRST), sides = $bindable(undefined) }: {
    tab: Tab; path: string; rows: DiffRow[]; binary: boolean;
    /** the file versions on each side; null = the side does not exist (added / deleted) */
    before: FileRev | null; after: FileRev | null;
    /** selected change rows (indexes into `rows`); null = no line selection */
    picked?: SvelteSet<number> | null;
    /** buttons at the right of a hunk's band (the hunk's row index) */
    band?: Snippet<[number]>;
    /** rendered under a hunk's band (e.g. its history) */
    below?: Snippet<[number]>;
    /** kept by the caller so a body that scrolls far away and back loses nothing: "Show entire file", how many
     *  rows are shown, and the file contents (undefined = not read yet; the caller resets it when rows reload) */
    full?: boolean; limit?: number;
    sides?: { old: string | null; new: string | null };
  } = $props();

  const lang = $derived(langFor(path));
  // whole-file highlighting: only while this body is mounted (released with it)
  let hl = $state.raw<{ old: string[] | null; new: string[] | null } | null>(null);
  let sizes = $state.raw<[number | null, number | null] | null>(null);

  const read = (s: FileRev | null, live: () => boolean): Promise<Blob | null> =>
    s ? ((loc, repo) => diffQueue(() => api.readFile(loc, repo, s.rev, s.path), live))(tab.location, tab.path).catch(() => null) : Promise.resolve(null);
  const usable = (b: Blob | null) => (b && !b.binary && !b.truncated ? b.text ?? "" : null);

  // contents back the full-file view and whole-file highlighting; the caller clears them when the diff reloads
  $effect(() => {
    const [r, b, a, bin] = [rows, before, after, binary];
    let live = true;
    const alive = () => live;
    if (bin) {
      if (!isImage(path)) Promise.all([read(b, alive), read(a, alive)]).then(([x, y]) => { if (live) sizes = [x?.size ?? null, y?.size ?? null]; });
      return () => { live = false; };
    }
    if (!r.length || sides !== undefined) return;
    Promise.all([read(b, alive), read(a, alive)]).then(([x, y]) => {
      if (live) sides = { old: b ? usable(x) : "", new: a ? usable(y) : "" };
    });
    return () => { live = false; };
  });
  $effect(() => {
    const [s, syn, l] = [sides, app.diff.syntax, lang];
    hl = null;
    if (!s || !syn) return;
    let live = true;
    import("../lib/syntax").then(({ highlightFile }) => Promise.all([s.old ? highlightFile(s.old, l) : null, s.new ? highlightFile(s.new, l) : null]))
      .then(([ho, hn]) => { if (live) hl = { old: ho, new: hn }; });
    return () => { live = false; };
  });

  // both sides known (or legitimately empty): the gaps can be filled from them
  const canFull = $derived(!!sides && sides.old !== null && sides.new !== null);
  const view = $derived(full && canFull
    ? fullRows(rows, before ? fileLines(sides!.old!) : null, after ? fileLines(sides!.new!) : null)
    : { rows, src: rows.map((_, i) => i) as (number | null)[] });
  const html = $derived(makeRenderer(view.rows, lang, { syntax: app.diff.syntax, words: app.diff.words }, hl));
  const split = $derived(app.diff.mode === "split" ? splitRows(view.rows) : []);
  const total = $derived(app.diff.mode === "split" ? split.length : view.rows.length);

  // ---- gutter selection: click picks a line, shift-click / drag a range, cmd/ctrl-click toggles one
  let anchor: number | null = null;
  let dragSide: "del" | "add" | null = null;
  let dragging = false;
  // split view: text selection must stay inside the half the drag started in
  let selSide = $state<number | null>(null);
  function pickSide(e: MouseEvent) {
    const h = (e.target as Element).closest?.(".half");
    if (h?.parentElement) selSide = [...h.parentElement.children].indexOf(h);
  }
  const isChange = (i: number | null): i is number => i !== null && (rows[i]?.kind === "add" || rows[i]?.kind === "del");
  function pickRange(to: number) {
    if (!picked || anchor === null) return;
    picked.clear();
    for (const i of rangePick(rows, anchor, to, dragSide)) picked.add(i);
  }
  function down(e: MouseEvent, vi: number, side: "del" | "add" | null) {
    if (!picked || e.button !== 0) return;
    e.preventDefault(); // no text selection while picking lines
    const i = view.src[vi];
    if (!isChange(i)) { picked.clear(); anchor = null; return; }
    if (e.shiftKey && anchor !== null) { pickRange(i); return; }
    if (e.metaKey || e.ctrlKey) {
      if (picked.has(i)) picked.delete(i); else picked.add(i);
    } else if (picked.size === 1 && picked.has(i)) picked.clear();
    else { picked.clear(); picked.add(i); }
    anchor = i;
    dragSide = side;
    dragging = true;
  }
  function enter(vi: number) {
    const i = view.src[vi];
    if (dragging && isChange(i)) pickRange(i);
  }
  const sel = (vi: number | null) => vi !== null && !!picked && isChange(view.src[vi]) && picked.has(view.src[vi]!);

  const mark = { add: "+", del: "-", ctx: " ", hunk: "", meta: "" };
</script>

<svelte:window onmouseup={() => (dragging = false)} />

{#snippet bandRow(vi: number, cls: string)}
  {@const h = view.src[vi]!}
  <div class="{cls} cband" title={rows[h].text}>
    <button class="ib full" class:on={full} title="Show entire file" aria-label="Show entire file" aria-pressed={full}
      disabled={!canFull} onclick={() => (full = !full)}><svg class="i"><use href="#i-unfold" /></svg></button>
    <span class="acts">{@render band?.(h)}</span>
  </div>
  {@render below?.(h)}
{/snippet}

{#if binary && isImage(path)}
  <ImageDiff {tab} {before} {after} />
{:else if binary}
  <p class="hint pad">{sizes ? binarySummary(before ? sizes[0] : null, after ? sizes[1] : null) : "Binary file"}</p>
{:else if app.diff.mode === "unified"}
  <div class="diff mono" class:wrap={app.diff.wrap} class:selectable={!!picked}>
    {#each view.rows.slice(0, limit) as r, vi}
      {#if r.kind === "hunk"}
        {@render bandRow(vi, "ln hunk")}
      {:else}
        <div class="ln {r.kind}" class:picked={sel(vi)}>
          <span role="presentation" onmousedown={(e) => down(e, vi, null)} onmouseenter={() => enter(vi)}>{r.old ?? ""}</span>
          <span role="presentation" onmousedown={(e) => down(e, vi, null)} onmouseenter={() => enter(vi)}>{r.new ?? ""}</span>
          <span><i class="mk" data-m={mark[r.kind]}></i>{@html html(vi)}</span>
        </div>
      {/if}
    {/each}
  </div>
{:else}
  <div class="diff mono splitv" class:selectable={!!picked} class:sel-l={selSide === 0} class:sel-r={selSide === 1} role="presentation" onmousedown={pickSide}>
    {#each split.slice(0, limit) as s}
      {#if "hunk" in s}
        {@render bandRow(s.hunk, "sp hunk")}
      {:else}
        <div class="sp">
          {#each [s.left, s.right] as idx, side}
            {#if idx === null}<div class="half empty"><span class="n"></span><span class="t"></span></div>
            {:else}
              {@const r = view.rows[idx]}
              {@const which = side === 0 ? "del" : "add"}
              <div class="half {r.kind}" class:picked={sel(idx) && (r.kind === which)}>
                <span class="n" role="presentation" onmousedown={(e) => down(e, idx, which)} onmouseenter={() => enter(idx)} data-n={side === 0 ? r.old ?? "" : r.new ?? ""}></span>
                <span class="t"><i class="mk" data-m={mark[r.kind]}></i>{@html html(idx)}</span>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    {/each}
  </div>
{/if}
{#if !binary && total > limit}
  <button class="more" onclick={() => (limit += DIFF_MORE)}>Show {Math.min(DIFF_MORE, total - limit)} more of {total - limit} lines</button>
{/if}
