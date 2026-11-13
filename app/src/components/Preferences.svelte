<script lang="ts">
  // The Preferences window (open_preferences, ⌘, / Ctrl+,): pages on the left, live settings on the right, saved in
  // preferences.json. A setting that settings.json sets is shown read-only.
  import { api, type AgentInfo } from "../lib/api";
  import { themeChoices } from "../lib/appCommands";
  import { runCommand } from "../lib/commands";
  import { runGit, CANCELLED } from "../lib/jobs.svelte";
  import { DIFF_DEFAULTS, LAYOUTS, PREF_DEFAULTS, app, hostOf, removeRecent, resetHidden, setDiff, setLayout, setPrefs, setRepoAlias, setTheme } from "../lib/state.svelte";
  import { closePreferences, showAddRepos, ui } from "../lib/ui.svelte";
  import KeyBindings from "./KeyBindings.svelte";

  const PAGES = [
    { id: "appearance", label: "Appearance" }, { id: "diff", label: "Diff" }, { id: "repositories", label: "Repositories" },
    { id: "git", label: "Git" }, { id: "remote", label: "Remote" }, { id: "key_bindings", label: "Key Bindings" },
  ];
  const CONTEXTS = [0, 1, 3, 5, 10, 25];
  const SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20];
  const page = $derived(PAGES.find((p) => p.id === ui.prefsPage) ?? PAGES[0]);
  /** settings.json sets it: read-only here */
  const locked = (name: string) => app.fromSettings.includes(name);
  const PLAIN = ["light", "dark", "system"];
  const otherThemes = $derived(themeChoices().filter((t) => !PLAIN.includes(t.value)));
  /** Reset to defaults leaves settings.json's values alone */
  const unless = (name: string, fn: () => void) => { if (!locked(name)) fn(); };

  /** Reset to defaults, per page (Repositories: aliases and hidden branches; the list itself stays). */
  const RESET: Record<string, (() => void) | undefined> = {
    appearance: () => {
      unless("theme", () => setTheme("system"));
      unless("side_bar_layout", () => setLayout("locations_as_column"));
      unless("ui_font_size", () => setPrefs({ ui_font_size: PREF_DEFAULTS.ui_font_size }));
      unless("font_size", () => setPrefs({ font_size: PREF_DEFAULTS.font_size }));
    },
    diff: () => {
      const { mode, context, ignoreWs, words, syntax, wrap } = DIFF_DEFAULTS;
      setDiff({ mode, context, ignoreWs, words, syntax, wrap });
      setPrefs({ expand_merge_commits_by_default: PREF_DEFAULTS.expand_merge_commits_by_default });
    },
    repositories: () => { for (const r of repos) { setRepoAlias(r.id, ""); void resetHidden(r.id); } },
    git: () => {
      setDiff({ editorLocal: DIFF_DEFAULTS.editorLocal, editorRemote: DIFF_DEFAULTS.editorRemote });
      setPrefs({ terminal_command: PREF_DEFAULTS.terminal_command, confirm_destructive: PREF_DEFAULTS.confirm_destructive,
        gh_path: "", glab_path: "", open_request_after_create: PREF_DEFAULTS.open_request_after_create });
    },
  };

  // Repositories: the switcher's list plus open tabs that are not in it
  const repos = $derived.by(() => {
    const list = [...app.recent];
    for (const t of app.tabs) if (!list.some((r) => r.location === t.location && r.path === t.path)) list.push({ location: t.location, path: t.path });
    return list.map((r) => ({ ...r, id: `${r.location}|${r.path}`, open: app.tabs.some((t) => t.location === r.location && t.path === r.path) }));
  });
  let confirmRemoveAll = $state(false);

  // Git identity: `git config --global` read and written through a local repository (it is the same for all of them)
  const localTab = $derived(app.tabs.find((t) => t.id === app.active && t.location === "local") ?? app.tabs.find((t) => t.location === "local"));
  let name = $state(""), email = $state(""), idError = $state(""), idBusy = $state(false), idLoadedFor = "";
  $effect(() => {
    const t = localTab;
    if (page.id !== "git" || !t || idLoadedFor === t.id) return;
    idLoadedFor = t.id;
    api.identity(t.location, t.path).then((id) => {
      const m = /^(.*?)\s*<(.*)>$/.exec(id);
      name = m ? m[1] : id; email = m ? m[2] : "";
    }).catch((e) => { idError = String(e); });
  });
  async function saveIdentity(e: SubmitEvent) {
    e.preventDefault();
    const t = localTab;
    if (!t) return;
    idBusy = true; idError = "";
    try { await runGit(t, "git config --global user.name/user.email", { SetIdentity: { repo: t.path, name, email } }); }
    catch (err) { if (err !== CANCELLED) idError = String(err); }
    finally { idBusy = false; }
  }

  // Pull/merge requests: self-hosted forges
  let newHost = $state(""), newKind = $state<"github" | "gitlab">("gitlab");
  function addForgeHost(e: SubmitEvent) {
    e.preventDefault();
    const h = newHost.trim().toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(h)) return;
    setPrefs({ forge_hosts: { ...app.prefs.forge_hosts, [h]: newKind } });
    newHost = "";
  }

  // Remote
  let hosts = $state<string[] | null>(null), agent = $state<AgentInfo | null>(null), agentError = $state("");
  // Reinstall agent: ssh config hosts plus hosts of open/recent remote repos
  const hostChoices = $derived([...new Set([...(hosts ?? []), ...[...app.tabs, ...app.recent].map((r) => hostOf(r.location)).filter(Boolean)])].sort());
  let reHost = $state(""), reBusy = $state(false), reMsg = $state(""), reErr = $state(false);
  let clBusy = $state(false), clMsg = $state(""), clErr = $state(false), clDays = $state<number | null>(null);
  const clAge = $derived(clDays ?? app.prefs.agent_cleanup_days);
  const setClAge = (e: Event) => {
    const d = num(e);
    clDays = d;
    if (d > 0) setPrefs({ agent_cleanup_days: d }); // "now" is only for this click
  };
  async function cleanup() {
    const h = reHost || hostChoices[0];
    if (!h) return;
    clBusy = true; clMsg = ""; clErr = false;
    try { const [n, b] = await api.cleanupAgents(h, clAge); clMsg = `Removed ${n} old agent ${n === 1 ? "file" : "files"} (${b.toLocaleString()} bytes) on ${h}.`; }
    catch (e) { clMsg = String(e); clErr = true; }
    finally { clBusy = false; }
  }
  let tracing = $state(false);
  $effect(() => { if (page.id === "remote") void api.requestTrace().then((on) => (tracing = on)); });
  const setTrace = async (on: boolean) => { tracing = await api.requestTrace(on); };
  async function reinstall() {
    const h = reHost || hostChoices[0];
    if (!h) return;
    reBusy = true; reMsg = ""; reErr = false;
    try { reMsg = `Installed ${await api.reinstallAgent(h)} on ${h}; used from the next connection.`; }
    catch (e) { reMsg = String(e); reErr = true; }
    finally { reBusy = false; }
  }
  $effect(() => {
    if (page.id !== "remote" || hosts) return;
    api.sshHosts().then((h) => (hosts = h)).catch(() => (hosts = []));
    api.agentInfo().then((a) => (agent = a)).catch((e) => (agentError = String(e)));
  });
  const num = (e: Event) => +(e.currentTarget as HTMLSelectElement).value;
</script>

{#snippet fromFile(name: string)}{#if locked(name)}<span class="hint from-file" title="Remove it from settings.json to change it here">set in settings.json</span>{/if}{/snippet}

{#if ui.prefsPage}
  <div class="scrim dim" role="presentation" onmousedown={closePreferences}></div>
  <div class="prefs" role="dialog" aria-label="Preferences">
    <nav class="prefs-nav" aria-label="Preferences pages">
      <h1>Preferences</h1>
      {#each PAGES as p (p.id)}
        <button class:on={p.id === page.id} aria-current={p.id === page.id ? "page" : undefined} onclick={() => (ui.prefsPage = p.id)}>{p.label}</button>
      {/each}
    </nav>
    <section class="prefs-page" aria-label={page.label}>
      <header>
        <h2>{page.label}</h2>
        {#if RESET[page.id]}<button class="btn sm" onclick={RESET[page.id]}>Reset to Defaults</button>{/if}
        <button class="ib" aria-label="Close Preferences" title="Close (Esc)" onclick={closePreferences}><svg class="i"><use href="#i-x" /></svg></button>
      </header>
      <div class="prefs-body">
        {#if page.id === "appearance"}
          <div class="pf"><span class="pl">Theme</span>
            <div class="seg three" role="radiogroup" aria-label="Theme">
              {#each themeChoices().filter((t) => PLAIN.includes(t.value)) as t}<button role="radio" aria-checked={app.theme === t.value} class:on={app.theme === t.value} disabled={locked("theme")} onclick={() => setTheme(t.value)}>{t.label}</button>{/each}
            </div>
            <select aria-label="Other themes" value={PLAIN.includes(app.theme) ? "" : app.theme} disabled={locked("theme")} onchange={(e) => { if (e.currentTarget.value) setTheme(e.currentTarget.value); }}>
              <option value="">More themes…</option>
              {#each otherThemes as t}<option value={t.value}>{t.label}</option>{/each}
            </select>
            {@render fromFile("theme")}
          </div>
          <label class="pf"><span class="pl">Layout</span>
            <select value={app.layout} disabled={locked("side_bar_layout")} onchange={(e) => setLayout(e.currentTarget.value as typeof app.layout)}>
              {#each LAYOUTS as l}<option value={l.value}>{l.caption}</option>{/each}
            </select>
            {@render fromFile("side_bar_layout")}
          </label>
          <label class="pf"><span class="pl">UI font size</span>
            <select value={app.prefs.ui_font_size} disabled={locked("ui_font_size")} onchange={(e) => setPrefs({ ui_font_size: num(e) })}>{#each SIZES as s}<option value={s}>{s} px</option>{/each}</select>
            {@render fromFile("ui_font_size")}
          </label>
          <label class="pf"><span class="pl">Diff font size</span>
            <select value={app.prefs.font_size} disabled={locked("font_size")} onchange={(e) => setPrefs({ font_size: num(e) })}>{#each SIZES as s}<option value={s}>{s} px</option>{/each}</select>
            {@render fromFile("font_size")}
          </label>
          <div class="pf"><span class="pl">Config files</span>
            <button class="btn sm" onclick={() => runCommand("edit_settings")}>Edit settings.json…</button>
            <button class="btn sm" onclick={() => runCommand("browse_packages")}>Open Configuration Folder…</button>
          </div>
          <p class="hint">settings.json can set every preference (a commented list of all of them is created the first time); what it sets wins and shows here as read-only. Theme files go in the <code>themes</code> folder.</p>
        {:else if page.id === "diff"}
          <div class="pf"><span class="pl">Diff style</span>
            <div class="seg two" role="radiogroup" aria-label="Diff style">
              <button role="radio" aria-checked={app.diff.mode === "split"} class:on={app.diff.mode === "split"} disabled={locked("diff_style")} onclick={() => setDiff({ mode: "split" })}>Side by side</button>
              <button role="radio" aria-checked={app.diff.mode === "unified"} class:on={app.diff.mode === "unified"} disabled={locked("diff_style")} onclick={() => setDiff({ mode: "unified" })}>Unified</button>
            </div>
            {@render fromFile("diff_style")}
          </div>
          <label class="pf"><span class="pl">Context lines</span>
            <select value={app.diff.context} disabled={locked("diff_context_lines")} onchange={(e) => setDiff({ context: num(e) })}>{#each CONTEXTS as c}<option value={c}>{c}</option>{/each}</select>
            {@render fromFile("diff_context_lines")}
          </label>
          <label class="pf ck"><input type="checkbox" checked={app.diff.ignoreWs} disabled={locked("ignore_diff_white_space")} onchange={(e) => setDiff({ ignoreWs: e.currentTarget.checked })} /> Ignore whitespace changes {@render fromFile("ignore_diff_white_space")}</label>
          <label class="pf ck"><input type="checkbox" checked={app.diff.words} disabled={locked("word_diff")} onchange={(e) => setDiff({ words: e.currentTarget.checked })} /> Word diff (highlight the changed words) {@render fromFile("word_diff")}</label>
          <label class="pf ck"><input type="checkbox" checked={app.diff.syntax} disabled={locked("diff_syntax_colors")} onchange={(e) => setDiff({ syntax: e.currentTarget.checked })} /> Syntax colors {@render fromFile("diff_syntax_colors")}</label>
          <label class="pf ck"><input type="checkbox" checked={app.diff.wrap} disabled={locked("word_wrap")} onchange={(e) => setDiff({ wrap: e.currentTarget.checked })} /> Wrap long lines in unified diffs <span class="hint">(side by side always wraps)</span> {@render fromFile("word_wrap")}</label>
          <label class="pf ck"><input type="checkbox" checked={app.prefs.expand_merge_commits_by_default} disabled={locked("expand_merge_commits_by_default")} onchange={(e) => setPrefs({ expand_merge_commits_by_default: e.currentTarget.checked })} /> Expand merge commits by default <span class="hint">(off: merges start collapsed in the commit graph; applies when a repository loads)</span> {@render fromFile("expand_merge_commits_by_default")}</label>
        {:else if page.id === "repositories"}
          <div class="pf-bar">
            <button class="btn sm" onclick={showAddRepos}>Add Repositories from Folder…</button>
            {#if confirmRemoveAll}
              <button class="btn sm danger" onclick={() => { confirmRemoveAll = false; removeRecent(null); }}>Remove all from the list</button>
              <button class="btn sm" onclick={() => (confirmRemoveAll = false)}>Cancel</button>
            {:else}
              <button class="btn sm" disabled={!app.recent.length} onclick={() => (confirmRemoveAll = true)}>Remove All</button>
            {/if}
          </div>
          <p class="hint">The repositories Switch Repository offers. Removing one only forgets it here; nothing on disk changes.</p>
          <ul class="pf-repos">
            {#each repos as r (r.id)}
              <li>
                <svg class="i"><use href={hostOf(r.location) ? "#i-server" : "#i-folder"} /></svg>
                <span class="p" title={r.path}>{hostOf(r.location) ? `${hostOf(r.location)}:` : ""}{r.path}{#if r.open}<span class="sub"> open</span>{/if}</span>
                <input class="alias" value={app.aliases[r.id] ?? ""} placeholder={r.path.split("/").pop()} aria-label="Alias for {r.path}" spellcheck="false"
                  onchange={(e) => setRepoAlias(r.id, e.currentTarget.value)} />
                {#if app.hiddenRefs[r.id]?.length}
                  <button class="btn sm" title={app.hiddenRefs[r.id].join("\n")} onclick={() => resetHidden(r.id)}>Show {app.hiddenRefs[r.id].length} hidden</button>
                {/if}
                <button class="ib" aria-label="Remove {r.path} from the list" title="Remove from the list" disabled={!app.recent.some((x) => x.location === r.location && x.path === r.path)}
                  onclick={() => removeRecent(r)}><svg class="i"><use href="#i-x" /></svg></button>
              </li>
            {:else}
              <li class="sub">No repositories yet.</li>
            {/each}
          </ul>
        {:else if page.id === "git"}
          <form class="pf-group" onsubmit={saveIdentity}>
            <h3>Identity <span class="hint">(git config --global)</span></h3>
            {#if localTab}
              <label class="pf"><span class="pl">Name</span><input bind:value={name} spellcheck="false" autocomplete="off" /></label>
              <label class="pf"><span class="pl">Email</span><input bind:value={email} spellcheck="false" autocomplete="off" /></label>
              {#if idError}<p class="err" role="alert">{idError}</p>{/if}
              <div class="pf"><span class="pl"></span><button class="primary sm" disabled={idBusy || !name.trim() || !email.trim()}>{idBusy ? "Saving…" : "Save Identity"}</button></div>
            {:else}
              <p class="hint">Open a repository on this computer to read and set your git identity.</p>
            {/if}
          </form>
          <div class="pf-group">
            <h3>Programs <span class="hint"><code>{"{path}"}</code> and <code>{"{host}"}</code> are filled in; no shell is involved</span></h3>
            <label class="pf"><span class="pl">Editor</span><input value={app.diff.editorLocal} disabled={locked("editor_command")} onchange={(e) => setDiff({ editorLocal: e.currentTarget.value })} spellcheck="false" />{@render fromFile("editor_command")}</label>
            <label class="pf"><span class="pl">Editor (remote)</span><input value={app.diff.editorRemote} disabled={locked("editor_command_remote")} onchange={(e) => setDiff({ editorRemote: e.currentTarget.value })} spellcheck="false" />{@render fromFile("editor_command_remote")}</label>
            <label class="pf"><span class="pl">Terminal</span><input value={app.prefs.terminal_command} disabled={locked("terminal_command")} onchange={(e) => setPrefs({ terminal_command: e.currentTarget.value })} spellcheck="false" placeholder="empty: no Open in Terminal" />{@render fromFile("terminal_command")}</label>
          </div>
          <div class="pf-group" aria-label="Local model">
            <h3>Local model <span class="hint">commit messages and natural-language search, on this computer only</span></h3>
            <label class="pf ck"><input type="checkbox" checked={app.prefs.commit_suggest} disabled={locked("commit_suggest")} onchange={(e) => setPrefs({ commit_suggest: e.currentTarget.checked })} /> Suggest commit messages{@render fromFile("commit_suggest")}</label>
            <label class="pf ck"><input type="checkbox" checked={app.prefs.natural_search} disabled={locked("natural_search")} onchange={(e) => setPrefs({ natural_search: e.currentTarget.checked })} /> Natural-language search (✨ in the search bar){@render fromFile("natural_search")}</label>
            <div class="pf-row">
              <button class="btn" onclick={() => runCommand("download_commit_model")}>Download Commit Message Model…</button>
              <button class="btn" onclick={() => runCommand("delete_commit_model")}>Delete…</button>
            </div>
          </div>
          <div class="pf-group">
            <h3>Command line <span class="hint"><code>commitkiwi [path …]</code> opens repositories here</span></h3>
            <div class="pf-row">
              <button class="btn" onclick={() => runCommand("install_command_line_tool")}>Install Command Line Tool…</button>
              <button class="btn" onclick={() => runCommand("uninstall_command_line_tool")}>Uninstall</button>
            </div>
          </div>
          <div class="pf-group" aria-label="Pull and merge requests">
            <h3>Pull / merge requests <span class="hint">through your gh / glab login; else the browser</span></h3>
            <label class="pf"><span class="pl">gh</span><input value={app.prefs.gh_path} onchange={(e) => setPrefs({ gh_path: e.currentTarget.value.trim() })} spellcheck="false" placeholder="empty: PATH, /opt/homebrew/bin, /usr/local/bin, ~/.local/bin" /></label>
            <label class="pf"><span class="pl">glab</span><input value={app.prefs.glab_path} onchange={(e) => setPrefs({ glab_path: e.currentTarget.value.trim() })} spellcheck="false" placeholder="empty: PATH, /opt/homebrew/bin, /usr/local/bin, ~/.local/bin" /></label>
            <label class="pf ck"><input type="checkbox" checked={app.prefs.open_request_after_create} onchange={(e) => setPrefs({ open_request_after_create: e.currentTarget.checked })} /> Open the new request in the browser</label>
            <p class="hint">Self-hosted hosts (asked once when creating a request); the paths above are for this computer, remote repositories use the tools on their host.</p>
            <ul class="pf-hosts" aria-label="Forge hosts">
              {#each Object.entries(app.prefs.forge_hosts) as [h, kind] (h)}
                <li class="pf-row">
                  <code>{h}</code>
                  <select aria-label="Forge for {h}" value={kind} onchange={(e) => setPrefs({ forge_hosts: { ...app.prefs.forge_hosts, [h]: e.currentTarget.value as "github" | "gitlab" } })}>
                    <option value="github">GitHub</option><option value="gitlab">GitLab</option>
                  </select>
                  <button class="ib" aria-label="Forget {h}" title="Forget" onclick={() => setPrefs({ forge_hosts: Object.fromEntries(Object.entries(app.prefs.forge_hosts).filter(([k]) => k !== h)) })}><svg class="i"><use href="#i-x" /></svg></button>
                </li>
              {/each}
            </ul>
            <form class="pf-row" onsubmit={addForgeHost}>
              <input aria-label="Forge host" bind:value={newHost} placeholder="git.example.com" spellcheck="false" />
              <select aria-label="Forge kind" bind:value={newKind}><option value="github">GitHub</option><option value="gitlab">GitLab</option></select>
              <button class="btn" disabled={!newHost.trim()}>Add host</button>
            </form>
          </div>
          <div class="pf-group" role="group" aria-label="Branch cleanup">
            <h3>Clean Up Branches <span class="hint">Branch &gt; Clean Up Branches…</span></h3>
            <label class="pf"><span class="pl">Stale after</span><input type="number" min="0" max="36500" value={app.prefs.cleanup_stale_days} disabled={locked("cleanup_stale_days")}
              onchange={(e) => setPrefs({ cleanup_stale_days: Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)) })} /> <span class="hint">days without a commit (0: off)</span>{@render fromFile("cleanup_stale_days")}</label>
            <label class="pf"><span class="pl">Protected</span><input value={app.prefs.cleanup_protected_branches.join(", ")} disabled={locked("cleanup_protected_branches")} spellcheck="false"
              onchange={(e) => setPrefs({ cleanup_protected_branches: e.currentTarget.value.split(",").map((x) => x.trim()).filter(Boolean) })} />{@render fromFile("cleanup_protected_branches")}</label>
            <p class="hint">Never offered for deletion; comma-separated, <code>*</code> matches anything (<code>release/*</code>).</p>
          </div>
          <label class="pf ck"><input type="checkbox" checked={app.prefs.confirm_destructive} disabled={locked("confirm_destructive")} onchange={(e) => setPrefs({ confirm_destructive: e.currentTarget.checked })} /> Confirm destructive operations <span class="hint">(discard, hard reset, force push, drop/delete)</span> {@render fromFile("confirm_destructive")}</label>
          <label class="pf ck"><input type="checkbox" checked={app.prefs.update_check} disabled={locked("update_check")} onchange={(e) => setPrefs({ update_check: e.currentTarget.checked })} /> Check for updates at startup {@render fromFile("update_check")}</label>
        {:else if page.id === "remote"}
          <div class="pf-group">
            <h3>SSH hosts <span class="hint">(from ~/.ssh/config)</span></h3>
            {#if hosts === null}<p class="hint">Loading…</p>
            {:else if hosts.length}<ul class="pf-hosts">{#each hosts as h}<li>{h}</li>{/each}</ul>
            {:else}<p class="hint">No Host entries found.</p>{/if}
          </div>
          <div class="pf-group">
            <h3>Agent</h3>
            {#if agentError}<p class="err">{agentError}</p>
            {:else if agent}
              <p>Protocol version <b>{agent.proto || "(browser preview)"}</b>.</p>
              {#if agent.agents.length}
                <ul class="pf-hosts">{#each agent.agents as a}<li><b>{a.platform}</b> <code>{a.remote_path}</code></li>{/each}</ul>
              {:else}<p class="hint">No agent builds bundled; run scripts/build-agents.sh.</p>{/if}
            {/if}
            <p class="hint">The first connection to a host copies the agent over SSH to the path above; a new app version brings a new hash and installs itself again (also when the installed one speaks another protocol or does not start).</p>
            <div class="pf-row">
              <select aria-label="Host" bind:value={reHost} disabled={!hostChoices.length}>
                {#each hostChoices as h}<option value={h}>{h}</option>{/each}
              </select>
              <button class="btn" disabled={reBusy || !hostChoices.length} onclick={reinstall}>{reBusy ? "Reinstalling…" : "Reinstall agent"}</button>
            </div>
            {#if reMsg}<p class={reErr ? "err" : "hint"} role="status">{reMsg}</p>{/if}
            <div class="pf-row">
              <select aria-label="Remove agents unused for" value={clAge} onchange={setClAge}>
                {#each [...new Set([7, 14, 30, 60, 90, app.prefs.agent_cleanup_days])].sort((a, b) => a - b) as d}<option value={d}>Unused for {d} days</option>{/each}
                <option value={0}>All but the current one (now)</option>
              </select>
              <button class="btn" disabled={clBusy || !hostChoices.length} onclick={cleanup}>{clBusy ? "Cleaning up…" : "Clean up old agents"}</button>
            </div>
            {#if clMsg}<p class={clErr ? "err" : "hint"} role="status">{clMsg}</p>{/if}
            <p class="hint">After a connection (at most once a day per host) agents older than this setting are removed from <code>~/.cache/commitkiwi</code>; the one in use is kept and marked as used.</p>
          </div>
          <div class="pf-group">
            <h3>Request timings</h3>
            <label class="pf ck"><input type="checkbox" checked={tracing} onchange={(e) => setTrace(e.currentTarget.checked)} /> Record how long each request takes (wait, round trip, git in the agent)</label>
            <p class="hint">Palette: Show Request Timings lists the last 100. Also on with COMMITKIWI_TRACE=1; not saved.</p>
          </div>
          <div class="pf-group">
            <h3>Live updates <span class="hint">(file watcher per open repository)</span></h3>
            {#if app.tabs.length}
              <ul class="pf-hosts" aria-label="Watching">
                {#each app.tabs as t}
                  <li><b>{t.alias || t.info.name}</b> {hostOf(t.location) ? `(${hostOf(t.location)})` : ""} —
                    {#if app.links[t.location] !== undefined}<span class="err">Disconnected, reconnecting…</span>
                    {:else if t.watching === undefined}<span class="hint">starting…</span>
                    {:else if t.watching === null}Watching: file events
                    {:else}<span class="hint">Watching: polling fallback ({t.watching})</span>{/if}
                  </li>
                {/each}
              </ul>
            {:else}<p class="hint">No repositories open.</p>{/if}
          </div>
        {:else}
          <KeyBindings />
        {/if}
      </div>
    </section>
  </div>
{/if}
