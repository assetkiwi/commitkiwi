<script lang="ts">
  // Create Pull/Merge Request…: through the user's own gh / glab where the repository lives (they hold the login),
  // else the provider's prefilled page in the browser on this computer. Optionally pushes the branch first (queued
  // before the create in the repo's console, so a failed push stops it).
  import { untrack } from "svelte";
  import { api } from "../lib/api";
  import { copy } from "../lib/clipboard";
  import { CANCELLED, runGit } from "../lib/jobs.svelte";
  import { splitRemote } from "../lib/branchOps";
  import { badListItem, isHttpsUrl, newRequestUrl, parseRemote, providerFor, requestNoun, splitList, suggestBody, suggestTitle, type Provider, type RemoteInfo } from "../lib/forge";
  import { platform } from "../lib/keys.svelte";
  import { app, hostOf, reloadTab, setPrefs, type Tab } from "../lib/state.svelte";
  import { ui } from "../lib/ui.svelte";
  import type { ForgeCli, ForgeInfo, ForgeRequest } from "../lib/types";

  let { tab, source: initial, onclose }: { tab: Tab; source: string | null; onclose: () => void } = $props();

  const repo = untrack(() => tab.path), loc = untrack(() => tab.location);
  const boxHost = hostOf(loc); // "" for this computer
  const branches = $derived(tab.refs.refs.filter((r) => r.kind === "branch").map((r) => r.name));
  const remotes = $derived(tab.refs.remotes);
  /** the branch's upstream remote, else origin, else the only remote; several others: the user picks */
  function remoteFor(branch: string): string {
    const up = tab.refs.refs.find((r) => r.kind === "branch" && r.name === branch)?.upstream;
    const viaUp = up ? splitRemote(tab.refs.remotes, up)?.[0] : undefined;
    return viaUp ?? (tab.refs.remotes.includes("origin") ? "origin" : tab.refs.remotes.length === 1 ? tab.refs.remotes[0] : "");
  }
  let source = $state(untrack(() => initial ?? tab.info.branch ?? ""));
  let remote = $state(untrack(() => remoteFor(source)));
  let target = $state(""); // "" = the remote's default branch
  let title = $state(""), body = $state(""), touched = { title: false, body: false };
  let draft = $state(false), removeSource = $state(false), squash = $state(false);
  let reviewers = $state(""), labels = $state(""), assignees = $state("");
  let pushFirst = $state(true);

  let remoteInfo = $state<RemoteInfo | null>(null), urlError = $state("");
  let provider = $state<Provider | null>(null);
  let info = $state<ForgeInfo | null>(null), probeError = $state("");
  let cli = $state<ForgeCli | null>(null), cliKey = "";
  let busy = $state(false), error = $state("");
  let done = $state<{ url: string | null; output: string; truncated: boolean; browser: boolean } | null>(null);

  // the remote's URL decides the forge
  $effect(() => {
    const r = remote;
    remoteInfo = null; provider = null; urlError = "";
    if (!r) return;
    let live = true;
    api.remoteUrl(loc, repo, r).then((u) => {
      if (!live) return;
      const ri = parseRemote(u);
      if (!ri) { urlError = `${r} (${u}) is not a GitHub or GitLab address.`; return; }
      remoteInfo = ri;
      provider = providerFor(ri.host, untrack(() => app.prefs.forge_hosts));
    }).catch((e) => { if (live) urlError = String(e); });
    return () => { live = false; };
  });
  $effect(() => { if (provider) ui.forgeKinds[tab.id] = provider; });
  const webHost = $derived(remoteInfo?.webBase.replace(/^https:\/\//, "") ?? "");
  /** the forge's CLI and its login are asked once per remote + provider; branch changes only re-read git */
  $effect(() => {
    const [r, s, t, p, h] = [remote, source, target, provider, webHost];
    if (!r || !s || !p || !h) return;
    const key = `${r}|${p}|${h}`;
    const askCli = untrack(() => cliKey !== key);
    const path = boxHost ? null : (p === "github" ? untrack(() => app.prefs.gh_path) : untrack(() => app.prefs.glab_path)) || null;
    let live = true;
    probeError = "";
    api.forgeProbe(loc, repo, r, s, t || null, askCli ? p : null, askCli ? h : null, askCli ? path : null).then((res) => {
      if (!live) return;
      info = res;
      if (res.cli) { cli = res.cli; cliKey = key; }
      if (!touched.title) title = suggestTitle(s, res.commits);
      if (!touched.body) body = suggestBody(res.commits);
    }).catch((e) => { if (live) probeError = String(e); });
    return () => { live = false; };
  });

  const noun = $derived(requestNoun(provider));
  const tgt = $derived(target || info?.default_branch || "");
  const targets = $derived([...new Set([...(info?.remote_branches ?? []), ...(info?.default_branch ? [info.default_branch] : [])])].filter((b) => b !== source).sort());
  /** the source's name on the remote: its upstream's when that is on this remote */
  const head = $derived(info?.upstream?.startsWith(`refs/remotes/${remote}/`) ? info.upstream.slice(`refs/remotes/${remote}/`.length) : source);
  const needsPush = $derived(!!info && info.source === source && (info.upstream === null || info.ahead !== 0));
  const route = $derived(cli ? (cli.installed && cli.authenticated ? "cli" : "browser") : null);
  const routeText = $derived.by(() => {
    if (!provider || !cli) return provider ? "Checking the command line tool…" : "";
    if (route === "cli") return `via ${cli.name}${boxHost ? ` on ${boxHost}` : ""}`;
    const where = boxHost ? ` on ${boxHost}` : "";
    const login = `${cli.name} auth login${remoteInfo && !["github.com", "gitlab.com"].includes(remoteInfo.host) ? ` --hostname ${remoteInfo.host}` : ""}`;
    return `in your browser: ${cli.installed ? `${cli.name} is not logged in${where} — run \`${login}\`` : `${cli.name} not found${where}`}`;
  });

  function answer(p: Provider) {
    if (!remoteInfo) return;
    setPrefs({ forge_hosts: { ...app.prefs.forge_hosts, [remoteInfo.host]: p } });
    provider = p;
  }
  function open(url: string) {
    if (!isHttpsUrl(url)) { error = `Not opening ${url}: only https links are opened.`; return; }
    void api.openEditor(platform === "mac" ? "open {path}" : "xdg-open {path}", url, "").catch((e) => { error = String(e); });
  }

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!provider || !remoteInfo || !info || busy) return;
    const lists = { reviewers: splitList(reviewers), labels: splitList(labels), assignees: splitList(assignees) };
    const bad = badListItem([...lists.reviewers, ...lists.labels, ...lists.assignees]);
    if (!title.trim()) { error = "A title is needed."; return; }
    if (bad) { error = `Not a valid name: ${bad}`; return; }
    if (!tgt) { error = "Pick a target branch."; return; }
    busy = true; error = "";
    const [r, s, t, h, p, ri, how] = [remote, source, tgt, head, provider, remoteInfo, route];
    const push = needsPush && pushFirst ? runGit(tab, `git push --set-upstream ${r} ${s}`, { Push: { repo, flags: [], remote: r, branch: s } }) : null;
    try {
      if (how === "cli" && cli) {
        const req: ForgeRequest = {
          repo, forge: p, host: webHost, project: ri.path, cli_path: boxHost ? null : (p === "github" ? app.prefs.gh_path : app.prefs.glab_path) || null,
          source: h, target: t, title: title.trim(), body, draft, remove_source_branch: p === "gitlab" && removeSource, squash: p === "gitlab" && squash, ...lists,
        };
        const label = p === "github" ? `gh pr create --head ${h} --base ${t}` : `glab mr create --source-branch ${h} --target-branch ${t}`;
        // queued right behind the push: a failed push cancels it
        const created = runGit(tab, label, { ForgeCreate: req });
        created.catch(() => {});
        if (push) await push;
        const res = (await created) as { Created: { url: string | null; output: string } };
        const url = res.Created.url && isHttpsUrl(res.Created.url) ? res.Created.url : null;
        done = { url, output: res.Created.output, truncated: false, browser: false };
        if (url && app.prefs.open_request_after_create) open(url);
      } else {
        if (push) await push;
        const { url, truncated } = newRequestUrl(p, ri, h, t, title.trim(), body);
        done = { url, output: "", truncated, browser: true };
        open(url);
      }
    } catch (err) {
      error = err === CANCELLED ? "Cancelled." : String(err);
    } finally {
      busy = false;
      if (push) void reloadTab(tab).catch(() => {});
    }
  }
  const focus = (el: HTMLElement) => { requestAnimationFrame(() => el.focus()); };
  const onkeydown = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onclose(); } };
</script>

<svelte:window {onkeydown} />
<div class="scrim dim" role="presentation" onmousedown={onclose}></div>
<div class="overlay add-repos forge" role="dialog" aria-label="Create {noun}">
  {#if done}
    <div class="ar-form">
      <h1>{done.browser ? `${noun} page opened` : `${noun} created`}</h1>
      {#if done.url}
        <div class="fr-url" aria-label="Request URL">
          <span class="mono" title={done.url}>{done.url}</span>
          <button class="btn sm" onclick={() => open(done!.url!)}>Open</button>
          <button class="btn sm" onclick={() => void copy(done!.url!)}>Copy</button>
        </div>
      {:else}
        <p class="hint">{done.output.trim() || "The tool printed no link."}</p>
      {/if}
      {#if done.truncated}<p class="hint">The description was too long for a link and was cut: paste the rest on the page.</p>{/if}
      {#if done.browser}<p class="hint">Finish creating it on the page in your browser.</p>{/if}
      {#if error}<p class="err" role="alert">{error}</p>{/if}
      <div class="ar-bar end"><button class="primary" use:focus onclick={onclose}>Close</button></div>
    </div>
  {:else}
    <form class="ar-form" onsubmit={create}>
      <h1>Create {noun}</h1>
      {#if !remotes.length}
        <p class="err">This repository has no remotes.</p>
      {:else}
        <div class="fr-grid">
          {#if remotes.length > 1}
            <label>Remote
              <select bind:value={remote} aria-label="Remote">
                {#if !remote}<option value="">Choose…</option>{/if}
                {#each remotes as r}<option value={r}>{r}</option>{/each}
              </select>
            </label>
          {/if}
          <label>From
            <select bind:value={source} aria-label="Source branch">{#each branches as b}<option value={b}>{b}</option>{/each}</select>
          </label>
          <label>Into
            <select value={tgt} onchange={(e) => (target = e.currentTarget.value)} aria-label="Target branch">
              {#if !tgt}<option value="">Choose…</option>{/if}
              {#each targets as b}<option value={b}>{b}</option>{/each}
            </select>
          </label>
        </div>
        {#if urlError}<p class="err">{urlError}</p>{/if}
        {#if remoteInfo && !provider}
          <div class="fr-ask" role="group" aria-label="Which forge">
            <span>Is <b>{remoteInfo.host}</b> GitHub or GitLab?</span>
            <button type="button" class="btn sm" onclick={() => answer("github")}>GitHub</button>
            <button type="button" class="btn sm" onclick={() => answer("gitlab")}>GitLab</button>
          </div>
        {/if}
        {#if probeError}<p class="err">{probeError}</p>{/if}
        <label>Title <input bind:value={title} oninput={() => (touched.title = true)} maxlength="256" spellcheck="false" use:focus /></label>
        <label>Description
          <textarea bind:value={body} oninput={() => (touched.body = true)} rows="8" spellcheck="true"></textarea>
        </label>
        <div class="fr-checks">
          <label class="ck"><input type="checkbox" bind:checked={draft} /> Draft</label>
          {#if provider === "gitlab"}
            <label class="ck"><input type="checkbox" bind:checked={removeSource} /> Delete source branch when merged</label>
            <label class="ck"><input type="checkbox" bind:checked={squash} /> Squash commits when merged</label>
          {/if}
        </div>
        <div class="fr-grid">
          <label>Reviewers <input bind:value={reviewers} placeholder="alice, org/team" spellcheck="false" /></label>
          <label>Labels <input bind:value={labels} placeholder="bug, ui" spellcheck="false" /></label>
          <label>Assignee <input bind:value={assignees} placeholder="@me" spellcheck="false" /></label>
        </div>
        {#if route === "browser"}<p class="hint">Opening in the browser: set reviewers, labels, draft and the GitLab options on the page.</p>{/if}
        {#if needsPush}
          <label class="ck"><input type="checkbox" bind:checked={pushFirst} /> Push branch first <span class="hint">({info?.upstream === null ? `${source} has no upstream: git push --set-upstream ${remote} ${source}` : `${info?.ahead ?? "some"} commit${info?.ahead === 1 ? "" : "s"} not on ${remote}`})</span></label>
        {/if}
        {#if error}<pre class="err fr-out" role="alert">{error}</pre>{/if}
        <div class="ar-bar end">
          <span class="sub fr-route" aria-label="Route">{routeText}</span>
          <button type="button" class="btn" onclick={onclose}>Cancel</button>
          <button class="primary" disabled={busy || !info || !provider || !title.trim() || !tgt}>{busy ? "Creating…" : `Create ${noun}`}</button>
        </div>
      {/if}
    </form>
  {/if}
</div>
