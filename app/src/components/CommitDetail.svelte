<script lang="ts">
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { copy } from "../lib/clipboard";
  import { loadDetail } from "../lib/commitCache";
  import { colorFor, fullDate, initials } from "../lib/format";
  import type { Tab } from "../lib/state.svelte";
  import { showContextMenu } from "../lib/mainMenu";
  import { COMMIT_SUMMARY, commitFileMenu } from "../lib/contextMenus";
  import type { Commit, Detail, FileChange } from "../lib/types";
  import DiffView from "./DiffView.svelte";
  import DiffToolbar from "./DiffToolbar.svelte";
  import DetailTabs from "./DetailTabs.svelte";

  const AUTO_FILES = 10, AUTO_LINES = 2000, FILE_PAGE = 300;
  let { tab, commit: live, from: liveFrom = null, focus = $bindable(null), stash = null, onjump, editing = false, onsavemessage, oncancelmessage }: {
    tab: Tab; commit: Commit;
    /** oldest commit of a multi-selection: show the combined change since its parent */
    from?: Commit | null;
    /** the open file tab (also picked in the Files column); null = Summary */
    focus?: string | null;
    /** a stash is shown (its name) instead of a commit from the graph */
    stash?: string | null;
    onjump: (oid: string) => void;
    /** Edit Commit Message: the message becomes an editor (⌘↩ / ctrl+↩ saves, Esc cancels) */
    editing?: boolean;
    onsavemessage?: (message: string) => Promise<void>;
    oncancelmessage?: () => void;
  } = $props();
  let draft = $state("");
  let saving = $state(false);
  let editor = $state<HTMLTextAreaElement>();
  $effect(() => { if (editing && detail) { draft = message; queueMicrotask(() => editor?.focus()); } });
  async function saveMsg() {
    if (!draft.trim() || saving) return;
    saving = true;
    try { await onsavemessage?.(draft); } finally { saving = false; }
  }
  function msgKey(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveMsg(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); oncancelmessage?.(); }
  }

  // What is on screen: a commit with its detail, moved together when the next one has loaded. Until then the
  // previous one stays (dimmed after a moment), so arrowing through history does not blank the pane.
  let shown = $state.raw<{ commit: Commit; from: Commit | null }>({ commit: untrack(() => live), from: untrack(() => liveFrom) });
  const commit = $derived(shown.commit), from = $derived(shown.from);
  let waiting = $state(false);
  let detail = $state<Detail | null>(null);
  let error = $state("");
  let showFiles = $state(FILE_PAGE);
  let copied = $state("");
  const open = new SvelteSet<string>();
  const closed = new SvelteSet<string>();

  const totals = $derived(detail ? detail.files.reduce((t, f) => [t[0] + (f.adds ?? 0), t[1] + (f.dels ?? 0)], [0, 0]) : [0, 0]);
  // a file picked again (Files column) gets its tab back
  $effect(() => { if (focus) closed.delete(focus); });
  const fileTabs = $derived((detail?.files ?? []).filter((f) => !closed.has(f.path)).slice(0, FILE_PAGE)
    .map((f) => ({ key: f.path, label: base(f.path), title: f.path, badge: f.status })));
  const focused = $derived(focus === null ? null : detail?.files.find((f) => f.path === focus) ?? null);

  // Small commits start expanded; big ones stay collapsed until you click a file.
  function autoOpen(d: Detail) {
    open.clear();
    const lines = d.files.reduce((n, f) => n + (f.adds ?? 0) + (f.dels ?? 0), 0);
    if (d.files.length <= AUTO_FILES && lines <= AUTO_LINES) d.files.forEach((f) => open.add(f.path));
  }

  $effect(() => {
    const [next, nextFrom] = [live, liveFrom];
    const [oid, base] = [next.oid, nextFrom?.oid ?? null];
    error = "";
    let current = true;
    const slow = setTimeout(() => { if (current) waiting = true; }, 150); // a cached commit never shows it
    loadDetail(tab, oid, base).then((d) => {
      if (!current) return;
      shown = { commit: next, from: nextFrom };
      showFiles = FILE_PAGE;
      closed.clear();
      detail = d;
      autoOpen(d);
    }).catch((e) => { if (current) error = String(e); }).finally(() => { if (current) { clearTimeout(slow); waiting = false; } });
    return () => { current = false; clearTimeout(slow); };
  });

  async function doCopy(what: string, text: string) {
    if (await copy(text)) { copied = what; setTimeout(() => (copied = ""), 1200); }
  }
  const toggle = (p: string) => (open.has(p) ? open.delete(p) : open.add(p));
  const anyOpen = $derived(open.size > 0);
  function toggleAll() {
    if (anyOpen) open.clear();
    else detail?.files.slice(0, showFiles).forEach((f) => open.add(f.path));
  }
  function closeTab(key: string) { closed.add(key); if (focus === key) focus = null; }
  const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
  const base = (p: string) => p.slice(dir(p).length);
  const message = $derived(detail?.body ? `${detail.subject}\n\n${detail.body}` : (detail?.subject ?? commit.subject));
  const branches = $derived(commit.labels.filter((l) => l.kind !== "tag"));
  const tags = $derived(commit.labels.filter((l) => l.kind === "tag"));

  const commitMenu = (e: MouseEvent) => showContextMenu(e.currentTarget as HTMLElement, COMMIT_SUMMARY, { commit: commit.oid, message, tree: detail?.tree });
  /** the file band's `…` (or a right-click on the band): the file + commit file menus */
  function fileMenu(e: MouseEvent, f: FileChange) {
    const [defs, vars] = commitFileMenu(f, commit.oid, from?.oid ?? null, !!stash);
    showContextMenu(e.type === "contextmenu" ? e : (e.currentTarget as HTMLElement), defs, vars);
  }
</script>

{#snippet block(f: FileChange, single: boolean)}
  {@const shown = single || open.has(f.path)}
  <div class="card file">
    <h3 class="band" oncontextmenu={(e) => fileMenu(e, f)}>
      {#snippet name()}
        <span class="st st-{f.status}" title={f.status}>{f.status}</span>
        <span class="path"><span class="dir">{f.old_path ? `${f.old_path} → ` : ""}{dir(f.path)}</span>{base(f.path)}</span>
      {/snippet}
      {#if single}<span class="fh">{@render name()}</span>
      {:else}<button class="fh" aria-expanded={shown} onclick={() => toggle(f.path)}><svg class="i chev" class:open={shown}><use href="#i-chevron" /></svg>{@render name()}</button>{/if}
      {#if f.adds === null}<span class="sub">binary</span>{:else}<span class="pill-n del">−{f.dels}</span><span class="pill-n add">+{f.adds}</span>{/if}
      <button class="ib" aria-label="File actions for {f.path}" title="File actions" onclick={(e) => fileMenu(e, f)}><svg class="i"><use href="#i-dots" /></svg></button>
    </h3>
    {#if shown}<DiffView {tab} oid={commit.oid} parent={from ? (from.parents[0] ?? null) : (detail!.parents[0] ?? null)} from={from?.oid ?? null} file={f} onjump={onjump} />{/if}
  </div>
{/snippet}

<div class="details">
  <DetailTabs tabs={fileTabs} active={focused ? focus : null} onpick={(k) => (focus = k)} onclose={closeTab} />
  <div class="dscroll" class:waiting>
    {#if error}<p class="err" role="alert">{error}</p>{/if}
    {#if !detail && !error}<p class="hint">Loading…</p>{/if}
    {#if detail && focused}
      <DiffToolbar />
      {#key focused.path}{@render block(focused, true)}{/key}
    {:else if detail}
      <div class="kvwrap">
        <table class="kv">
          <tbody>
            {#if stash}<tr><th>Stash</th><td>{stash}</td></tr>{/if}
            <tr><th>{stash ? "Stash Hash" : "Commit Hash"}</th><td><button class="mono link" title="Copy full hash" onclick={() => doCopy("hash", commit.oid)}>{copied === "hash" ? "Copied" : detail.oid}</button></td></tr>
            <tr><th>Tree</th><td class="mono">{detail.tree}</td></tr>
            {#if from}
              <tr><th>Diffing From</th><td class="diffing"><span class="mono">{(from.parents[0] ?? "root").slice(0, 8)}</span> (parent of {from.oid.slice(0, 8)})</td></tr>
            {/if}
            <tr><th>Author</th><td class="who"><span class="av" style:background={colorFor(detail.email)}>{initials(detail.author)}</span>{detail.author} &lt;{detail.email}&gt;</td></tr>
            <tr><th>Date</th><td>{fullDate(detail.time)}{#if detail.commit_time !== detail.time}{" "}<span class="sub">· committed on {fullDate(detail.commit_time)}{detail.committer !== detail.author ? ` by ${detail.committer}` : ""}</span>{/if}</td></tr>
            <tr><th>Parent{detail.parents.length === 1 ? "" : "s"}</th><td>
              {#each detail.parents as p, i}{i ? ", " : ""}<button class="mono link parent" onclick={() => onjump(p)}>{p.slice(0, 8)}</button>{:else}<span class="sub">none (root commit)</span>{/each}
            </td></tr>
            {#if branches.length}<tr><th>Branches</th><td class="pills">{#each branches as l}<span class="ref" class:head={l.head} class:remote={l.kind === "remote"}>{l.name}</span>{/each}</td></tr>{/if}
            {#if tags.length}<tr><th>Tags</th><td class="pills">{#each tags as l}<span class="ref">{l.name}</span>{/each}</td></tr>{/if}
            <tr><th>Stats</th><td class="stats">{detail.files.length} file{detail.files.length === 1 ? "" : "s"} changed: <span class="pill-n del">−{totals[1]}</span> <span class="pill-n add">+{totals[0]}</span>{#if !from && detail.parents.length > 1} <span class="sub">(against the first parent)</span>{/if}</td></tr>
          </tbody>
        </table>
        <button class="ib" aria-label="Commit actions" title="Commit actions" onclick={commitMenu}><svg class="i"><use href="#i-dots" /></svg></button>
      </div>
      {#if editing}
        <div class="msgedit">
          <textarea class="msg mono" bind:this={editor} bind:value={draft} onkeydown={msgKey} aria-label="Edit commit message" spellcheck="true" rows={Math.min(14, Math.max(4, draft.split("\n").length + 1))}></textarea>
          <div class="row"><span class="hint">Rewrites this commit and the ones after it (git rebase -i)</span>
            <button class="btn sm" onclick={() => oncancelmessage?.()}>Cancel</button>
            <button class="btn sm primary" disabled={!draft.trim() || saving} onclick={saveMsg}>Save Message</button></div>
        </div>
      {:else}
        <pre class="msg mono">{message}</pre>
      {/if}
      <div class="collapse-row">
        <button class="fh" aria-expanded={anyOpen} onclick={toggleAll}><svg class="i chev" class:open={anyOpen}><use href="#i-chevron" /></svg>{anyOpen ? "Collapse all" : "Expand all"}</button>
        <DiffToolbar />
      </div>
      {#key commit.oid}
        {#each detail.files.slice(0, showFiles) as f (f.path)}{@render block(f, false)}{/each}
      {/key}
      {#if detail.files.length > showFiles}
        <button class="more" onclick={() => (showFiles += FILE_PAGE)}>Show {Math.min(FILE_PAGE, detail.files.length - showFiles)} more of {detail.files.length - showFiles} files</button>
      {/if}
    {/if}
  </div>
</div>
