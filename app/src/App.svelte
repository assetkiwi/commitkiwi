<script lang="ts">
  import { onMount } from "svelte";
  import { app, hostOf, init } from "./lib/state.svelte";
  import { registerAppCommands } from "./lib/appCommands";
  import { installKeys, loadKeymap } from "./lib/keys.svelte";
  import { loadUserConfig } from "./lib/userConfig";
  import { installNativeMenu, nativeMenu } from "./lib/mainMenu";
  import MenuBar from "./components/MenuBar.svelte";
  import Overlay from "./components/Overlay.svelte";
  import Preferences from "./components/Preferences.svelte";
  import AddRepos from "./components/AddRepos.svelte";
  import AskPass from "./components/AskPass.svelte";
  import ModelDownload from "./components/ModelDownload.svelte";
  import { startLlm } from "./lib/llm.svelte";
  import { checkForUpdates, dismissUpdate, installUpdate, openReleases, update } from "./lib/updater.svelte";
  import PopupMenu from "./components/PopupMenu.svelte";
  import TabBar from "./components/TabBar.svelte";
  import Locations from "./components/Locations.svelte";
  import RepoView from "./components/RepoView.svelte";
  import Dashboard from "./components/Dashboard.svelte";

  onMount(() => {
    const offCommands = registerAppCommands();
    const offKeys = installKeys();
    const offMenu = installNativeMenu();
    void loadKeymap();
    void loadUserConfig();
    // the update check waits for the saved preferences (it may be switched off)
    void init().then(() => { if (app.prefs.update_check) void checkForUpdates(false); });
    startLlm();
    // focus picks up edits to the user's command/menu files
    const onFocus = () => void loadUserConfig();
    window.addEventListener("focus", onFocus);
    // ⌘A / Ctrl+A after clicking in a diff or file view selects only that view's text, not the whole window
    // (WKWebView offers the key to the page before the Edit menu's Select All)
    let lastDown: Node | null = null;
    const onDown = (e: MouseEvent) => { lastDown = e.target as Node; };
    const onSelectAll = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "a" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if ((e.target as HTMLElement).closest?.("input, textarea, [contenteditable]")) return;
      const from = lastDown ?? document.getSelection()?.anchorNode;
      const box = (from instanceof Element ? from : from?.parentElement)?.closest(".diff");
      if (!box) return;
      e.preventDefault();
      document.getSelection()?.selectAllChildren(box);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onSelectAll, true);
    return () => {
      offMenu(); offKeys(); offCommands(); window.removeEventListener("focus", onFocus);
      window.removeEventListener("mousedown", onDown, true); window.removeEventListener("keydown", onSelectAll, true);
    };
  });
  const tab = $derived(app.tabs.find((t) => t.id === app.active));
  // in a fixed order (by id), not the tab bar's: reordering tabs must not move (and so reset) a mounted view
  const views = $derived([...app.tabs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  // mounted on first use, then kept like a tab (a Fetch all goes on while another tab is shown)
  let dashboard = $state(false);
  $effect(() => { if (app.active === "dashboard") dashboard = true; });
  const home = /^\/(Users|home)\/[^/]+/;
  const title = $derived(tab ? `${hostOf(tab.location) ? `${hostOf(tab.location)}:` : ""}${tab.path.replace(home, "~")}` : "commit.kiwi");
  $effect(() => { document.title = title; });
</script>

<header class="titlebar" data-tauri-drag-region>
  {#if !nativeMenu}<MenuBar />{/if}
  {#if tab}<svg class="i"><use href={hostOf(tab.location) ? "#i-server" : "#i-folder"} /></svg>{/if}<b data-tauri-drag-region>{title}</b>
</header>
<TabBar />
<Preferences />
<Overlay />
<AddRepos />
<AskPass />
<ModelDownload />
<PopupMenu />
{#if update.version}
  <div class="banner update" role="status">
    <span class="t">commit.kiwi {update.version} is available.</span>
    {#if update.busy}<span>{update.busy}</span>
    {:else if update.installable}<button class="btn sm" onclick={installUpdate}>Install and Restart</button>
    {:else}<button class="btn sm" onclick={openReleases}>Download…</button>{/if}
    <button class="ib" aria-label="Dismiss" disabled={!!update.busy} onclick={dismissUpdate}><svg class="i"><use href="#i-x" /></svg></button>
  </div>
{/if}
{#if app.notice}
  <div class="banner" role="status">{app.notice}<button class="ib" aria-label="Dismiss" onclick={() => (app.notice = "")}><svg class="i"><use href="#i-x" /></svg></button></div>
{/if}
<!-- every open repo stays mounted, the others hidden in place: switching back finds it as it was (scroll
     positions, selection, loaded pages), with nothing to reload -->
<div class="tabstack">
  {#each views as t (t.id)}
    <div class="tabview" class:off={t.id !== app.active} inert={t.id !== app.active}><RepoView tab={t} /></div>
  {/each}
  {#if dashboard}<div class="tabview" class:off={app.active !== "dashboard"} inert={app.active !== "dashboard"}><Dashboard /></div>{/if}
  {#if !tab && app.active !== "dashboard" && app.ready}<div class="tabview"><Locations /></div>{/if}
</div>
