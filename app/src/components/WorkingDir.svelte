<script lang="ts">
  // The Working Directory summary: every changed file stacked with its diff, staged files below,
  // one tab per file, and the commit box at the bottom.
  import { SvelteSet } from "svelte/reactivity";
  import { CANCELLED, runGit } from "../lib/jobs.svelte";
  import { app, openInEditor, type Tab } from "../lib/state.svelte";
  import { showMenu } from "../lib/ui.svelte";
  import { runCommand } from "../lib/commands";
  import { showContextMenu } from "../lib/mainMenu";
  import { workFileMenu } from "../lib/contextMenus";
  import type { Req, Status, WorkFile } from "../lib/types";
  import CommitBox from "./CommitBox.svelte";
  import DetailTabs from "./DetailTabs.svelte";
  import DiffToolbar from "./DiffToolbar.svelte";
  import WorkDiff from "./WorkDiff.svelte";

  const LIST = "untracked"; // the focus value of the Untracked Files list tab
  const AUTO_FILES = 20; // more changed files than this start collapsed (each open file loads its diff)
  const PAGE = 500; // file cards (and tabs) rendered per section, more on demand: 20,000 of them freeze the view
  let { tab, status, rev = 0, onchanged, focus = $bindable(null) }: {
    tab: Tab; status: Status | null; onchanged: () => Promise<void>;
    /** bumped when file contents may have changed under an unchanged status: open diffs reload */
    rev?: number;
    /** the open file tab, `u:<path>` (unstaged or unmerged) or `s:<path>` (staged); null = Summary */
    focus?: string | null;
  } = $props();

  let confirming = $state<string | null>(null); // a file key, or "*modified" for Discard All
  let error = $state("");
  let diffVersion = $state(0);
  const flipped = new SvelteSet<string>(); // keys whose expanded state differs from the default
  const closed = new SvelteSet<string>(); // closed file tabs
  const limit = $state({ m: PAGE, u: PAGE, s: PAGE }); // cards shown per section: modified, untracked, staged
  // like Sublime Merge: a few untracked files sit open below the Working Directory (each closed until its chevron is
  // clicked); more than AUTO_FILES never show in one view, "Show Files" opens a list tab instead (rows, no diffs)
  let hideUntracked = $state(false);
  let listOpen = $state(false);

  const files = $derived(status?.files ?? []);
  const conflicts = $derived(files.filter((f) => f.kind === "conflicted"));
  const modified = $derived(files.filter((f) => f.kind === "changed" && f.worktree !== "."));
  const untracked = $derived(files.filter((f) => f.kind === "untracked"));
  const unstaged = $derived([...modified, ...untracked]);
  const staged = $derived(files.filter((f) => f.kind === "changed" && f.index !== "."));
  const top = $derived([...conflicts, ...modified]); // the "Working Directory" section; untracked files have their own
  const keyOf = (f: WorkFile, isStaged: boolean) => `${isStaged ? "s" : "u"}:${f.path}`;
  const letter = (f: WorkFile, isStaged: boolean) =>
    f.kind === "conflicted" ? "!" : f.kind === "untracked" ? "?" : isStaged ? "S" : f.worktree;

  // Reload open diffs whenever the status changes or files were edited (a file event, a poll, we staged something).
  let lastKey = "";
  $effect(() => {
    const key = JSON.stringify([files, rev]);
    if (key !== lastKey) { lastKey = key; diffVersion++; }
  });
  $effect(() => { if (focus) closed.delete(focus); });

  const untrackedPaths = $derived(new Set(untracked.map((f) => f.path)));
  const fewUntracked = $derived(untracked.length <= AUTO_FILES);
  const isOpen = (key: string, isStaged: boolean) => {
    const auto = !isStaged && !untrackedPaths.has(key.slice(2)) && top.length <= AUTO_FILES;
    return auto !== flipped.has(key);
  };
  const toggle = (key: string) => (flipped.has(key) ? flipped.delete(key) : flipped.add(key));
  /** a section's chevron: collapse all its files if any is open, else expand all */
  function toggleSection(list: WorkFile[], isStaged: boolean) {
    const want = !list.some((f) => isOpen(keyOf(f, isStaged), isStaged));
    for (const f of list) if (isOpen(keyOf(f, isStaged), isStaged) !== want) toggle(keyOf(f, isStaged));
  }
  const anyOpen = (list: WorkFile[], isStaged: boolean) => list.some((f) => isOpen(keyOf(f, isStaged), isStaged));

  const focused = $derived.by(() => {
    if (!focus || focus === LIST) return null;
    const isStaged = focus.startsWith("s:");
    const f = (isStaged ? staged : [...top, ...untracked]).find((x) => keyOf(x, isStaged) === focus);
    return f ? { f, isStaged } : null;
  });
  const fileTabs = $derived.by(() => {
    const list = [
      ...conflicts.map((f) => ({ f, s: false })), ...modified.slice(0, limit.m).map((f) => ({ f, s: false })),
      ...(fewUntracked ? untracked : []).map((f) => ({ f, s: false })), ...staged.slice(0, limit.s).map((f) => ({ f, s: true })),
    ];
    // the open file keeps its tab even beyond the rendered page (picked in the Files column or the untracked list)
    if (focused && !list.some(({ f, s }) => keyOf(f, s) === focus)) list.push({ f: focused.f, s: focused.isStaged });
    const out = list.filter(({ f, s }) => !closed.has(keyOf(f, s))).map(({ f, s }) => ({ key: keyOf(f, s), label: base(f.path), title: f.path, badge: letter(f, s) }));
    return listOpen && untracked.length ? [{ key: LIST, label: `Untracked Files (${untracked.length.toLocaleString()})`, title: "Untracked Files", badge: "?" }, ...out] : out;
  });
  function closeTab(key: string) { if (key === LIST) listOpen = false; else closed.add(key); if (focus === key) focus = null; }
  const showList = () => { listOpen = true; focus = LIST; };

  async function act(cmd: string, req: Req) {
    error = "";
    confirming = null;
    try { await runGit(tab, cmd, req); } catch (e) { if (e !== CANCELLED) error = String(e); }
    await onchanged();
  }
  const paths = (l: WorkFile[]) => l.map((f) => f.path);
  const repo = $derived(tab.path);
  const stage = (p: string[]) => act(`git add ${p.join(" ")}`, { Stage: { repo, paths: p } });
  const unstage = (p: string[]) => act(`git restore --staged ${p.join(" ")}`, { Unstage: { repo, paths: p } });
  const discard = (p: string[]) => act(`discard ${p.join(" ")}`, { Discard: { repo, paths: p } });
  const resolve = (p: string, theirs: boolean) => act(`git checkout --${theirs ? "theirs" : "ours"} ${p}`, { Resolve: { repo, path: p, theirs } });


  /** the file band's `…` (or a right-click on the band): the file menu + the one for its status */
  function fileMenu(e: MouseEvent, f: WorkFile, isStaged: boolean) {
    const [defs, vars] = workFileMenu(f, isStaged);
    showContextMenu(e.type === "contextmenu" ? e : (e.currentTarget as HTMLElement), defs, vars);
  }
  function resolveMenu(e: MouseEvent, f: WorkFile) {
    showMenu(e.currentTarget as HTMLElement, [
      { label: "Resolve Using Ours", run: () => void resolve(f.path, false) },
      { label: "Resolve Using Theirs", run: () => void resolve(f.path, true) },
      "-",
      { label: "Open in Editor", run: () => void openInEditor(tab, f.path) },
    ]);
  }
  const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
  const base = (p: string) => p.slice(dir(p).length);
</script>

{#snippet more(n: number, k: "m" | "u" | "s")}
  {#if n > limit[k]}<p class="hint"><button class="btn sm" onclick={() => (limit[k] += PAGE)}>Show {Math.min(PAGE, n - limit[k]).toLocaleString()} more files</button> {(n - limit[k]).toLocaleString()} not shown</p>{/if}
{/snippet}

{#snippet row(f: WorkFile)}
  {@const key = keyOf(f, false)}
  <div class="card file">
    <h3 class="band" oncontextmenu={(e) => fileMenu(e, f, false)}>
      <button class="fh" onclick={() => (focus = key)}><span class="st st-?" title="untracked">?</span><span class="path"><span class="dir">{dir(f.path)}</span>{base(f.path)}</span></button>
      <span class="acts">
        {#if confirming === key}
          <button class="btn sm danger" onclick={() => discard([f.path])}>Delete file</button>
          <button class="btn sm" onclick={() => (confirming = null)}>Cancel</button>
        {:else}
          <button class="btn sm" aria-label="Delete {f.path}" onclick={() => (app.prefs.confirm_destructive ? (confirming = key) : discard([f.path]))}>Delete</button>
          <button class="btn sm" aria-label="Stage {f.path}" onclick={() => stage([f.path])}>Stage</button>
        {/if}
      </span>
    </h3>
  </div>
{/snippet}

{#snippet block(f: WorkFile, isStaged: boolean, single: boolean)}
  {@const key = keyOf(f, isStaged)}
  {@const shown = single || isOpen(key, isStaged)}
  {@const l = letter(f, isStaged)}
  <div class="card file" class:conflict={f.kind === "conflicted"}>
    <h3 class="band" oncontextmenu={(e) => fileMenu(e, f, isStaged)}>
      {#snippet name()}
        <span class="st st-{l}" title={f.kind}>{l}</span>
        <span class="path"><span class="dir">{f.old_path ? `${f.old_path} → ` : ""}{dir(f.path)}</span>{base(f.path)}</span>
      {/snippet}
      {#if single}<span class="fh">{@render name()}</span>
      {:else}<button class="fh" aria-expanded={shown} onclick={() => toggle(key)}><svg class="i chev" class:open={shown}><use href="#i-chevron" /></svg>{@render name()}</button>{/if}
      <span class="acts">
        {#if confirming === key}
          <button class="btn sm danger" onclick={() => discard([f.path])}>{f.kind === "untracked" ? "Delete file" : "Really discard"}</button>
          <button class="btn sm" onclick={() => (confirming = null)}>Cancel</button>
        {:else if f.kind === "conflicted"}
          <span class="split">
            <button class="btn sm" title="Open the merge tool" onclick={() => runCommand("resolve_merge_conflict", { path: f.path })}>Resolve</button>
            <button class="btn sm dd" aria-label="Resolve options for {f.path}" onclick={(e) => resolveMenu(e, f)}><svg class="i"><use href="#i-down" /></svg></button>
          </span>
          <button class="btn sm" aria-label="Stage {f.path}" onclick={() => stage([f.path])}>Stage</button>
        {:else if isStaged}
          <button class="btn sm" aria-label="Unstage {f.path}" onclick={() => unstage([f.path])}>Unstage</button>
        {:else}
          <button class="btn sm" aria-label="Discard {f.path}" onclick={() => (app.prefs.confirm_destructive ? (confirming = key) : discard([f.path]))}>Discard</button>
          <button class="btn sm" aria-label="Stage {f.path}" onclick={() => stage([f.path])}>Stage</button>
        {/if}
        <button class="ib" aria-label="File actions for {f.path}" title="File actions" onclick={(e) => fileMenu(e, f, isStaged)}><svg class="i"><use href="#i-dots" /></svg></button>
      </span>
    </h3>
    {#if shown}<WorkDiff {tab} file={f} staged={isStaged} version={diffVersion} onchanged={onchanged} />{/if}
  </div>
{/snippet}

<div class="details work">
  <DetailTabs tabs={fileTabs} active={focused || (focus === LIST && listOpen) ? focus : null} onpick={(k) => (focus = k)} onclose={closeTab} />
  <div class="dscroll">
    {#if error}<p class="err" role="alert">{error}</p>{/if}
    {#if status?.truncated}<p class="hint">Only the first {files.length.toLocaleString()} files are listed.</p>{/if}
    {#if !status}<p class="hint">Loading…</p>
    {:else if focus === LIST && listOpen}
      <div class="wsec"><span class="fh">Untracked Files <span class="cnt">{untracked.length.toLocaleString()}</span></span>
        <button class="btn sm" onclick={() => stage(paths(untracked))}>Stage All</button></div>
      {#each untracked.slice(0, limit.u) as f (f.path)}{@render row(f)}{/each}
      {@render more(untracked.length, "u")}
    {:else if focused}
      <DiffToolbar />
      {#key focus}{@render block(focused.f, focused.isStaged, true)}{/key}
    {:else if !files.length}
      <div class="empty"><div><h2>No changes</h2><p class="hint">The working directory is clean.</p></div></div>
    {:else}
      <DiffToolbar />
      {#if top.length}
        <div class="wsec">
          <button class="fh" aria-expanded={anyOpen(top, false)} onclick={() => { toggleSection(conflicts, false); toggleSection(modified, false); }}>
            <svg class="i chev" class:open={anyOpen(top, false)}><use href="#i-chevron" /></svg>Working Directory
          </button>
          {#if modified.length}
            {#if confirming === "*modified"}
              <button class="btn sm danger" onclick={() => discard(paths(modified))}>Really discard all {modified.length.toLocaleString()} files</button>
              <button class="btn sm" onclick={() => (confirming = null)}>Cancel</button>
            {:else}
              <button class="btn sm" onclick={() => (app.prefs.confirm_destructive ? (confirming = "*modified") : discard(paths(modified)))}>Discard All</button>
            {/if}
          {/if}
          <button class="btn sm" onclick={() => stage(paths(top))}>Stage All</button>
        </div>
        {#each conflicts as f (f.path)}{@render block(f, false, false)}{/each}
        {#each modified.slice(0, limit.m) as f (f.path)}{@render block(f, false, false)}{/each}
        {@render more(modified.length, "m")}
      {/if}
      {#if untracked.length}
        <div class="wsec">
          {#if fewUntracked}
            <button class="fh" aria-expanded={!hideUntracked} onclick={() => (hideUntracked = !hideUntracked)}>
              <svg class="i chev" class:open={!hideUntracked}><use href="#i-chevron" /></svg>Untracked Files <span class="cnt">{untracked.length}</span>
            </button>
          {:else}
            <span class="fh">Untracked Files <span class="cnt">{untracked.length.toLocaleString()}</span></span>
          {/if}
          {#if confirming === "*untracked"}
            <button class="btn sm danger" onclick={() => discard(paths(untracked))}>Really delete all {untracked.length.toLocaleString()} files</button>
            <button class="btn sm" onclick={() => (confirming = null)}>Cancel</button>
          {:else}
            <button class="btn sm" onclick={() => (app.prefs.confirm_destructive ? (confirming = "*untracked") : discard(paths(untracked)))}>Delete All</button>
          {/if}
          <button class="btn sm" onclick={() => stage(paths(untracked))}>Stage All</button>
          {#if !fewUntracked}<button class="btn sm" onclick={showList}>Show Files</button>{/if}
        </div>
        {#if fewUntracked && !hideUntracked}
          {#each untracked as f (f.path)}{@render block(f, false, false)}{/each}
        {/if}
      {/if}
      {#if staged.length}
        <div class="wsec">
          <button class="fh" aria-expanded={anyOpen(staged, true)} onclick={() => toggleSection(staged, true)}>
            <svg class="i chev" class:open={anyOpen(staged, true)}><use href="#i-chevron" /></svg>Staged Files
          </button>
          <button class="btn sm" onclick={() => unstage(paths(staged))}>Unstage All</button>
        </div>
        {#each staged.slice(0, limit.s) as f (f.path)}{@render block(f, true, false)}{/each}
        {@render more(staged.length, "s")}
      {/if}
    {/if}
  </div>
  <CommitBox {tab} staged={staged.length} stagedKey={staged.map((f) => f.index + f.path).join("\n")} unmerged={paths(conflicts)} merge={status?.merge ?? null} {onchanged} />
</div>
