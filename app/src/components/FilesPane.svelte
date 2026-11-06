<script lang="ts" module>
  // Full path lists per commit tree (the TREE count and the tree filter); a few, they can be large.
  const lists = new Map<string, Promise<string[]>>();
</script>

<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import { api } from "../lib/api";
  import { loadDetail } from "../lib/commitCache";
  import type { Tab } from "../lib/state.svelte";
  import type { Commit, Detail, Status, WorkFile } from "../lib/types";
  import FileTree from "./FileTree.svelte";
  import { showContextMenu } from "../lib/mainMenu";
  import { FILE, commitFileMenu, workFileMenu } from "../lib/contextMenus";

  const CAP = 1000; // rows per list
  let { tab, mode = $bindable(), filter = false, onfilterclose = () => {}, work, showWork, commit, from, treeOid, current, onworkfile, oncommitfile, onopen }: {
    tab: Tab;
    mode: "changes" | "tree";
    /** the filter box is open (toggle_files_filter) */
    filter?: boolean; onfilterclose?: () => void;
    work: Status | null;
    /** the details pane shows the working copy: Changes lists it instead of a commit's files */
    showWork: boolean;
    commit: Commit | null; from: Commit | null;
    treeOid: string | null;
    /** what the details pane shows: `u:`/`s:`/`c:`/`t:` + path */
    current: string | null;
    onworkfile: (path: string, staged: boolean) => void;
    oncommitfile: (path: string) => void;
    onopen: (path: string) => void;
  } = $props();

  let q = $state("");
  let input = $state<HTMLInputElement>();
  $effect(() => { if (filter) input?.focus(); else q = ""; });
  const match = (p: string) => !q.trim() || p.toLowerCase().includes(q.trim().toLowerCase());
  const closed = new SvelteSet<string>();
  const flip = (k: string) => (closed.has(k) ? closed.delete(k) : closed.add(k));

  // ---- Changes: the working copy by status, or the selected commit's files
  const files = $derived(work?.files ?? []);
  const sections = $derived<[string, string, WorkFile[], boolean][]>([
    ["unmerged", "UNMERGED", files.filter((f) => f.kind === "conflicted"), false],
    ["modified", "MODIFIED", files.filter((f) => f.kind === "changed" && f.worktree !== "."), false],
    ["untracked", "UNTRACKED", files.filter((f) => f.kind === "untracked"), false],
    ["staged", "STAGED", files.filter((f) => f.kind === "changed" && f.index !== "."), true],
  ]);
  let detail = $state.raw<Detail | null>(null);
  let error = $state("");
  $effect(() => {
    if (showWork || mode !== "changes" || !commit) { detail = null; return; }
    let live = true;
    error = "";
    loadDetail(tab, commit.oid, from?.oid ?? null).then((d) => { if (live) detail = d; }).catch((e) => { if (live) error = String(e); });
    return () => { live = false; };
  });

  // ---- Tree: count and filter need every path (fetched once per commit while Tree is shown)
  let all = $state.raw<string[] | null>(null);
  $effect(() => {
    const oid = treeOid;
    all = null;
    if (mode !== "tree" || !oid) return;
    const key = `${tab.id}|${oid}`;
    let p = lists.get(key);
    if (!p) {
      if (lists.size >= 4) lists.delete(lists.keys().next().value!);
      p = api.files(tab.location, tab.path, oid);
      p.catch(() => lists.delete(key));
      lists.set(key, p);
    }
    let live = true;
    p.then((l) => { if (live) all = l; }).catch((e) => { if (live) error = String(e); });
    return () => { live = false; };
  });
  const found = $derived(all && q.trim() ? all.filter(match) : null);
  const treeSel = $derived(current?.startsWith("t:") ? current.slice(2) : null);
  // right-click: the same menus as the details pane's file bands
  const menu = (e: MouseEvent, [defs, vars]: [import("../lib/menu").MenuDef[], Record<string, unknown>]) => showContextMenu(e, defs, vars);
  const treeMenu = (e: MouseEvent, p: string) => showContextMenu(e, FILE, { path: p, commit: treeOid, exists: true, tracked: true });
</script>

{#snippet path(p: string)}
  <span class="t" title={p}>{p}</span>
{/snippet}

<div class="filespane">
  {#if filter}
    <div class="sfilter">
      <input bind:this={input} bind:value={q} placeholder="e.g., main.c" aria-label="Filter files" spellcheck="false" autocomplete="off"
        data-control="text_control filter_input files_filter" />
      <button class="ib" aria-label="Close filter" onclick={onfilterclose}><svg class="i"><use href="#i-x" /></svg></button>
    </div>
  {/if}
  <div class="fbody">
    {#if error}<p class="err pad" role="alert">{error}</p>{/if}
    {#if mode === "changes" && showWork}
      {#if !work}<p class="hint pad">Loading…</p>
      {:else if !files.length}<p class="hint pad">No changes</p>{/if}
      {#each sections as [key, title, list, staged] (key)}
        {@const shown = list.filter((f) => match(f.path))}
        {#if list.length}
          <button class="fsec" aria-expanded={!closed.has(key)} onclick={() => flip(key)}>
            <svg class="i chev" class:open={!closed.has(key)}><use href="#i-chevron" /></svg>{title} ({shown.length})
          </button>
          {#if !closed.has(key)}
            {#each shown.slice(0, CAP) as f (f.path)}
              <button class="fr" class:sel={current === `${staged ? "s" : "u"}:${f.path}`} onclick={() => onworkfile(f.path, staged)} oncontextmenu={(e) => menu(e, workFileMenu(f, staged))}>{@render path(f.path)}</button>
            {/each}
          {/if}
        {/if}
      {/each}
    {:else if mode === "changes"}
      {#if !commit}<p class="hint pad">No commit selected</p>
      {:else if !detail}{#if !error}<p class="hint pad">Loading…</p>{/if}
      {:else}
        {@const shown = detail.files.filter((f) => match(f.path))}
        <button class="fsec" aria-expanded={!closed.has("changes")} onclick={() => flip("changes")}>
          <svg class="i chev" class:open={!closed.has("changes")}><use href="#i-chevron" /></svg>CHANGES ({shown.length})
        </button>
        {#if !closed.has("changes")}
          {#each shown.slice(0, CAP) as f (f.path)}
            <button class="fr" class:sel={current === `c:${f.path}`} onclick={() => oncommitfile(f.path)} oncontextmenu={(e) => menu(e, commitFileMenu(f, commit.oid, from?.oid ?? null, false))}>{@render path(f.path)}</button>
          {/each}
        {/if}
      {/if}
    {:else if treeOid}
      <button class="fsec" aria-expanded={!closed.has("tree")} onclick={() => flip("tree")}>
        <svg class="i chev" class:open={!closed.has("tree")}><use href="#i-chevron" /></svg>TREE ({found ? found.length : all ? all.length : "…"})
      </button>
      {#if !closed.has("tree")}
        {#if found}
          {#each found.slice(0, CAP) as p (p)}<button class="fr" class:sel={treeSel === p} onclick={() => onopen(p)} oncontextmenu={(e) => treeMenu(e, p)}>{@render path(p)}</button>{/each}
          {#if found.length > CAP}<p class="hint pad">+{found.length - CAP} more: refine the filter</p>{/if}
        {:else}
          <FileTree {tab} oid={treeOid} reveal={treeSel} selected={treeSel} {onopen} oncontext={treeMenu} />
        {/if}
      {/if}
    {:else}
      <p class="hint pad">No commits yet.</p>
    {/if}
  </div>
  <div class="seg fmode" role="tablist" aria-label="Files mode">
    <button role="tab" class:on={mode === "changes"} aria-selected={mode === "changes"} onclick={() => (mode = "changes")}>Changes</button>
    <button role="tab" class:on={mode === "tree"} aria-selected={mode === "tree"} onclick={() => (mode = "tree")}>Tree</button>
  </div>
</div>
