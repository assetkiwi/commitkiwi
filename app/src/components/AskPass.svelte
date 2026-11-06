<script lang="ts">
  // git/ssh asking for a password, passphrase or host-key confirmation (local repos; see runner::askpass).
  // The answer goes straight back to git: never stored, logged or put in the journal.
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { isConfirmPrompt, isSecretPrompt } from "../lib/askpass";
  import { registerCommand } from "../lib/commands";
  import { ui } from "../lib/ui.svelte";

  const queue = $state<{ id: number; prompt: string }[]>([]);
  let value = $state("");
  let input = $state<HTMLInputElement>();
  const cur = $derived(queue[0]);
  const secret = $derived(!!cur && isSecretPrompt(cur.prompt));

  onMount(() => {
    const off = api.onAskpass((id, prompt) => { queue.push({ id, prompt }); });
    return () => void off.then((u) => u());
  });
  $effect(() => { ui.modes.askpass_visible = !!cur; });
  $effect(() => { if (cur) return registerCommand("askpass_cancel", { run: () => reply(null) }); });
  $effect(() => { if (cur) queueMicrotask(() => input?.focus()); });

  function reply(answer: string | null) {
    const c = queue.shift();
    value = "";
    if (c) void api.askpassAnswer(c.id, answer);
  }
</script>

{#if cur}
  <div class="scrim" role="presentation"></div>
  <div class="overlay askpass" role="dialog" aria-label="Authentication">
    <form class="ar-form" onsubmit={(e) => { e.preventDefault(); reply(value); }}>
      <h1>Authentication</h1>
      <pre class="ap-prompt">{cur.prompt.trim()}</pre>
      <input bind:this={input} bind:value type={secret ? "password" : "text"} aria-label={cur.prompt.trim()} data-control="askpass_input"
        autocomplete="off" spellcheck="false" placeholder={isConfirmPrompt(cur.prompt) ? "yes, no or the fingerprint" : ""} />
      <div class="ar-bar end">
        <button type="button" class="btn" onclick={() => reply(null)}>Cancel</button>
        <button class="primary">OK</button>
      </div>
    </form>
  </div>
{/if}
