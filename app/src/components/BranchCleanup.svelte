<script lang="ts">
  // Clean Up Branches…: the branches core thinks are probably safe to delete (merged, stale, upstream gone), grouped,
  // with checkboxes. Local deletes run as one queued job (Undo recreates them); remote deletes as another, after a
  // second confirmation, and cannot be undone. Unmerged local branches are deleted with -D only after a confirmation
  // that lists them.
  import { untrack } from "svelte";
  import { api } from "../lib/api";
  import { CANCELLED, runGit } from "../lib/jobs.svelte";
  import { GROUPS, branches, cleanupSettings, deletePlan, filterBranches, groupOf, initialSelection, jobLabel, localCaption, remoteBranchName, remoteCaption, shortName, tagsOf, type Cleanup, type CleanupBranch } from "../lib/cleanup";
  import { ago, fullDate } from "../lib/format";
  import { app, reloadTab, type Tab } from "../lib/state.svelte";

  let { tab, onclose }: { tab: Tab; onclose: () => void } = $props();
  const repo = untrack(() => tab.path), loc = untrack(() => tab.location);

  let data = $state.raw<Cleanup | null>(null);
  let selected = $state.raw(new Set<string>());
  let q = $state("");
  let confirm = $state<"local" | "remote" | null>(null);
  let busy = $state(false), error = $state(""), result = $state("");

  async function load() {
    const s = cleanupSettings(app.prefs.cleanup_stale_days, app.prefs.cleanup_protected_branches);
    try {
      data = await api.cleanupCandidates(loc, repo, s.stale_days, s.protected);
      selected = initialSelection(data.branches);
    } catch (e) { error = String(e); }
  }
  void load();

  const all = $derived(data?.branches ?? []);
  const shown = $derived(filterBranches(all, q));
  const groups = $derived(GROUPS.map((g) => ({ ...g, rows: shown.filter((b) => groupOf(b) === g.id) })).filter((g) => g.rows.length));
  const plan = $derived(deletePlan(all, selected));
  const nLocal = $derived(plan.merged.length + plan.unmerged.length);
  const base = $derived(data?.default_branch ?? "the default branch");
  const staleDays = $derived(cleanupSettings(app.prefs.cleanup_stale_days, []).stale_days);

  function toggle(b: CleanupBranch, on: boolean) {
    const s = new Set(selected);
    if (on) s.add(b.name); else s.delete(b.name);
    selected = s;
  }
  function toggleAll(rows: CleanupBranch[], on: boolean) {
    const s = new Set(selected);
    for (const b of rows) if (on) s.add(b.name); else s.delete(b.name);
    selected = s;
  }

  async function run(label: string, req: Parameters<typeof runGit>[2], done: string) {
    busy = true; error = ""; result = ""; confirm = null;
    try {
      await runGit(tab, label, req);
      result = done;
    } catch (e) { error = e === CANCELLED ? "Cancelled." : String(e); }
    busy = false;
    await Promise.all([load(), reloadTab(tab).catch(() => {})]);
  }
  function deleteLocal() {
    const { merged, unmerged } = plan;
    const names = [...merged, ...unmerged.map(shortName)];
    const n = names.length;
    void run(jobLabel(unmerged.length ? "git branch -d/-D" : "git branch -d", names), { DeleteBranches: { repo, merged, unmerged: unmerged.map(shortName) } },
      `Deleted ${branches(n)}. Undo (Changes > Undo) restores ${n === 1 ? "it" : "them"} during this session.`);
  }
  function deleteRemote() {
    const refs = plan.remote.map((b) => b.name);
    void run(jobLabel(`git push ${plan.remotes.join(",")} --delete`, plan.remote.map(remoteBranchName)), { DeleteRemoteBranches: { repo, branches: refs } },
      `Deleted ${branches(refs.length)} on ${plan.remotes.join(", ")}. This cannot be undone here.`);
  }
  const onLocal = () => (plan.unmerged.length ? (confirm = "local") : deleteLocal());

  const focus = (el: HTMLElement) => { requestAnimationFrame(() => el.focus()); };
  const onkeydown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (confirm) confirm = null; else onclose();
  };
</script>

<svelte:window {onkeydown} />
<div class="scrim dim" role="presentation" onmousedown={onclose}></div>
<div class="overlay add-repos forge cleanup" role="dialog" aria-label="Clean Up Branches">
  <div class="ar-form">
    <h1>Clean Up Branches</h1>
    <p class="hint">Merged into {base} or HEAD{staleDays ? `, no commit for ${staleDays} days` : ""}, or the upstream is gone. Never the current branch, {base}, branches checked out in a worktree, or protected names (<code>cleanup_protected_branches</code>).</p>
    {#if data && !data.default_branch}<p class="hint">No default branch found (no origin/HEAD, main or master): only branches merged into HEAD count as merged.</p>{/if}
    {#if data?.branches.length}
      <input bind:value={q} placeholder="Filter branches" aria-label="Filter branches" spellcheck="false" autocomplete="off" use:focus />
    {/if}
  </div>
  {#if confirm === "local"}
    <div class="cl-confirm" role="group" aria-label="Confirm unmerged">
      <p><b>{plan.unmerged.length === 1 ? "1 of these branches has" : `${plan.unmerged.length} of these branches have`} commits that are not on {base}.</b> {plan.unmerged.length === 1 ? "It is deleted with" : "They are deleted with"} <code>git branch -D</code>; Undo restores {plan.unmerged.length === 1 ? "it" : "them"} during this session.</p>
      <ul>{#each plan.unmerged as b (b.name)}<li><span class="mono">{shortName(b)}</span> <span class="sub">{b.ahead} commit{b.ahead === 1 ? "" : "s"} not on {base}</span></li>{/each}</ul>
      <div class="ar-bar end">
        <button class="btn" onclick={() => (confirm = null)}>Back</button>
        <button class="btn danger" use:focus onclick={deleteLocal}>Delete {branches(nLocal)}, including unmerged</button>
      </div>
    </div>
  {:else if confirm === "remote"}
    <div class="cl-confirm" role="group" aria-label="Confirm remote delete">
      <p><b>This deletes {branches(plan.remote.length)} on the remote {plan.remotes.join(", ")}</b>, for everyone who uses it. It cannot be undone here: Undo only restores local branches.</p>
      <ul>{#each plan.remote as b (b.name)}<li><span class="mono">{shortName(b)}</span>{#if !b.merged}<span class="sub"> not merged: {b.ahead} commit{b.ahead === 1 ? "" : "s"} only there</span>{/if}</li>{/each}</ul>
      <div class="ar-bar end">
        <button class="btn" onclick={() => (confirm = null)}>Back</button>
        <button class="btn danger" use:focus onclick={deleteRemote}>Delete on {plan.remotes.join(", ")}</button>
      </div>
    </div>
  {:else}
    <div class="cl-list">
      {#if error}<p class="err" role="alert">{error}</p>{/if}
      {#if result}<p class="hint" role="status">{result}</p>{/if}
      {#if !data && !error}<p class="hint">Looking for branches…</p>
      {:else if data && !all.length}<p class="hint">Nothing to clean up.</p>
      {:else if data && !groups.length}<p class="hint">No branch matches the filter.</p>{/if}
      {#each groups as g (g.id)}
        {@const on = g.rows.filter((b) => selected.has(b.name)).length}
        <section aria-label={g.title}>
          <label class="cl-head">
            <input type="checkbox" checked={on === g.rows.length} indeterminate={on > 0 && on < g.rows.length} aria-label="Select all {g.title}"
              onchange={(e) => toggleAll(g.rows, e.currentTarget.checked)} />
            <span>{g.title} ({g.rows.length})</span>
            {#if g.remote}<span class="sub">deleting these changes the remote</span>{/if}
          </label>
          <ul>
            {#each g.rows as b (b.name)}
              <li>
                <label class="cl-row">
                  <input type="checkbox" checked={selected.has(b.name)} aria-label={shortName(b)} onchange={(e) => toggle(b, e.currentTarget.checked)} />
                  <span class="cl-main">
                    <span class="cl-name"><span class="mono">{shortName(b)}</span>{#each tagsOf(b) as t}<span class="cl-tag {t.replace(' ', '-')}">{t}</span>{/each}</span>
                    <span class="sub" title={fullDate(b.time)}>{ago(b.time)} · {b.author} · {b.subject}</span>
                  </span>
                  {#if data?.default_branch}<span class="sub cl-ab" title="commits not on {base} / commits on {base} it lacks">↑{b.ahead} ↓{b.behind}</span>{/if}
                </label>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
      {#if data?.truncated}<p class="hint">More candidates than shown: delete some, then open this again.</p>{/if}
    </div>
    <div class="ar-bar end">
      <span class="sub">{branches(all.length)} found</span>
      <button class="btn" onclick={onclose}>Close</button>
      {#if all.some((b) => b.remote !== null)}
        <button class="btn danger" disabled={busy || !plan.remote.length} onclick={() => (confirm = "remote")}>{remoteCaption(plan.remote.length)}</button>
      {/if}
      <button class="primary" disabled={busy || !nLocal} onclick={onLocal}>{busy ? "Deleting…" : localCaption(nLocal)}</button>
    </div>
  {/if}
</div>
