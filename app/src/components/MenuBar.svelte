<script lang="ts">
  // In-window menu bar for Linux and the browser preview (macOS uses the native one).
  import { windowMenus } from "../lib/mainMenu";
  import { showMenu, ui } from "../lib/ui.svelte";

  const captions = windowMenus().map((m) => m.caption);
  let open = $state("");
  $effect(() => { if (!ui.menu) open = ""; });
  function show(btn: HTMLElement, caption: string) {
    const m = windowMenus().find((x) => x.caption === caption);
    if (m) { showMenu(btn, m.items); open = caption; }
  }
</script>

<nav class="menubar" aria-label="Main menu">
  {#each captions as c}
    <button class:on={open === c} aria-haspopup="menu" onclick={(e) => show(e.currentTarget, c)}>{c}</button>
  {/each}
</nav>
