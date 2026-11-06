<script lang="ts">
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { runCommand } from "../lib/commands";
  import { platform } from "../lib/keys.svelte";
  import { filterByName, fullRef, refTree, type RefNode } from "../lib/refs";
  import type { Tab } from "../lib/state.svelte";
  import { showContextMenu } from "../lib/mainMenu";
  import { BRANCH, BRANCH_FOLDER, REMOTE, REMOTE_BRANCH, REMOTE_BRANCH_FOLDER, SECTIONS, STASH, SUBMODULE, TAG, WORKTREE, joinMenus, remoteTags } from "../lib/contextMenus";
  import { splitRemote } from "../lib/branchOps";
  import { requestNoun } from "../lib/forge";
  import { ui } from "../lib/ui.svelte";
  import type { RefItem, RefKind, Stash } from "../lib/types";

  let { tab, onjump, onstash, filter = false, onfilterclose = () => {} }: {
    tab: Tab; onjump: (oid: string) => void;
    /** a stash row was clicked: show it in the details pane */
    onstash: (s: Stash) => void;
    /** the filter box is open (toggle_ref_filter) */
    filter?: boolean; onfilterclose?: () => void;
  } = $props();
  const CAP = 300; // rows per section: keeps the DOM small for repos with thousands of tags
  let q = $state("");
  let input = $state<HTMLInputElement>();
  $effect(() => { if (filter) input?.focus(); else q = ""; });

  const of = (k: RefKind): RefItem[] => filterByName(tab.refs.refs.filter((r) => r.kind === k), q);
  const branches = $derived(of("branch"));
  const remotes = $derived(of("remote"));
  const tags = $derived(of("tag"));
  const stashes = $derived(tab.refs.stashes.filter((s) => s.message.toLowerCase().includes(q.trim().toLowerCase())));
  const submodules = $derived(filterByName(tab.refs.submodules.map((m) => ({ ...m, name: m.path })), q));
  const worktrees = $derived(filterByName(tab.refs.worktrees.map((w) => ({ ...w, name: `${w.path} ${w.branch ?? ""}` })), q));
  const hidden = $derived(new Set(tab.hidden));
  const filtering = $derived(q.trim() !== "");

  // Sections start open unless huge; folders start closed except the ones holding the current branch.
  const closed = new SvelteSet<string>(untrack(() => tab.refs.refs.filter((r) => r.kind === "tag").length > 50) ? ["tag"] : []);
  const head = untrack(() => tab.refs.refs.find((r) => r.head)?.name ?? "");
  const open = new SvelteSet<string>(head.split("/").slice(0, -1).map((_, k, a) => `branch:${a.slice(0, k + 1).join("/")}`));
  const flip = (s: SvelteSet<string>, k: string) => (s.has(k) ? s.delete(k) : s.add(k));

  const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
  const alt = platform === "mac" ? "Option" : "Alt";
  function eyeTitle(r: RefItem): string {
    const what = r.kind === "tag" ? "Tag" : "Branch";
    return hidden.has(fullRef(r.kind, r.name)) ? `Show ${what} in Graph` : `Hide ${what} in Graph\n${alt} click to show only this ${what.toLowerCase()}`;
  }
  function eye(e: MouseEvent, r: RefItem) {
    const ref = fullRef(r.kind, r.name);
    runCommand(e.altKey ? "hide_all_refs_except" : hidden.has(ref) ? "show_ref" : "hide_ref", { ref });
  }
  // ---- context menus (contextMenus.ts): each gets its target as vars
  /** a section's menu: right-click on the header, or its gear button */
  const sectionMenu = (key: string) => (e: MouseEvent) =>
    showContextMenu(e.type === "contextmenu" ? e : (e.currentTarget as HTMLElement), SECTIONS[key] ?? [], { uninitialized: tab.refs.submodules.some((m) => !m.initialized) });
  function refMenu(e: MouseEvent, r: RefItem) {
    const ref = fullRef(r.kind, r.name);
    const vars = { branch: r.name, tag_name: r.name, ref, head: r.head, hidden: hidden.has(ref), any_hidden: hidden.size > 0, head_ref: tab.info.branch ?? "HEAD", request: requestNoun(ui.forgeKinds[tab.id] ?? null) };
    if (r.kind === "branch") showContextMenu(e, BRANCH, vars);
    else if (r.kind === "tag") showContextMenu(e, joinMenus(TAG, remoteTags(tab.refs.remotes)), vars);
    else {
      const local = splitRemote(tab.refs.remotes, r.name)?.[1];
      showContextMenu(e, REMOTE_BRANCH, { ...vars, tracked: tab.refs.refs.some((x) => x.kind === "branch" && x.name === local) });
    }
  }
  function folderMenu(e: MouseEvent, kind: RefKind, path: string) {
    if (kind === "remote" && tab.refs.remotes.includes(path)) showContextMenu(e, REMOTE, { remote: path });
    else if (kind !== "tag") showContextMenu(e, kind === "branch" ? BRANCH_FOLDER : REMOTE_BRANCH_FOLDER, { branch: path });
  }
</script>

{#snippet header(key: string, title: string, n: number, gear?: (e: MouseEvent) => void)}
  <div class="sh" role="presentation" oncontextmenu={sectionMenu(key)}>
    <button class="st" aria-expanded={!closed.has(key)} onclick={() => flip(closed, key)}>
      <svg class="i chev" class:open={!closed.has(key)}><use href="#i-chevron" /></svg>{title} ({n})
    </button>
    {#if gear}<button class="ib gear" aria-label="{title} options" title="{title} options" onclick={gear}><svg class="i"><use href="#i-gear" /></svg></button>{/if}
  </div>
{/snippet}

{#snippet refNodes(kind: RefKind, nodes: RefNode<RefItem>[], depth: number)}
  {#each nodes as n (n.path)}
    {#if n.item}
      {@const r = n.item}
      <li class:head={r.head} class:hid={hidden.has(fullRef(r.kind, r.name))} oncontextmenu={(e) => refMenu(e, r)}>
        <button class="go" style:padding-left="{14 + depth * 14}px" title="Go to {r.name}" onclick={() => onjump(r.oid)}><span class="t">{n.label}</span></button>
        <button class="eye" aria-label="{hidden.has(fullRef(r.kind, r.name)) ? 'Show' : 'Hide'} {r.name}" title={eyeTitle(r)} onclick={(e) => eye(e, r)}>
          <svg class="i"><use href={hidden.has(fullRef(r.kind, r.name)) ? "#i-eye-off" : "#i-eye"} /></svg>
        </button>
      </li>
    {:else}
      {@const k = `${kind}:${n.path}`}
      {@const isOpen = filtering || open.has(k)}
      <li class="folder" oncontextmenu={(e) => folderMenu(e, kind, n.path)}><button class="go" style:padding-left="{2 + depth * 14}px" aria-expanded={isOpen} onclick={() => flip(open, k)}>
        <svg class="i chev" class:open={isOpen}><use href="#i-chevron" /></svg><span class="t">{n.label}</span>
      </button></li>
      {#if isOpen}{@render refNodes(kind, n.children, depth + 1)}{/if}
    {/if}
  {/each}
{/snippet}

{#snippet refSection(key: RefKind, title: string, items: RefItem[])}
  {#if items.length || !filtering}
    {@render header(key, title, items.length, key === "branch" ? sectionMenu("branch") : undefined)}
    {#if !closed.has(key)}
      <ul>{@render refNodes(key, refTree(items.slice(0, CAP)), 0)}
        {#if items.length > CAP}<li class="more">+{items.length - CAP} more (use the filter)</li>{/if}
      </ul>
    {/if}
  {/if}
{/snippet}

<aside class="side" aria-label="Locations">
  {#if filter}
    <div class="sfilter">
      <input bind:this={input} bind:value={q} placeholder="Filter locations" aria-label="Filter locations" spellcheck="false" autocomplete="off"
        data-control="text_control filter_input locations_filter" />
      <button class="ib" aria-label="Close filter" onclick={onfilterclose}><svg class="i"><use href="#i-x" /></svg></button>
    </div>
  {/if}
  {@render refSection("branch", "BRANCHES", branches)}
  {@render refSection("remote", "REMOTES", remotes)}
  {@render refSection("tag", "TAGS", tags)}
  {#if stashes.length || !filtering}
    {@render header("stashes", "STASHES", stashes.length)}
    {#if !closed.has("stashes")}<ul>{#each stashes as s (s.name)}<li title="{s.name}: {s.message}" oncontextmenu={(e) => showContextMenu(e, STASH, { stash: s.name, oid: s.oid })}><button class="go stash" onclick={() => onstash(s)}><span class="t">{s.message}</span></button></li>{/each}</ul>{/if}
  {/if}
  {#if submodules.length || !filtering}
    {@render header("submodules", "SUBMODULES", submodules.length, sectionMenu("submodules"))}
    {#if !closed.has("submodules")}
      <ul>{#each submodules as m (m.path)}<li class="plain" class:off={!m.initialized} title={m.initialized ? m.path : `${m.path} (not initialized)`}
        oncontextmenu={(e) => showContextMenu(e, SUBMODULE, { submodule_name: base(m.path), submodule_path: m.path, initialized: m.initialized })}><span class="t">{m.path}</span></li>{/each}</ul>
    {/if}
  {/if}
  {#if worktrees.length || !filtering}
    {@render header("worktrees", "WORKTREES", worktrees.length, sectionMenu("worktrees"))}
    {#if !closed.has("worktrees")}
      <ul>{#each worktrees as w (w.path)}
        <li class:head={w.current} oncontextmenu={(e) => showContextMenu(e, WORKTREE, { worktree_name: base(w.path), worktree_path: w.path, current: w.current })}><button class="go" style:padding-left="14px" title={w.path} onclick={() => onjump(w.oid)}>
          <span class="t">{base(w.path)}</span>{#if w.branch}<span class="wb">{w.branch}</span>{/if}
        </button></li>
      {/each}</ul>
    {/if}
  {/if}
</aside>
