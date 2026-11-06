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

  const AUTO_FILES = 20; // more changed files than this start collapsed (each open file loads its diff)
  let { tab, status, onchanged, focus = $bindable(null) }: {
    tab: Tab; status: Status | null; onchanged: () => Promise<void>;
    /** the open file tab, `u:<path>` (unstaged or unmerged) or `s:<path>` (staged); null = Summary */
    focus?: string | null;
  } = $props();

  let confirming = $state<string | null>(null); // a file key, or "u:*" for Discard All
  let error = $state("");
  let diffVersion = $state(0);
  const flipped = new SvelteSet<string>(); // keys whose expanded state differs from the default
  const closed = new SvelteSet<string>(); // closed file tabs

  const files = $derived(status?.files ?? []);
  const conflicts = $derived(files.filter((f) => f.kind === "conflicted"));
  const unstaged = $derived(files.filter((f) => f.kind === "untracked" || (f.kind === "changed" && f.worktree !== ".")));
  const staged = $derived(files.filter((f) => f.kind === "changed" && f.index !== "."));
  const top = $derived([...conflicts, ...unstaged]); // the "Working Directory" section
  const keyOf = (f: WorkFile, isStaged: boolean) => `${isStaged ? "s" : "u"}:${f.path}`;
  const letter = (f: WorkFile, isStaged: boolean) =>
    f.kind === "conflicted" ? "!" : f.kind === "untracked" ? "?" : isStaged ? "S" : f.worktree;

  // Reload open diffs whenever the status changes (a poll saw an edit, or we staged something).
  let lastKey = "";
  $effect(() => {
    const key = JSON.stringify(files);
    if (key !== lastKey) { lastKey = key; diffVersion++; }
  });
  $effect(() => { if (focus) closed.delete(focus); });

  const isOpen = (key: string, isStaged: boolean) => (!isStaged && top.length <= AUTO_FILES) !== flipped.has(key);
  const toggle = (key: string) => (flipped.has(key) ? flipped.delete(key) : flipped.add(key));
  /** a section's chevron: collapse all its files if any is open, else expand all */
  function toggleSection(list: WorkFile[], isStaged: boolean) {
    const want = !list.some((f) => isOpen(keyOf(f, isStaged), isStaged));
    for (const f of list) if (isOpen(keyOf(f, isStaged), isStaged) !== want) toggle(keyOf(f, isStaged));
  }
  const anyOpen = (list: WorkFile[], isStaged: boolean) => list.some((f) => isOpen(keyOf(f, isStaged), isStaged));

  const fileTabs = $derived([
    ...top.map((f) => ({ f, s: false })), ...staged.map((f) => ({ f, s: true })),
  ].filter(({ f, s }) => !closed.has(keyOf(f, s))).map(({ f, s }) => ({ key: keyOf(f, s), label: base(f.path), title: f.path, badge: letter(f, s) })));
  const focused = $derived.by(() => {
    if (!focus) return null;
    const isStaged = focus.startsWith("s:");
    const f = (isStaged ? staged : top).find((x) => keyOf(x, isStaged) === focus);
    return f ? { f, isStaged } : null;
  });
  function closeTab(key: string) { closed.add(key); if (focus === key) focus = null; }

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
  <DetailTabs tabs={fileTabs} active={focused ? focus : null} onpick={(k) => (focus = k)} onclose={closeTab} />
  <div class="dscroll">
    {#if error}<p class="err" role="alert">{error}</p>{/if}
    {#if status?.truncated}<p class="hint">Only the first {files.length.toLocaleString()} files are listed.</p>{/if}
    {#if !status}<p class="hint">Loading…</p>
    {:else if focused}
      <DiffToolbar />
      {#key focus}{@render block(focused.f, focused.isStaged, true)}{/key}
    {:else if !files.length}
      <div class="empty"><div><h2>No changes</h2><p class="hint">The working directory is clean.</p></div></div>
    {:else}
      <DiffToolbar />
      {#if top.length}
        <div class="wsec">
          <button class="fh" aria-expanded={anyOpen(top, false)} onclick={() => { toggleSection(conflicts, false); toggleSection(unstaged, false); }}>
            <svg class="i chev" class:open={anyOpen(top, false)}><use href="#i-chevron" /></svg>Working Directory
          </button>
          {#if unstaged.length}
            {#if confirming === "u:*"}
              <button class="btn sm danger" onclick={() => discard(paths(unstaged))}>Really discard all</button>
              <button class="btn sm" onclick={() => (confirming = null)}>Cancel</button>
            {:else}
              <button class="btn sm" onclick={() => (app.prefs.confirm_destructive ? (confirming = "u:*") : discard(paths(unstaged)))}>Discard All</button>
            {/if}
          {/if}
          <button class="btn sm" onclick={() => stage(paths(top))}>Stage All</button>
        </div>
        {#each conflicts as f (f.path)}{@render block(f, false, false)}{/each}
        {#each unstaged as f (f.path)}{@render block(f, false, false)}{/each}
      {/if}
      {#if staged.length}
        <div class="wsec">
          <button class="fh" aria-expanded={anyOpen(staged, true)} onclick={() => toggleSection(staged, true)}>
            <svg class="i chev" class:open={anyOpen(staged, true)}><use href="#i-chevron" /></svg>Staged Files
          </button>
          <button class="btn sm" onclick={() => unstage(paths(staged))}>Unstage All</button>
        </div>
        {#each staged as f (f.path)}{@render block(f, true, false)}{/each}
      {/if}
    {/if}
  </div>
  <CommitBox {tab} staged={staged.length} stagedKey={staged.map((f) => f.index + f.path).join("\n")} unmerged={paths(conflicts)} merge={status?.merge ?? null} {onchanged} />
</div>
