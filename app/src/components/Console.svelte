<script lang="ts">
  // The console panel: this repository's git commands (newest first) on the left, the selected one's output
  // on the right. Queued and running commands can be cancelled.
  import { cancelJob, journal } from "../lib/jobs.svelte";
  import { showContextMenu } from "../lib/mainMenu";
  import { CONSOLE_JOB } from "../lib/contextMenus";

  let { repo }: { repo: string } = $props();
  const jobs = $derived(journal.jobs.filter((j) => j.repo === repo).reverse());
  let picked = $state<number | null>(null);
  const sel = $derived(jobs.find((j) => j.id === picked) ?? jobs[0]);
  const out = $derived(sel?.output.replace(/\r$/, "") ?? "");
  const STATUS = { queued: "Queued", running: "Running…", ok: "Success", failed: "Failed", cancelled: "Cancelled" };
  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
</script>

<div class="console-panel" role="region" aria-label="Console">
  <div class="jobs" role="list" aria-label="Commands">
    {#each jobs as j (j.id)}
      <div class="job {j.status}" class:on={j === sel} role="listitem"
        oncontextmenu={(e) => showContextMenu(e, CONSOLE_JOB, { job: j.id, label: j.label, output: j.output || j.error, active: (j.status === "queued" || j.status === "running") && !j.cancelling })}>
        <button class="pick" aria-current={j === sel} onclick={() => (picked = j.id)}>
          <span class="k">Command</span><span class="v cmd">{j.label}</span>
          <span class="k">Status</span><span class="v stat">{STATUS[j.status]}{j.cancelling && j.status === "running" ? " (cancelling)" : ""}</span>
          <span class="k">Date</span><span class="v">{time(j.start ?? j.queued)}</span>
        </button>
        {#if j.status === "queued" || j.status === "running"}
          <button class="btn sm cancel" disabled={j.cancelling} aria-label="Cancel {j.label}" onclick={() => cancelJob(j.id)}>Cancel</button>
        {/if}
      </div>
    {:else}
      <p class="none">No commands run yet</p>
    {/each}
  </div>
  <pre class="out mono" aria-label="Output">{#if out}{out}{/if}{#if sel?.error && !out.includes(sel.error)}<span class="err">{out && !out.endsWith("\n") ? "\n" : ""}{sel.error}</span>{/if}{#if !out && !sel?.error}<span class="none">No Output</span>{/if}</pre>
</div>
