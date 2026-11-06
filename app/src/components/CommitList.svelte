<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { api } from "../lib/api";
  import { cacheFor } from "../lib/commitCache";
  import { positionOf, remapParents, visibleRows } from "../lib/collapse";
  import { registerCommand } from "../lib/commands";
  import { tabScope } from "../lib/tabScope";
  import { layoutGraph, rowMaxLane, type GraphLayout } from "../lib/graph";
  import GraphCell from "./GraphCell.svelte";
  import { ago, colorFor, initials, splitTicket } from "../lib/format";
  import { app, type Tab } from "../lib/state.svelte";
  import type { Commit } from "../lib/types";

  const ROW = 56, PAGE = 500, OVERSCAN = 6, MAX_COL = 9;
  let { tab, onselect, onpick = () => {}, oncontext, active = true, target, onconsumed, filter = null }: {
    tab: Tab;
    /** search results: only these rows (ascending real indices) are listed; null lists everything */
    filter?: Int32Array | null;
    /** the commit to show; `from` is the oldest of a multi-selection (the details diff from its parent) */
    onselect: (c: Commit | null, from: Commit | null) => void;
    /** the user chose a row (click or key), as opposed to data arriving */
    onpick?: () => void;
    /** right-click on a row (selected first unless already in the selection): it and the selection, newest first */
    oncontext?: (e: MouseEvent, commit: Commit, selection: Commit[]) => void;
    /** false while another view (the working copy) owns the right pane: no row looks selected */
    active?: boolean;
    /** Ask the list to select and scroll to a row (`n` makes repeated jumps to the same row distinct). */
    target: { index: number; n: number } | null; onconsumed: () => void;
  } = $props();

  const cache = $derived(cacheFor(tab.id));
  // Caches are plain Maps (cheap for 100k+ commits); `version` is bumped whenever they change.
  let version = $state(0);
  let scrollTop = $state(0);
  let height = $state(600);
  let error = $state("");
  let el: HTMLDivElement;
  let layout = $state.raw<GraphLayout | null>(null);
  /** list position -> row in git's order, while collapsed merges hide rows (null: every row is listed) */
  let shown = $state.raw<Int32Array | null>(null);
  // selection, as real rows: `cursor` moves with the keys, `picked` is sorted (newest first)
  let cursor = $state(0);
  let picked = $state.raw<number[]>([0]);
  let anchor = 0;

  const total = $derived(shown ? shown.length : tab.total);
  const realOf = (v: number) => (shown ? shown[v] : v);
  const posOf = (r: number) => (shown ? positionOf(shown, r) : r);
  const isPicked = $derived(new Set(picked));

  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN));
  const count = $derived(Math.ceil(height / ROW) + 2 * OVERSCAN);
  const rows = $derived(Array.from({ length: Math.max(0, Math.min(count, total - first)) }, (_, k) => first + k));

  const commitAt = (i: number, _v: number): Commit | undefined => cache.pages.get(Math.floor(i / PAGE))?.[i % PAGE];
  const filesOf = (oid: string, _v: number): number | undefined => cache.files.get(oid);
  const rowWidth = (v: number) => (layout ? Math.min(rowMaxLane(layout, v), MAX_COL) : 0) * 12 + 36;

  /** Recompute the listed rows and lanes after the graph arrives or a merge is collapsed/expanded. */
  function rebuild() {
    const g = cache.graph;
    if (filter) { shown = filter; layout = g && layoutGraph(remapParents(g.parents, filter)); return; } // lanes between results only
    if (!g) { shown = null; return; }
    shown = visibleRows(g.parents, g.tips, cache.collapsed);
    cache.layout = layout = layoutGraph(shown ? remapParents(g.parents, shown) : g.parents);
  }

  onMount(() => {
    cursor = Math.min(cache.sel, Math.max(0, tab.total - 1));
    picked = cache.multi.filter((r) => r < tab.total);
    if (!picked.length) picked = [cursor];
    anchor = cursor;
    el.scrollTop = cache.scrollTop; // coming back to a tab keeps its place
    if (cache.graph) {
      if (cache.collapsed.size) rebuild();
      else layout = cache.layout;
    } else {
      // Lanes need every commit's parents, fetched once (a few hundred KB even for 100k commits).
      api.graph(tab.location, tab.path, tab.hidden).then((g) => {
        cache.graph = g;
        // Preferences → Diff → Expand merge commits by default (setting expand_merge_commits_by_default)
        if (!app.prefs.expand_merge_commits_by_default) g.parents.forEach((ps, i) => { if (ps.length > 1) cache.collapsed.add(i); });
        rebuild();
      }).catch(() => {});
    }
  });

  // entering search keeps a selected result (else picks the first); leaving restores the scroll position,
  // or centres the selection when the user picked another commit while searching
  let before: { top: number; sel: number } | null = null;
  const centre = () => { el.scrollTop = Math.max(0, posOf(cursor) * ROW - height / 2 + ROW / 2); };
  $effect(() => {
    const f = filter;
    untrack(() => {
      if (!f && !before) return;
      before ??= { top: el.scrollTop, sel: cursor };
      rebuild();
      const keep = picked.filter((r) => posOf(r) >= 0);
      if (keep.length) { picked = keep; if (posOf(cursor) < 0) cursor = keep[0]; cache.sel = cursor; cache.multi = picked; }
      else if (f?.length) select(f[0]);
      const back = f ? null : before;
      before = back ? null : before;
      // after the list's height follows the new row count, or the browser clamps the scroll
      void tick().then(() => { if (back && cursor === back.sel) el.scrollTop = back.top; else centre(); });
    });
  });

  function scrollToPos(p: number) {
    const top = p * ROW, bottom = top + ROW + 8;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }
  function select(r: number, how: "one" | "toggle" | "range" = "one") {
    if (how === "range") {
      const [a, b] = [posOf(anchor), posOf(r)].sort((x, y) => x - y);
      picked = a < 0 ? [r] : Array.from({ length: b - a + 1 }, (_, k) => realOf(a + k));
    } else if (how === "toggle") {
      picked = isPicked.has(r) && picked.length > 1 ? picked.filter((x) => x !== r) : [...picked, r].sort((x, y) => x - y);
      anchor = r;
    } else {
      picked = [r];
      anchor = r;
    }
    cursor = r;
    cache.sel = r;
    cache.multi = picked;
  }

  $effect(() => {
    const t = target;
    if (!t || t.index >= tab.total) return;
    if (shown && posOf(t.index) < 0) { cache.collapsed.clear(); rebuild(); } // jumping into a collapsed merge opens them all
    select(t.index);
    el.scrollTop = Math.max(0, posOf(t.index) * ROW - height / 2 + ROW / 2);
    onconsumed();
  });

  async function loadPage(p: number) {
    if (cache.pages.has(p) || cache.loading.has(p)) return;
    cache.loading.add(p);
    try {
      cache.pages.set(p, await api.log(tab.location, tab.path, p * PAGE, PAGE, tab.hidden));
      error = "";
      version++;
    } catch (e) {
      error = String(e);
    } finally {
      cache.loading.delete(p);
    }
  }

  $effect(() => {
    if (!total) return;
    const pages = new Set<number>();
    for (let v = first; v < Math.min(first + count, total); v++) pages.add(Math.floor(realOf(v) / PAGE));
    pages.forEach(loadPage);
  });

  // File counts are slow in git (a diff per commit), so only ask for rows on screen, after scrolling settles.
  async function fetchStats() {
    const want: string[] = [];
    for (let v = first; v < Math.min(first + count, total) && want.length < 200; v++) {
      const c = commitAt(realOf(v), 0);
      if (c && !cache.asked.has(c.oid)) want.push(c.oid);
    }
    if (!want.length) return;
    want.forEach((o) => cache.asked.add(o));
    try {
      for (const [oid, n] of await api.stats(tab.location, tab.path, want)) cache.files.set(oid, n);
      version++;
    } catch {
      want.forEach((o) => cache.asked.delete(o)); // retry on next scroll
    }
  }
  $effect(() => {
    void [version, first, count]; // re-arm on scroll and when new pages land
    const t = setTimeout(fetchStats, 120);
    return () => clearTimeout(t);
  });

  $effect(() => {
    const top = commitAt(picked[0], version) ?? null;
    if (picked.length < 2) { onselect(top, null); return; }
    const from = commitAt(picked[picked.length - 1], version);
    if (top && from) onselect(top, from);
  });

  function pick(r: number, e?: MouseEvent | KeyboardEvent) {
    onpick();
    const how = e?.shiftKey ? "range" : e && (e.metaKey || e.ctrlKey) && e instanceof MouseEvent ? "toggle" : "one";
    select(r, how);
    scrollToPos(posOf(r));
  }

  async function context(e: MouseEvent, r: number) {
    e.preventDefault();
    if (!isPicked.has(r)) pick(r);
    const rows = picked;
    // a long shift-selection may reach pages that never scrolled into view
    await Promise.all([...new Set(rows.map((x) => Math.floor(x / PAGE)))].map(loadPage));
    const all = rows.map((x) => commitAt(x, version));
    const c = commitAt(r, version);
    if (c && all.every(Boolean)) oncontext?.(e, c, all as Commit[]);
  }
  function onkeydown(e: KeyboardEvent) {
    const page = Math.max(1, Math.floor(height / ROW) - 1);
    const at = Math.max(0, posOf(cursor));
    const to: Record<string, number> = {
      ArrowDown: at + 1, ArrowUp: at - 1, PageDown: at + page, PageUp: at - page, Home: 0, End: total - 1,
    };
    if (!(e.key in to) || !total) return;
    e.preventDefault();
    pick(realOf(Math.max(0, Math.min(total - 1, to[e.key]))), e);
  }

  /** Left/Right on a merge: hide/show the commits it merged in, keeping the row where it is on screen. */
  function setCollapsed(on: boolean) {
    const c = commitAt(cursor, version);
    if (!c || c.parents.length < 2 || !cache.graph || cache.collapsed.has(cursor) === on) return;
    const offset = posOf(cursor) * ROW - el.scrollTop;
    if (on) cache.collapsed.add(cursor); else cache.collapsed.delete(cursor);
    rebuild();
    picked = picked.filter((r) => posOf(r) >= 0);
    if (!picked.length) picked = [cursor];
    cache.multi = picked;
    el.scrollTop = posOf(cursor) * ROW - offset;
  }
  const scope = tabScope();
  $effect(() => {
    if (!scope.active()) return;
    const offs = [
      registerCommand("collapse_merge", { run: () => setCollapsed(true) }),
      registerCommand("expand_merge", { run: () => setCollapsed(false) }),
    ];
    return () => offs.forEach((off) => off());
  });
</script>

<div
  class="list"
  bind:this={el}
  bind:clientHeight={height}
  onscroll={() => { scrollTop = el.scrollTop; cache.scrollTop = scrollTop; }}
  {onkeydown}
  tabindex="0"
  data-control="commit_table"
  role="listbox"
  aria-label="Commits"
  aria-multiselectable="true"
  aria-activedescendant={`row-${cursor}`}
>
  {#if !tab.total}<p class="hint pad">No commits yet.</p>{/if}
  {#if error}<p class="err pad" role="alert">{error}</p>{/if}
  <div style:height="{total * ROW + 8}px"></div>
  {#each rows as v (v)}
    {@const i = realOf(v)}
    {@const c = commitAt(i, version)}
    {@const w = rowWidth(v)}
    {@const sel = active && isPicked.has(i)}
    <div id="row-{i}" class="row" class:sel class:multi={sel && picked.length > 1} style:top="{v * ROW + 4}px" style:padding-left="{w}px" role="option" aria-selected={sel} tabindex="-1" onclick={(e) => pick(i, e)} oncontextmenu={(e) => context(e, i)} onkeydown={() => {}}>
      <GraphCell {layout} i={v} h={ROW} {w} merge={!!c && c.parents.length > 1} collapsed={!!layout && cache.collapsed.has(i)} /><!-- `layout` is replaced on every collapse, so this re-evaluates -->
      {#if c}
        {@const [ticket, rest] = splitTicket(c.subject)}
        {@const n = filesOf(c.oid, version)}
        {@const labels = [...c.labels].sort((a, b) => Number(b.head) - Number(a.head))}
        <span class="av" style:background={colorFor(c.email)}>{initials(c.author)}</span>
        <div class="rb">
          <div class="s" class:headc={c.oid === tab.info.oid}>{#if ticket}<span class="tk">{ticket}</span>{/if}{rest}</div>
          <div class="m">
            {#if labels.length}
              <span class="ref" class:head={labels[0].head} class:remote={labels[0].kind === "remote"} style:--lc="var(--lane{layout ? layout.nodeColor[v] : 0})">{labels[0].name}</span>
              {#if labels.length > 1}<span class="refmore" title={labels.slice(1).map((l) => l.name).join("\n")}>⑂ +{labels.length - 1}</span>{/if}
            {:else}<span class="au">{c.author}</span><span>·</span><span>{ago(c.time)}</span>{/if}
          </div>
        </div>
        {#if n !== undefined}<span class="cnt" title="Changed files">{n}</span>{/if}
      {:else}
        <span class="av sk"></span>
        <div class="rb"><div class="sk-line" style="width:70%"></div><div class="sk-line" style="width:40%"></div></div>
      {/if}
    </div>
  {/each}
</div>
