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
    void init();
    startLlm();
    // macOS dims an inactive window; so do we. Focus also picks up edits to the user's command/menu files.
    const dim = (on: boolean) => () => document.documentElement.classList.toggle("inactive", on);
    const onBlur = dim(true);
    const onFocus = () => { dim(false)(); void loadUserConfig(); };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => { offMenu(); offKeys(); offCommands(); window.removeEventListener("blur", onBlur); window.removeEventListener("focus", onFocus); };
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
