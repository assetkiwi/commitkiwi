<script lang="ts">
  // One file of a commit (or of a range diff): loads git's patch, shows it in the diff widget with hunk history.
  import { untrack } from "svelte";
  import { api } from "../lib/api";
  import { buildPatch, hunkRange, isBinaryPatch, parseDiff, type DiffRow } from "../lib/diff";
  import { app, type Tab } from "../lib/state.svelte";
  import type { Commit, FileChange } from "../lib/types";
  import { DIFF_FIRST, SKIPPED, diffQueue, estimateHeight, estimateRows } from "../lib/lazy";
  import { lazyBody } from "../lib/lazyBody";
  import { tabScope } from "../lib/tabScope";
  import Diff from "./Diff.svelte";
  import { showContextMenu } from "../lib/mainMenu";
  import { HUNK } from "../lib/contextMenus";

  let { tab, oid, parent, from = null, file, onjump }: {
    tab: Tab; oid: string; parent: string | null;
    /** range diff from this commit's parent (multi-selection) */
    from?: string | null;
    file: FileChange; onjump: (oid: string) => void;
  } = $props();

  let status = $state<"loading" | "error" | "ready">("loading");
  let error = $state("");
  let rows = $state.raw<DiffRow[]>([]);
  let patch = ""; // git's text, for hunk patches
  let binary = $state(false);
  let truncated = $state(false);
  let hist = $state<{ row: number; commits: Commit[] | null; error: string } | null>(null);

  const before = $derived(file.status === "A" || !parent ? null : { rev: parent, path: file.old_path ?? file.path });
  const after = $derived(file.status === "D" ? null : { rev: oid, path: file.path });

  // lazy body: fetched and rendered only near the view; the parsed diff and the user's toggles stay here
  // near = within 1.5 screens of the view, in the shown tab (a hidden tab keeps placeholders only)
  const scope = tabScope();
  let seen = $state(false);
  const near = $derived(seen && scope.active());
  let height = $state(0);
  let fresh = true; // the body has not shown its diff since it (re)mounted: see anchorShift
  let full = $state(false);
  let limit = $state(DIFF_FIRST);
  let sides = $state.raw<{ old: string | null; new: string | null } | undefined>(undefined);
  const want = $derived(JSON.stringify([app.diff.context, app.diff.ignoreWs]));
  let got = "", asked = "";
  let alive = true; // a queued request must not run (or read props) after this file's body is gone
  $effect(() => () => { alive = false; });
  // (Re)load near the view whenever the options that change git's output change.
  $effect(() => { const k = want; if (near && k !== got && k !== asked) untrack(() => load(app.diff.context, app.diff.ignoreWs)); });
  async function load(context: number, ignoreWs: boolean) {
    const k = want;
    asked = k;
    try {
      const args = [tab.location, tab.path, oid, file.path, file.old_path, context, ignoreWs, from] as const;
      const p = await diffQueue(() => api.diff(...args), () => alive && near && want === k);
      if (k !== want) return;
      got = k;
      sides = undefined;
      patch = p.text;
      rows = parseDiff(p.text);
      binary = isBinaryPatch(p.text);
      truncated = p.truncated;
      hist = null;
      error = "";
      status = "ready";
    } catch (e) {
      if (e === SKIPPED) return;
      got = k;
      error = String(e);
      status = "error";
    } finally {
      if (asked === k) asked = "";
    }
  }

  async function showHistory(row: number) {
    if (hist?.row === row) { hist = null; return; }
    const range = hunkRange(rows[row].text);
    if (!range) return;
    hist = { row, commits: null, error: "" };
    try {
      const commits = await api.lineLog(tab.location, tab.path, oid, file.path, range[0], range[1]);
      if (hist?.row === row) hist = { row, commits, error: "" };
    } catch (e) {
      hist = { row, commits: null, error: String(e) };
    }
  }
  const canHistory = $derived(file.status !== "D" && !binary);
  /** the band's `…`: Revert Hunk / Cherry Pick Hunk into the working directory, with this hunk's patch as args */
  function hunkMenu(e: MouseEvent, row: number) {
    const picked = new Set<number>();
    for (let i = row + 1; i < rows.length && rows[i].kind !== "hunk"; i++) if (rows[i].kind === "add" || rows[i].kind === "del") picked.add(i);
    showContextMenu(e.currentTarget as HTMLElement, HUNK, {
      path: file.path, patch_revert: buildPatch(patch, rows, picked, "discard"), patch_pick: buildPatch(patch, rows, picked, "stage"),
    });
  }
</script>

{#snippet historyButton(row: number)}
  {#if canHistory}<button class="btn sm" onclick={() => showHistory(row)} aria-expanded={hist?.row === row}>History</button>{/if}
  <button class="ib" aria-label="Hunk actions" title="Hunk actions" onclick={(e) => hunkMenu(e, row)}><svg class="i"><use href="#i-dots" /></svg></button>
{/snippet}

{#snippet history(row: number)}
  {#if hist?.row === row}
    <div class="hhist" role="region" aria-label="Hunk history">
      {#if hist.error}<p class="err">{hist.error}</p>
      {:else if !hist.commits}<p class="hint">Loading…</p>
      {:else if !hist.commits.length}<p class="hint">No earlier commits touched these lines.</p>
      {:else}
        <ul>{#each hist.commits as c (c.oid)}
          <li><button onclick={() => onjump(c.oid)}><span class="mono">{c.oid.slice(0, 8)}</span> {c.subject} <span class="hint">· {c.author}</span></button></li>
        {/each}</ul>
      {/if}
    </div>
  {/if}
{/snippet}

<div class="lazy" {@attach lazyBody((v) => { seen = v; if (!v) fresh = true; }, (h) => { height = h; if (near && status !== "loading") fresh = false; }, () => fresh)}
  style:height={near && status !== "loading" ? null : `${height || estimateHeight(estimateRows(file.adds, file.dels, app.diff.context, app.diff.mode === "split"), limit, 20, app.diff.wrap || app.diff.mode === "split")}px`}>
  {#if near}{#if status === "loading"}
    <p class="hint pad">Loading diff…</p>
  {:else if status === "error"}
    <p class="err pad" role="alert">{error}</p>
  {:else if !rows.length && !binary}
    <p class="hint pad">{file.old_path ? `Renamed from ${file.old_path}, no content changes.` : app.diff.ignoreWs ? "Only whitespace changed." : "No textual changes (mode change or empty file)."}</p>
  {:else}
    <Diff {tab} path={file.path} {rows} {binary} {before} {after} band={historyButton} below={history} bind:full bind:limit bind:sides />
  {/if}{/if}
  {#if near && truncated}<p class="hint pad">Diff cut at 4 MB.</p>{/if}
</div>
