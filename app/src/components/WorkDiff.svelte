<script lang="ts">
  // One working-copy file in the diff widget: hunk buttons in each band, gutter-selected lines become
  // [Discard Lines][Stage Lines] (or [Unstage Lines]) in the bands of the hunks they touch.
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { api } from "../lib/api";
  import { CANCELLED, runGit } from "../lib/jobs.svelte";
  import { app } from "../lib/state.svelte";
  import { buildPatch, isBinaryPatch, parseDiff, type DiffRow, type PatchMode } from "../lib/diff";
  import type { Tab } from "../lib/state.svelte";
  import type { FileRev, WorkFile } from "../lib/types";
  import { DIFF_FIRST, SKIPPED, diffQueue, estimateHeight } from "../lib/lazy";
  import { lazyBody } from "../lib/lazyBody";
  import { tabScope } from "../lib/tabScope";
  import Diff from "./Diff.svelte";

  let { tab, file, staged, version, onchanged }: {
    tab: Tab; file: WorkFile; staged: boolean;
    /** bump to reload the diff (status poll saw a change) */
    version: number;
    onchanged: () => void;
  } = $props();

  let patch = $state("");
  let rows = $state.raw<DiffRow[]>([]);
  let binary = $state(false);
  let status = $state<"loading" | "ready" | "error">("loading");
  let error = $state("");
  let confirming = $state(false);
  const picked = new SvelteSet<number>();
  // lazy body: the diff is fetched and rendered only near the view; what the user did with it lives here
  // near = within 1.5 screens of the view, in the shown tab (a hidden tab keeps placeholders only)
  const scope = tabScope();
  let seen = $state(false);
  const near = $derived(seen && scope.active());
  let height = $state(0);
  let fresh = true; // the body has not shown its diff since it (re)mounted: see anchorShift // last rendered height: the placeholder keeps it
  let full = $state(false);
  let limit = $state(DIFF_FIRST);
  let sides = $state.raw<{ old: string | null; new: string | null } | undefined>(undefined);

  const untracked = $derived(file.kind === "untracked");
  const conflicted = $derived(file.kind === "conflicted");
  // no hunk/line staging: nothing in the index yet (untracked), the index holds the conflict stages, or whitespace
  // is ignored (git apply cannot match context lines whose whitespace the diff hid)
  const readonly = $derived(untracked || conflicted || app.diff.ignoreWs);
  const hunks = $derived(rows.flatMap((r, i) => (r.kind === "hunk" ? [i] : [])));
  const modeMain: PatchMode = $derived(staged ? "unstage" : "stage");
  const side = (rev: string): FileRev => ({ rev, path: file.path });
  // what each side of the diff is: staged = HEAD -> index, unstaged = index -> worktree (conflicts: HEAD -> worktree)
  const before = $derived<FileRev | null>(
    untracked ? null : staged ? (file.index === "A" ? null : { rev: "HEAD", path: file.old_path ?? file.path }) : side(conflicted ? "HEAD" : "index"));
  const after = $derived<FileRev | null>(staged ? (file.index === "D" ? null : side("index")) : file.worktree === "D" ? null : side("worktree"));

  // what the loaded diff must match: a poll version bump or an option change makes it stale
  const want = $derived(JSON.stringify([file.path, file.old_path, staged, untracked, conflicted, version, app.diff.context, app.diff.ignoreWs]));
  let got = "", asked = "";
  let alive = true; // a queued request must not run (or read props) after this file's body is gone
  $effect(() => () => { alive = false; });
  async function load() {
    const k = want;
    asked = k;
    try {
      // waits its turn (3 at a time); dropped if the body scrolled away or the request went stale meanwhile
      const args = [tab.location, tab.path, file.path, file.old_path, staged, untracked, conflicted, app.diff.context, app.diff.ignoreWs] as const;
      const p = await diffQueue(() => api.workDiff(...args), () => alive && near && want === k);
      if (k !== want) return;
      if (p.text === patch && status === "ready") { got = k; return; } // reloaded for an edit that did not touch this file
      patch = p.text;
      rows = parseDiff(p.text);
      binary = isBinaryPatch(p.text);
      sides = undefined;
      // keep picks only where the same row is still a change
      for (const i of [...picked]) if (!rows[i] || (rows[i].kind !== "add" && rows[i].kind !== "del")) picked.delete(i);
      error = "";
      status = "ready";
      got = k;
    } catch (e) {
      if (e === SKIPPED) return;
      error = String(e);
      status = "error";
      got = k;
    } finally {
      if (asked === k) asked = "";
    }
  }
  // fetch when the body first comes near, and again near the view once it went stale
  $effect(() => { const k = want; if (near && k !== got && k !== asked) untrack(load); });
  $effect(() => { void [file.path, staged]; untrack(() => { picked.clear(); confirming = false; }); });

  const hunkEnd = (h: number) => hunks[hunks.indexOf(h) + 1] ?? rows.length;
  const hunkSet = (h: number) => {
    const out = new Set<number>();
    for (let i = h + 1; i < hunkEnd(h); i++) if (rows[i].kind === "add" || rows[i].kind === "del") out.add(i);
    return out;
  };
  const touches = (h: number) => [...picked].some((i) => i > h && i < hunkEnd(h));

  const APPLY: Record<PatchMode, string> = { stage: "git apply --cached", unstage: "git apply --cached --reverse", discard: "git apply --reverse" };
  async function run(mode: PatchMode, which: ReadonlySet<number>) {
    const p = buildPatch(patch, rows, which, mode);
    if (!p) return;
    try {
      await runGit(tab, `${APPLY[mode]} (${file.path})`, { Apply: { repo: tab.path, patch: p, mode } });
      picked.clear();
      error = "";
    } catch (e) {
      // typically "patch does not apply": the file changed since the diff was loaded
      if (e !== CANCELLED) error = String(e);
    }
    confirming = false;
    await load();
    onchanged();
  }
</script>

{#snippet buttons(h: number)}
  {#if !readonly}
    {#if touches(h)}
      {#if !staged}
        {#if confirming}
          <button class="btn sm danger" onclick={() => run("discard", picked)}>Really discard lines</button>
          <button class="btn sm" onclick={() => (confirming = false)}>Cancel</button>
        {:else}
          <button class="btn sm" onclick={() => (confirming = true)}>Discard Lines</button>
        {/if}
      {/if}
      <button class="btn sm" onclick={() => run(modeMain, picked)}>{staged ? "Unstage" : "Stage"} Lines</button>
    {:else}
      {#if !staged}<button class="btn sm" onclick={() => run("discard", hunkSet(h))}>Discard Hunk</button>{/if}
      <button class="btn sm" onclick={() => run(modeMain, hunkSet(h))}>{staged ? "Unstage" : "Stage"} Hunk</button>
    {/if}
  {/if}
{/snippet}

<div class="lazy" {@attach lazyBody((v) => { seen = v; if (!v) fresh = true; }, (h) => { height = h; if (near && status !== "loading") fresh = false; }, () => fresh)}
  style:height={near && status !== "loading" ? null : `${height || estimateHeight(rows.length || 20, limit, 20, app.diff.wrap || app.diff.mode === "split")}px`}>
  {#if near}{#if status === "loading"}
    <p class="hint pad">Loading diff…</p>
  {:else}
    {#if error}<p class="err pad" role="alert">{error}</p>{/if}
    {#if !rows.length && !binary}
      <p class="hint pad">No textual changes (mode change, empty file or submodule).</p>
    {:else}
      <div class="wdiff">
        <Diff {tab} path={file.path} {rows} {binary} {before} {after} picked={readonly ? null : picked} band={buttons} bind:full bind:limit bind:sides />
      </div>
    {/if}
  {/if}{/if}
</div>
