<script lang="ts">
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { api } from "../lib/api";
  import type { Tab } from "../lib/state.svelte";
  import type { TreeEntry } from "../lib/types";

  const CAP = 1000; // entries rendered per directory
  let { tab, oid, reveal, selected, onopen, oncontext }: {
    tab: Tab; oid: string; reveal: string | null; selected: string | null; onopen: (path: string) => void;
    /** right-click on a file */
    oncontext?: (e: MouseEvent, path: string) => void;
  } = $props();

  let children = $state.raw(new Map<string, TreeEntry[]>());
  let error = $state("");
  const open = new SvelteSet<string>();
  const loading = new Set<string>();

  async function load(path: string): Promise<void> {
    if (children.has(path) || loading.has(path)) return;
    loading.add(path);
    const at = oid;
    try {
      const entries = await api.tree(tab.location, tab.path, at, path);
      if (at === oid) children = new Map(children).set(path, entries); // ignore answers for a commit we left
    } catch (e) {
      error = String(e);
    } finally {
      loading.delete(path);
    }
  }

  // New commit => fresh tree.
  $effect(() => {
    void oid;
    untrack(() => { children = new Map(); open.clear(); loading.clear(); error = ""; load(""); });
  });

  // Expand the folders leading to `reveal`.
  $effect(() => {
    const path = reveal;
    if (!path) return;
    untrack(async () => {
      const parts = path.split("/").slice(0, -1);
      for (let k = 1; k <= parts.length; k++) {
        const dir = parts.slice(0, k).join("/");
        await load(dir);
        open.add(dir);
      }
    });
  });

  async function toggle(path: string) {
    if (open.has(path)) { open.delete(path); return; }
    open.add(path);
    await load(path);
  }
</script>

{#snippet level(path: string, depth: number)}
  {@const entries = children.get(path) ?? []}
  {#each entries.slice(0, CAP) as e (e.name)}
    {@const full = path ? `${path}/${e.name}` : e.name}
    {#if e.kind === "tree"}
      <button class="tn" style:padding-left="{8 + depth * 14}px" aria-expanded={open.has(full)} onclick={() => toggle(full)}>
        <svg class="i chev" class:open={open.has(full)}><use href="#i-chevron" /></svg><svg class="i"><use href="#i-folder" /></svg><span class="t">{e.name}</span>
      </button>
      {#if open.has(full)}{@render level(full, depth + 1)}{/if}
    {:else if e.kind === "commit"}
      <div class="tn off" style:padding-left="{8 + depth * 14 + 18}px" title="Submodule"><svg class="i"><use href="#i-box" /></svg><span class="t">{e.name}</span></div>
    {:else}
      <button class="tn" class:sel={selected === full} style:padding-left="{8 + depth * 14 + 18}px" onclick={() => onopen(full)} oncontextmenu={(e) => oncontext?.(e, full)}>
        <svg class="i"><use href="#i-file" /></svg><span class="t">{e.name}</span>
      </button>
    {/if}
  {/each}
  {#if entries.length > CAP}<div class="tn off" style:padding-left="{8 + depth * 14 + 18}px">+{entries.length - CAP} more</div>{/if}
{/snippet}

<div class="tree" role="tree" aria-label="Files">
  {#if error}<p class="err pad" role="alert">{error}</p>{/if}
  {#if !children.has("") && !error}<p class="hint pad">Loading…</p>{/if}
  {@render level("", 0)}
</div>
