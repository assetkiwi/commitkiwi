<script lang="ts">
  // The New Tab page: Open / New Repository, Recent Repositories, Clone Repository. "This computer" or a
  // remote host applies to all three. New/Clone run as console jobs (Cancel stops a clone), then open the repo.
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { cloneRepo, initRepo } from "../lib/appCommands";
  import { runCommand } from "../lib/commands";
  import { CANCELLED, journal } from "../lib/jobs.svelte";
  import { filterRecent } from "../lib/recentFilter";
  import { fuzzy } from "../lib/fuzzy";
  import { cloneName, cloneUrlError, folderNameError, folderPathError } from "../lib/repoSetup";
  import { app, hostOf, openRepo } from "../lib/state.svelte";
  import { showAddRepos } from "../lib/ui.svelte";
  import Console from "./Console.svelte";

  const RECENT_SHOWN = 8;
  let mode = $state<"local" | "ssh">("local");
  let host = $state("");
  let path = $state("");
  let hosts = $state<string[]>([]);
  let busy = $state("");
  let error = $state("");
  let url = $state("");
  let name = $state("");
  let dest = $state("~");
  let cloneError = $state("");

  let query = $state("");
  let index = $state(0);
  let search = $state<HTMLInputElement>();
  // the clone-page command focuses the URL field in the next frame, so its focus wins over this one
  onMount(() => { api.sshHosts().then((h) => (hosts = h)).catch(() => {}); search?.focus(); });
  // the console stays while a job runs, and after one failed or was cancelled (its output says why)
  const lastSetup = $derived(journal.jobs.filter((j) => j.repo === "locations").at(-1));
  const setupJobs = $derived(!!lastSetup && lastSetup.status !== "ok");
  const cloning = $derived(journal.jobs.some((j) => j.repo === "locations" && (j.status === "queued" || j.status === "running")));
  const local = $derived(mode === "local");
  // the existing list shows every location (each row tags its host), so the filter does too
  const inMode = $derived(app.recent);
  const filtering = $derived(!!query.trim());
  const shown = $derived(filtering ? filterRecent(inMode, query, (r) => app.aliases[`${r.location}|${r.path}`] ?? "", fuzzy) : inMode.slice(0, RECENT_SHOWN));
  $effect(() => { query; index = 0; });
  function searchKey(e: KeyboardEvent) {
    const n = shown.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n) index = (index + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[index]) openRecent(shown[index]);
    } else if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); query = ""; }
    // an empty field lets Escape through as the normal key binding
  }
  const openRecent = (r: { location: string; path: string }) => !busy && run("Opening…", r.location, () => openRepo(r.location, r.path), (e) => (error = e));
  $effect(() => { if (filtering) document.querySelector(".recent li.on")?.scrollIntoView({ block: "nearest" }); });

  /** where it runs, or null (with the reason shown) when the host is missing */
  function location(): string | null {
    if (local) return "local";
    if (!host.trim()) { error = "Pick or type a host."; return null; }
    return `ssh:${host.trim()}`;
  }
  async function run(what: string, loc: string, f: () => Promise<void>, onError: (e: string) => void) {
    busy = loc === "local" ? what : `Connecting to ${hostOf(loc)}… (the first connection installs the agent)`;
    try { await f(); } catch (e) { if (e !== CANCELLED) onError(String(e)); } finally { busy = ""; }
  }
  /** Open Repository / New Repository: the typed folder, else (this computer) the folder dialog */
  async function folderAction(kind: "open" | "new") {
    if (busy) return;
    error = "";
    const loc = location();
    if (!loc) return;
    let p = path.trim();
    if (!p && local) p = (await api.pickDir()) ?? "";
    if (!p) { error = local ? "Choose a folder." : "Type the folder on the host."; return; }
    if (kind === "new" && folderPathError(p)) { error = folderPathError(p); return; }
    await run(kind === "open" ? "Opening…" : "Creating…", loc, () => (kind === "open" ? openRepo(loc, p) : initRepo(loc, p)), (e) => (error = e));
  }
  const submitOpen = (e: SubmitEvent) => { e.preventDefault(); void folderAction("open"); };
  async function browse() { const d = await api.pickDir(); if (d) path = d; }
  async function browseDest() { const d = await api.pickDir(); if (d) dest = d; }

  const guess = $derived(cloneName(url));
  async function clone(e: SubmitEvent) {
    e.preventDefault();
    if (cloning) return;
    cloneError = cloneUrlError(url) || folderPathError(dest) || (name.trim() || guess ? folderNameError(name.trim() || guess) : "Enter a repository name.");
    if (cloneError) return;
    const loc = local ? "local" : host.trim() ? `ssh:${host.trim()}` : null;
    if (!loc) { cloneError = "Pick or type a host."; return; }
    // not `busy`: the console shows progress, and opening other repositories meanwhile is fine
    try { await cloneRepo(loc, url.trim(), dest.trim(), name.trim() || null); } catch (err) { if (err !== CANCELLED) cloneError = String(err); }
  }
</script>

<main class="locations">
  <div class="card newtab">
    <div class="seg two" role="tablist">
      <button type="button" role="tab" class:on={local} aria-selected={local} onclick={() => (mode = "local")}>This computer</button>
      <button type="button" role="tab" class:on={!local} aria-selected={!local} onclick={() => (mode = "ssh")}>Remote (SSH)</button>
    </div>
    {#if !local}
      <label>Host <input list="ssh-hosts" bind:value={host} placeholder="example-host  or  user@host" autocomplete="off" spellcheck="false" /></label>
      <datalist id="ssh-hosts">{#each hosts as h}<option value={h}></option>{/each}</datalist>
    {/if}

    <form class="sect" onsubmit={submitOpen}>
      <h2>{local ? "Local Repositories" : "Remote Repositories"}</h2>
      <label>Folder
        <span class="field">
          <input bind:value={path} placeholder="~/projects/my-repo" spellcheck="false" />
          {#if local}<button type="button" class="btn" onclick={browse}>Browse…</button>{/if}
        </span>
      </label>
      <div class="pair">
        <button class="primary" disabled={!!busy}>Open Repository</button>
        <button type="button" class="btn" disabled={!!busy} onclick={() => folderAction("new")}>New Repository</button>
      </div>
      {#if busy}<p class="hint" role="status">{busy}</p>{/if}
      {#if error}<p class="err" role="alert">{error}</p>{/if}
      <button type="button" class="link" onclick={showAddRepos}>Add Repositories from Folder…</button>
    </form>

    {#if app.recent.length}
      <section class="sect recent">
        <h2>Recent Repositories</h2>
        <input class="search" type="search" bind:this={search} bind:value={query} onkeydown={searchKey} placeholder="Filter by name, alias or path" aria-label="Filter recent repositories" autocomplete="off" spellcheck="false" />
        {#if shown.length}
          <ul>
            {#each shown as r, i (r.location + r.path)}
              <li class:on={filtering && i === index}><button disabled={!!busy} tabindex="-1" onclick={() => openRecent(r)}>
                <svg class="i"><use href={hostOf(r.location) ? "#i-server" : "#i-folder"} /></svg>
                <span class="p">{r.path}</span><span class="h">{hostOf(r.location) || "local"}</span>
              </button></li>
            {/each}
          </ul>
        {:else}<p class="hint" role="status">No matches</p>{/if}
        {#if !filtering && inMode.length > RECENT_SHOWN}<button class="link" onclick={() => runCommand("quick_switch_repository")}>View More…</button>{/if}
        <button class="link" onclick={() => runCommand("show_dashboard")}>Dashboard: status of all {inMode.length === 1 ? "1 repository" : `${inMode.length} repositories`}…</button>
      </section>
    {/if}

    <form class="sect clone" onsubmit={clone} aria-label="Clone Repository">
      <h2>Clone Repository</h2>
      <label>Source URL <input id="clone-url" bind:value={url} placeholder="https://github.com/user/repo.git  or  git@host:user/repo.git" autocomplete="off" spellcheck="false" /></label>
      <label>Repository Name <input bind:value={name} placeholder={guess || "folder name"} autocomplete="off" spellcheck="false" /></label>
      <label>Destination Path
        <span class="field">
          <input bind:value={dest} placeholder="~/projects" spellcheck="false" />
          {#if local}<button type="button" class="btn" aria-label="Choose destination folder" onclick={browseDest}>…</button>{/if}
        </span>
      </label>
      {#if cloneError}<p class="err" role="alert">{cloneError}</p>{/if}
      <div class="end"><button class="primary" disabled={cloning}>{cloning ? "Cloning…" : "Clone"}</button></div>
    </form>
  </div>
  {#if setupJobs}<div class="setup-console"><Console repo="locations" /></div>{/if}
</main>
