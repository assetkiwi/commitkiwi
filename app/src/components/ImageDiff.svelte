<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import type { Tab } from "../lib/state.svelte";
  import type { FileRev, ImageData } from "../lib/types";
  import { showContextMenu } from "../lib/mainMenu";
  import { IMAGE } from "../lib/contextMenus";

  // Either side may be missing: an added image has no "before", a deleted one no "after".
  let { tab, before, after }: {
    tab: Tab;
    before: FileRev | null;
    after: FileRev | null;
  } = $props();

  let imgs = $state<{ before: ImageData | null; after: ImageData | null }>({ before: null, after: null });
  let error = $state("");
  let loaded = $state(false);

  onMount(async () => {
    try {
      const get = (s: FileRev | null) => (s ? api.image(tab.location, tab.path, s.rev, s.path) : Promise.resolve(null));
      const [b, a] = await Promise.all([get(before), get(after)]);
      imgs = { before: b, after: a };
    } catch (e) {
      error = String(e);
    }
    loaded = true;
  });
  const src = (i: ImageData) => `data:${i.mime};base64,${i.base64}`;
  const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
</script>

{#if error}
  <p class="err pad" role="alert">{error}</p>
{:else if !loaded}
  <p class="hint pad">Loading image…</p>
{:else}
  <div class="imgdiff" role="presentation" oncontextmenu={(e) => showContextMenu(e, IMAGE, { path: (after ?? before)!.path, exists: !!after })}>
    {#each [["Before", imgs.before], ["After", imgs.after]] as const as [label, img]}
      <figure>
        <figcaption>{label}{#if img} · {kb(img.size)}{/if}</figcaption>
        {#if img}<div class="checker"><img src={src(img)} alt="{label} version" /></div>{:else}<p class="hint">{label === "Before" ? "Added" : "Deleted"}</p>{/if}
      </figure>
    {/each}
  </div>
{/if}
