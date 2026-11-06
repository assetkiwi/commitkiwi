<script lang="ts">
  import { api } from "../lib/api";
  import { addRecentRepos, app } from "../lib/state.svelte";
  import { hideOverlay, ui } from "../lib/ui.svelte";

  let mode = $state<"local" | "ssh">("local");
  let host = $state("");
  let root = $state("");
  let depth = $state(3);
  let hosts = $state<string[]>([]);
  let busy = $state(false);
  let error = $state("");
  let found = $state<{ location: string; paths: string[]; truncated: boolean } | null>(null);
  let picked = $state<string[]>([]);

  const location = $derived(mode === "local" ? "local" : `ssh:${host.trim()}`);
  // already in the switcher (recent or open in a tab) for the scanned location
  const known = $derived(new Set([...app.recent, ...app.tabs].filter((r) => r.location === found?.location).map((r) => r.path)));
  const fresh = $derived(found ? found.paths.filter((p) => !known.has(p)) : []);

  $effect(() => { if (ui.addRepos) api.sshHosts().then((h) => (hosts = h)).catch(() => {}); });

  async function scan(e: SubmitEvent) {
    e.preventDefault();
    if (mode === "ssh" && !host.trim()) { error = "Pick or type a host."; return; }
    busy = true; error = ""; found = null;
    const loc = location;
    try {
      const s = await api.scanRepos(loc, root.trim(), Math.max(1, Math.min(8, Math.round(depth) || 3)));
      found = { location: loc, ...s };
      picked = s.paths.filter((p) => !known.has(p));
    } catch (err) { error = String(err); } finally { busy = false; }
  }
  async function browse() { const d = await api.pickDir(); if (d) root = d; }
  function add() {
    if (!found || !picked.length) return;
    addRecentRepos(found.location, picked);
    app.notice = `Added ${picked.length} repositor${picked.length === 1 ? "y" : "ies"} to Switch Repository.`;
    hideOverlay();
  }
</script>

{#if ui.addRepos}
  <div class="scrim" role="presentation" onmousedown={hideOverlay}></div>
  <div class="overlay add-repos" role="dialog" aria-label="Add Repositories from Folder">
    <form class="ar-form" onsubmit={scan}>
      <h1>Add Repositories from Folder</h1>
      <div class="seg two" role="tablist">
        <button type="button" role="tab" class:on={mode === "local"} aria-selected={mode === "local"} onclick={() => (mode = "local")}>This computer</button>
        <button type="button" role="tab" class:on={mode === "ssh"} aria-selected={mode === "ssh"} onclick={() => (mode = "ssh")}>Remote (SSH)</button>
      </div>
      {#if mode === "ssh"}
        <label>Host <input list="ar-hosts" bind:value={host} placeholder="example-host  or  user@host" autocomplete="off" spellcheck="false" /></label>
        <datalist id="ar-hosts">{#each hosts as h}<option value={h}></option>{/each}</datalist>
      {/if}
      <div class="field">
        <label class="grow">Folder
          <span class="field">
            <input bind:value={root} placeholder="~/projects" spellcheck="false" />
            {#if mode === "local"}<button type="button" class="btn" onclick={browse}>Browse…</button>{/if}
          </span>
        </label>
        <label>Depth <input class="depth" type="number" min="1" max="8" bind:value={depth} /></label>
      </div>
      {#if error}<p class="err" role="alert">{error}</p>{/if}
      <button class="primary wide" disabled={busy || !root.trim()}>{busy ? "Scanning…" : "Scan"}</button>
    </form>
    {#if found}
      <div class="ar-bar">
        <span class="sub">{found.paths.length} found{found.truncated ? " (scan stopped early: narrow the folder or depth)" : ""}</span>
        <button class="btn sm" disabled={!fresh.length} onclick={() => (picked = [...fresh])}>Select all</button>
        <button class="btn sm" disabled={!picked.length} onclick={() => (picked = [])}>Select none</button>
      </div>
      <ul class="ar-list">
        {#each found.paths as p (p)}
          <li class:known={known.has(p)}>
            <label>
              {#if known.has(p)}<input type="checkbox" checked disabled />{:else}<input type="checkbox" bind:group={picked} value={p} />{/if}
              <span class="p">{p}</span>{#if known.has(p)}<span class="sub">already added</span>{/if}
            </label>
          </li>
        {:else}
          <li class="none sub">No repositories found.</li>
        {/each}
      </ul>
      <div class="ar-bar end">
        <button class="btn" onclick={hideOverlay}>Cancel</button>
        <button class="primary" disabled={!picked.length} onclick={add}>Add {picked.length} repositor{picked.length === 1 ? "y" : "ies"}</button>
      </div>
    {/if}
  </div>
{/if}
