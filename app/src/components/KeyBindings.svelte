<script lang="ts">
  // Preferences → Key Bindings: the preset, then every command with its shortcuts; click a row to record new keys.
  // Edits go to the user's keymap.json as text splices (comments survive), then the keymap, menus and accelerators
  // reload. The defaults shown are the active preset's.
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { onCommandsChanged, registeredCommands, runCommand } from "../lib/commands";
  import { KEYMAP_PRESETS, presetBindings } from "../lib/defaultKeymap";
  import { app, setPrefs } from "../lib/state.svelte";
  import { KEYMAP_FILE, loadKeymap, platform } from "../lib/keys.svelte";
  import { chordFromEvent, prettyKeys, type Chord } from "../lib/keymap";
  import { applyEdit, bindingsOf, buildRows, chordSpec, conflictsFor, contextNote, isModified, keymapEntries, nextSequence, removeBinding, resetAll, resetRow, setKeys, type Edit, type Row } from "../lib/keyEdit";
  import { MAIN_MENU } from "../lib/menu";
  import { parseJsonc } from "../lib/jsonc";

  const defaults = $derived(presetBindings(platform, app.prefs.keymap_preset));
  let text = $state("");
  let user = $state<unknown[]>([]);
  let error = $state("");
  let query = $state("");
  let commands = $state(registeredCommands());
  let editing = $state<Row | null>(null);
  let seq = $state<Chord[]>([]);
  let confirmAll = $state(false);
  let recorder = $state<HTMLElement>();

  const entries = $derived(keymapEntries(defaults, user, platform));
  const rows = $derived(buildRows(MAIN_MENU, commands, entries));
  const rk = (r: Row) => r.command + JSON.stringify(r.args ?? {});
  const isEditing = (r: Row) => !!editing && rk(editing) === rk(r);
  const pretty = (keys: string[]) => prettyKeys(keys, platform);
  const keysOf = (r: Row) => bindingsOf(entries, r);
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => `${r.caption} ${r.command} ${r.args ? JSON.stringify(r.args) : ""} ${keysOf(r).map((e) => pretty(e.binding.keys)).join(" ")}`.toLowerCase().includes(q));
  });
  const groups = $derived([...new Set(shown.map((r) => r.group))]);
  const newKeys = $derived(seq.map(chordSpec));
  const conflicts = $derived(editing && seq.length ? conflictsFor(entries, newKeys, editing, platform) : []);
  const captionOf = (command: string, args?: Record<string, unknown>) =>
    rows.find((r) => r.command === command && JSON.stringify(r.args ?? {}) === JSON.stringify(args ?? {}))?.caption ?? command;

  function parse(t: string): void {
    try {
      const v = t.trim() ? parseJsonc(t) : [];
      if (!Array.isArray(v)) throw new Error("the file must contain a JSON array");
      user = v;
      error = "";
    } catch (e) {
      user = [];
      error = `${KEYMAP_FILE} could not be read (${e instanceof Error ? e.message : e}). Fix it with Open as Text; editing is off until then.`;
    }
  }
  async function load() { text = await api.readConfig(KEYMAP_FILE); parse(text); }

  /** Re-read first: if the file changed behind our back (hand edit), show that instead of splicing at stale offsets. */
  async function write(edit: (current: typeof entries) => Edit) {
    const disk = await api.readConfig(KEYMAP_FILE);
    if (disk !== text) { text = disk; parse(disk); error ||= "The file changed on disk and was reloaded; try again."; return; }
    try {
      const next = applyEdit(text, edit(entries));
      await api.writeConfig(KEYMAP_FILE, next);
      text = next;
      parse(next);
      await loadKeymap(); // keymap, menu hints and native accelerators
    } catch (e) { error = String(e instanceof Error ? e.message : e); }
  }

  function record(r: Row) {
    if (error) return;
    editing = r;
    seq = [];
    queueMicrotask(() => recorder?.focus());
  }
  function stop() { editing = null; seq = []; }
  async function save(replace: boolean) {
    const r = editing, keys = newKeys;
    if (!r || !keys.length) return;
    stop();
    await write((e) => setKeys(e, r, keys, platform, replace));
  }
  function onkey(e: KeyboardEvent) {
    const c = chordFromEvent(e);
    if (!c) return; // a bare modifier: wait for the key
    e.preventDefault();
    e.stopPropagation();
    if (!c.mods.length && c.key === "escape") return stop();
    if (!c.mods.length && c.key === "enter" && seq.length) { void save(true); return; }
    seq = nextSequence(seq, c);
  }

  onMount(() => {
    void load();
    const off = onCommandsChanged(() => { commands = registeredCommands(); });
    const onFocus = () => { if (!editing) void load(); }; // hand edits made in an editor
    window.addEventListener("focus", onFocus);
    return () => { off(); window.removeEventListener("focus", onFocus); };
  });
</script>

<div class="kb">
  <label class="pf"><span class="pl">Preset</span>
    <select aria-label="Key binding preset" value={app.prefs.keymap_preset} disabled={app.fromSettings.includes("keymap_preset")}
      onchange={(e) => setPrefs({ keymap_preset: e.currentTarget.value as typeof app.prefs.keymap_preset })}>
      {#each KEYMAP_PRESETS as p}<option value={p.value}>{p.label}</option>{/each}
    </select>
    {#if app.fromSettings.includes("keymap_preset")}<span class="hint from-file">set in settings.json</span>{:else}<span class="hint">{KEYMAP_PRESETS.find((p) => p.value === app.prefs.keymap_preset)?.detail}</span>{/if}
  </label>
  <div class="kb-bar">
    <input class="kb-search" type="search" bind:value={query} placeholder="Search commands or keys" aria-label="Search key bindings" spellcheck="false" />
    <button class="btn sm" onclick={() => runCommand("edit_key_bindings")}>Open as Text</button>
    {#if confirmAll}
      <button class="btn sm danger" onclick={() => { confirmAll = false; void write(() => resetAll(text)); }}>Remove all my bindings</button>
      <button class="btn sm" onclick={() => (confirmAll = false)}>Cancel</button>
    {:else}
      <button class="btn sm" disabled={!!error || !entries.some((e) => e.user)} onclick={() => (confirmAll = true)}>Reset All</button>
    {/if}
  </div>
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  <p class="hint">Click a command to record keys (two-step chords like {pretty([platform === "mac" ? "super+k" : "ctrl+k", platform === "mac" ? "super+b" : "ctrl+b"])} work). Saved to <code>{KEYMAP_FILE}</code>, which goes on top of the preset.</p>
  {#each groups as g (g)}
    <h3 class="kb-group">{g}</h3>
    <ul class="kb-list">
      {#each shown.filter((r) => r.group === g) as r (rk(r))}
        {@const mine = keysOf(r)}
        <li class:on={isEditing(r)} data-command={r.command}>
          <div class="kb-row" role="button" tabindex="0" aria-label="Change keys for {r.caption}" onclick={() => record(r)} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); record(r); } }}>
            <span class="kb-cap">{r.caption}<span class="kb-cmd">{r.command}{r.args ? ` ${JSON.stringify(r.args)}` : ""}</span></span>
            <span class="kb-keys">
              {#each mine as e (e.user + ":" + e.index)}
                {#if e.binding.context?.length}
                  <span class="kb-ctx" title="Only {contextNote(e.binding.context)}; edit it with Open as Text">{pretty(e.binding.keys)} <i>{contextNote(e.binding.context)}</i></span>
                {:else}
                  <span class="kb-key" class:user={e.user}>
                    <kbd>{pretty(e.binding.keys)}</kbd><small>{e.user ? "user" : "default"}</small>
                    <button class="ib" aria-label="Remove {pretty(e.binding.keys)} from {r.caption}" title="Remove" disabled={!!error}
                      onclick={(ev) => { ev.stopPropagation(); void write(() => removeBinding(e)); }}><svg class="i"><use href="#i-x" /></svg></button>
                  </span>
                {/if}
              {/each}
              {#if isModified(entries, r)}
                <button class="btn sm" disabled={!!error} onclick={(ev) => { ev.stopPropagation(); void write((all) => resetRow(all, r)); }}>Reset</button>
              {/if}
            </span>
          </div>
          {#if isEditing(r)}
            <div class="kb-rec">
              <div class="kb-field" bind:this={recorder} data-keyrecord tabindex="0" role="textbox" aria-label="Press the new keys" onkeydown={onkey}>
                {seq.length ? pretty(newKeys) : "Press the new keys…"}
              </div>
              <button class="primary sm" disabled={!seq.length} onclick={() => save(true)}>Replace</button>
              <button class="btn sm" disabled={!seq.length} onclick={() => save(false)}>Add</button>
              <button class="btn sm" onclick={stop}>Cancel</button>
              <span class="hint">Esc cancels, Enter replaces</span>
            </div>
            {#if conflicts.length}
              <p class="kb-warn" role="alert">
                {pretty(newKeys)} {conflicts.some((c) => c.id === newKeys.join(" ")) ? "is already used by" : "overlaps the chord of"}
                {conflicts.map((c) => `${captionOf(c.binding.command, c.binding.args)} (${pretty(c.binding.keys)})`).join(", ")}: saving overrides it.
              </p>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="hint">No commands match.</p>
  {/each}
</div>
