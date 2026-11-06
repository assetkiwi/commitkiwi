<script lang="ts">
  // The repository dashboard: every repository on the New Tab page's recent list (bulk-added and remote ones too)
  // with its branch, changed files, ahead/behind, last commit and a state badge, without opening tabs. Statuses are
  // reads (`Overview`: never queued, at most READ_LIMIT at once, READ_TIMEOUT_MS each, a host that does not answer is
  // not asked again this round). Fetch and Pull are console jobs through `runGit`, keyed like the repository's tab:
  // they queue behind that tab's own writes and show in its console.
  import { untrack } from "svelte";
  import { api } from "../lib/api";
  import { CANCELLED, cancelJob, journal, runGit } from "../lib/jobs.svelte";
  import { FETCH_LIMIT, READ_LIMIT, READ_TIMEOUT_MS, isOffline, pool, pullError, pullRefusal, sortRows, stateOf, withTimeout, type SortBy } from "../lib/dashboard";
  import { filterRecent } from "../lib/recentFilter";
  import { fuzzy } from "../lib/fuzzy";
  import { ago, baseName, fullDate } from "../lib/format";
  import { app, hostOf, openRepo, reloadTab, type Recent } from "../lib/state.svelte";
  import type { Overview, Req } from "../lib/types";

  /** `note`: the last action's outcome (`failed`: in red); `busy`: what runs now */
  interface Row { o: Overview | null; error: string; offline: boolean; busy: string; note: string; failed: boolean }
  const EMPTY: Row = { o: null, error: "", offline: false, busy: "", note: "", failed: false };
  const key = (r: Recent) => `${r.location}|${r.path}`;
  let rows = $state<Record<string, Row>>({});
  const get = (r: Recent): Row => rows[key(r)] ?? EMPTY;
  const set = (r: Recent, patch: Partial<Row>) => { rows[key(r)] = { ...get(r), ...patch }; };

  let query = $state("");
  let sort = $state<SortBy>("name");
  const alias = (r: Recent) => app.aliases[key(r)] ?? "";
  const name = (r: Recent) => alias(r) || baseName(r.path);
  const shown = $derived(sortRows(filterRecent(app.recent, query, alias, fuzzy), sort, name, (r) => get(r).o));

  async function read(r: Recent, dead?: Set<string>): Promise<void> {
    if (app.links[r.location] !== undefined || dead?.has(r.location)) { set(r, { o: null, error: "the host did not answer", offline: true }); return; }
    try {
      set(r, { o: await withTimeout(api.overview(r.location, r.path), READ_TIMEOUT_MS), error: "", offline: false });
    } catch (e) {
      const error = String(e), offline = isOffline(r.location, error);
      if (offline) dead?.add(r.location);
      set(r, { o: null, error, offline });
    }
  }
  let reading = $state(false);
  let round = 0;
  async function refresh() {
    const mine = ++round;
    reading = true;
    const dead = new Set<string>();
    await pool([...app.recent], READ_LIMIT, (r) => read(r, dead), () => mine !== round);
    if (mine === round) reading = false;
  }
  // each time the dashboard is shown: statuses are cheap reads, and tabs may have changed them meanwhile
  $effect(() => { if (app.active === "dashboard") untrack(() => void refresh()); });

  const tabOf = (r: Recent) => app.tabs.find((t) => t.id === key(r));
  /** Fetch jobs running now: Cancel in Fetch All stops them */
  const fetching = new Set<number>();
  /** Resolves true when the job succeeded. */
  async function sync(r: Recent, verb: "fetch" | "pull"): Promise<boolean> {
    const o = get(r).o;
    const refused = verb === "pull" ? pullRefusal(o) : null;
    if (refused) { set(r, { note: refused, failed: true }); return false; }
    set(r, { busy: verb === "fetch" ? "Fetching…" : "Pulling…", note: "", failed: false });
    const req: Req = verb === "fetch" ? { Fetch: { repo: r.path, flags: [], remote: null } } : { Pull: { repo: r.path, flags: ["--ff-only"] } };
    const done = runGit(tabOf(r) ?? { id: key(r), location: r.location }, verb === "fetch" ? "git fetch" : "git pull --ff-only", req);
    const id = journal.jobs.at(-1)!.id; // runGit journals the job before it returns
    if (verb === "fetch") fetching.add(id);
    let ok = false;
    try {
      await done;
      set(r, { busy: "", note: verb === "fetch" ? "Fetched" : "Pulled" });
      ok = true;
    } catch (e) {
      set(r, { busy: "", failed: true, note: e === CANCELLED ? "Cancelled" : verb === "pull" ? pullError(String(e), o) : String(e) });
    }
    fetching.delete(id);
    const t = tabOf(r);
    if (t) void reloadTab(t).catch(() => {});
    await read(r);
    return ok;
  }

  /** Fetch All: `done` finished (any outcome), `ok` of them fetched */
  let all = $state<{ done: number; ok: number; total: number; cancelled: boolean; running: boolean } | null>(null);
  async function fetchAll() {
    const list = shown.filter((r) => !get(r).offline && !get(r).error && !get(r).busy);
    all = { done: 0, ok: 0, total: list.length, cancelled: false, running: true };
    const run = all;
    for (const r of list) set(r, { busy: "Waiting…", note: "", failed: false });
    await pool(list, FETCH_LIMIT, async (r) => { if (await sync(r, "fetch")) run.ok++; run.done++; }, () => run.cancelled);
    for (const r of list) if (get(r).busy === "Waiting…") set(r, { busy: "", note: "Cancelled", failed: true });
    run.running = false;
  }
  function cancelAll() {
    if (!all) return;
    all.cancelled = true;
    for (const id of fetching) void cancelJob(id);
  }

  const open = (r: Recent) => openRepo(r.location, r.path).catch((e) => set(r, { note: String(e), failed: true }));
</script>

<main class="dashboard">
  <div class="db-bar">
    <h1>Repositories</h1>
    <input type="search" bind:value={query} placeholder="Filter by name, alias or path" aria-label="Filter repositories" autocomplete="off" spellcheck="false" />
    <label class="sub">Sort
      <select bind:value={sort} aria-label="Sort repositories">
        <option value="name">Name</option>
        <option value="dirty">Changes first</option>
        <option value="activity">Last activity</option>
      </select>
    </label>
    <span class="grow"></span>
    {#if all?.running}
      <span class="db-progress" role="status"><progress max={all.total} value={all.done}></progress>Fetching {all.done} of {all.total}…</span>
      <button class="btn" disabled={all.cancelled} onclick={cancelAll}>Cancel</button>
    {:else}
      {#if all}<span class="sub" role="status">{all.cancelled ? "Cancelled: " : ""}Fetched {all.ok} of {all.total}{!all.cancelled && all.ok < all.total ? ` · ${all.total - all.ok} failed` : ""}</span>{/if}
      <button class="btn" disabled={reading} onclick={refresh}>{reading ? "Refreshing…" : "Refresh"}</button>
      <button class="primary" disabled={!shown.length} onclick={fetchAll}>Fetch All</button>
    {/if}
  </div>
  {#if !app.recent.length}
    <p class="hint pad">No repositories yet: open or add some on the New Tab page.</p>
  {:else if !shown.length}
    <p class="hint pad" role="status">No repository matches the filter.</p>
  {:else}
    <div class="db-scroll">
      <table class="db-table">
        <thead><tr><th>Repository</th><th>Branch</th><th>Changes</th><th>Upstream</th><th>Last commit</th><th>State</th><th></th></tr></thead>
        <tbody>
          {#each shown as r (key(r))}
            {@const x = get(r)}
            {@const st = stateOf(x.o, x.error || null, x.offline)}
            <tr aria-label={name(r)}>
              <td title={`${hostOf(r.location) || "local"}: ${r.path}`}><div class="db-name">
                <svg class="i"><use href={hostOf(r.location) ? "#i-server" : "#i-folder"} /></svg>
                <span><b>{name(r)}</b><span class="sub">{hostOf(r.location) ? `${hostOf(r.location)}:` : ""}{r.path}</span></span>
              </div></td>
              <td class="mono">{x.o ? (x.o.branch ?? "(detached)") : ""}</td>
              <td class="num">{x.o ? `${x.o.changed}${x.o.truncated ? "+" : ""}` : ""}</td>
              <td class="num" title={x.o?.upstream ?? ""}>{x.o ? (x.o.upstream ? `↑${x.o.ahead} ↓${x.o.behind}` : "none") : ""}</td>
              <td class="db-last">{#if x.o?.time}<span title={fullDate(x.o.time)}>{ago(x.o.time)}</span> <span class="sub">{x.o.subject}</span>{/if}</td>
              <td class="db-state">
                <span class="db-badge {st}">{st}</span>
                {#if x.busy || x.note || x.error}<span class="sub db-status" class:err={x.failed || (!x.busy && !x.note && !x.offline)} title={x.note || x.error}>{x.busy || x.note || x.error}</span>{/if}
              </td>
              <td class="db-actions">
                <button class="btn sm" aria-label={`Fetch ${name(r)}`} disabled={!!x.busy || !x.o} onclick={() => sync(r, "fetch")}>Fetch</button>
                <button class="btn sm" aria-label={`Pull ${name(r)}`} title="Fast-forward only" disabled={!!x.busy || !x.o} onclick={() => sync(r, "pull")}>Pull</button>
                <button class="btn sm" aria-label={`Open ${name(r)}`} onclick={() => open(r)}>Open</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</main>
