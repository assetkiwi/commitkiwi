<script lang="ts">
  // The commit box at the bottom of the Working Directory (message editor + Commit ▾ button).
  // The message editor is CodeMirror 6 (wrapping, undo history, ⌘↩ commits).
  import { untrack } from "svelte";
  import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
  import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
  import { Compartment } from "@codemirror/state";
  import { api } from "../lib/api";
  import { registerCommand } from "../lib/commands";
  import { tabScope } from "../lib/tabScope";
  import { stripComments } from "../lib/format";
  import { addMessage, app, reloadTab, type Tab } from "../lib/state.svelte";
  import { CANCELLED, runGit } from "../lib/jobs.svelte";
  import { llm, writeCommitMessage } from "../lib/llm.svelte";
  import type { Req } from "../lib/types";
  import { hideOverlay, showMenu, showOverlay } from "../lib/ui.svelte";

  let { tab, staged, stagedKey, unmerged, merge, onchanged }: {
    tab: Tab;
    /** staged file count (the button's "Commit N files") */
    staged: number;
    /** what is staged (letters + paths): a new suggestion is due when it changes */
    stagedKey: string;
    /** conflicted paths: while any exist a merge can only be aborted or continued by staging them */
    unmerged: string[];
    /** MERGE_MSG while a merge is in progress */
    merge: string | null;
    onchanged: () => Promise<void>;
  } = $props();

  let message = $state("");
  let amend = $state(false);
  let signoff = $state(false);
  let identity = $state<string | null>(null); // null = not loaded yet, "" = none configured
  let committing = $state(false);
  let error = $state("");
  let confirmAbort = $state(false);
  let focused = $state(false);
  let caret = $state({ line: 1, col: 1 });
  let host = $state<HTMLDivElement>();
  let view: EditorView | null = null;
  const hint = new Compartment();
  let amendText = "";
  let prefilled: string | null = null; // the MERGE_MSG put in the box

  const loadIdentity = () => api.identity(tab.location, tab.path).then((i) => (identity = i)).catch(() => (identity = ""));
  $effect(() => { void loadIdentity(); });
  // A merge starts: offer its message (pre-filled in the box); it ends: drop it again if untouched.
  $effect(() => {
    const m = merge;
    untrack(() => {
      if (m !== null && prefilled === null && !message.trim()) { message = m; prefilled = m; }
      else if (m === null && prefilled !== null) { if (message === prefilled) message = ""; prefilled = null; }
    });
  });

  async function toggleAmend() {
    amend = !amend;
    if (amend && !message.trim() && tab.info.oid) {
      try {
        const d = await api.show(tab.location, tab.path, tab.info.oid);
        amendText = d.body ? `${d.subject}\n\n${d.body}` : d.subject;
        message = amendText;
      } catch (e) { error = String(e); }
    } else if (!amend && message === amendText) {
      message = "";
    }
  }
  // The optional local model suggests a message while the box is empty: it shows as the placeholder, Tab takes it.
  // It waits a moment after the staged files change (and is stopped when they change again or the user types), keeps
  // what it wrote per staged state, and never shows an error: a suggestion is a courtesy.
  const SUGGEST_DELAY = 1500;
  let suggestion = $state<string | null>(null);
  /** why the last attempt failed (not for a stop because the staged files changed again) */
  let suggestionError = $state("");
  const suggestions = new Map<string, string>();
  const wanted = $derived(app.prefs.commit_suggest && llm.models.some((m) => m.installed) && merge === null && !amend && !unmerged.length && staged > 0 && message.trim() === "");
  $effect(() => {
    const key = `${tab.info.oid}|${stagedKey}`;
    if (!wanted || !scope.active()) { suggestion = null; return; }
    const known = suggestions.get(key);
    if (known) { suggestion = known; return; }
    suggestion = null;
    suggestionError = "";
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        const m = await writeCommitMessage(tab);
        if (!stale) { suggestions.set(key, m); suggestion = m; }
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        if (!stale && why !== "cancelled") suggestionError = why;
      }
    }, SUGGEST_DELAY);
    return () => { stale = true; clearTimeout(timer); if (llm.writing) void api.llmStop(); };
  });
  /** Tab in the empty box: take the suggestion (the caret goes to its end). */
  function acceptSuggestion(): boolean {
    if (!suggestion || message.trim() !== "") return false;
    message = suggestion;
    suggestion = null;
    queueMicrotask(() => view?.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true }));
    return true;
  }
  /** The command palette's Generate Commit Message: now, without waiting for the pause, and into the box. */
  async function generateNow() {
    error = "";
    try {
      const m = await writeCommitMessage(tab);
      message = m;
      view?.focus();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  /** The suggestion itself is drawn over the box (a placeholder widget is editable DOM: CodeMirror once read it as typed text). */
  function placeholderFor(s: string | null): string {
    if (s) return "";
    return amend ? "Amended Commit Message" : llm.writing && wanted ? "Commit Message · writing a suggestion…" : suggestionError && wanted ? `Commit Message · no suggestion: ${suggestionError.slice(0, 120)}` : "Commit Message";
  }
  const text = $derived(merge !== null ? stripComments(message) : message.trim());
  const canCommit = (withAmend: boolean) => !committing && !unmerged.length && text !== "" && (withAmend || staged > 0);
  async function commit(withAmend = amend, noVerify = false) {
    if (!canCommit(withAmend)) return;
    committing = true;
    error = "";
    const cmd = ["git commit", withAmend && "--amend", signoff && "--signoff", noVerify && "--no-verify"].filter(Boolean).join(" ");
    try {
      await runGit(tab, cmd, { Commit: { repo: tab.path, message: text, amend: withAmend, signoff, no_verify: noVerify } });
      addMessage(text);
      message = ""; amend = false; amendText = ""; prefilled = null;
      // new HEAD + history, and the (now smaller) change list, at the same time
      await Promise.all([reloadTab(tab), onchanged()]);
    } catch (e) {
      if (e !== CANCELLED) error = String(e);
      await onchanged();
    } finally {
      committing = false;
    }
  }
  async function run(cmd: string, req: Req) {
    error = "";
    try { await runGit(tab, cmd, req); } catch (e) { if (e !== CANCELLED) error = String(e); }
    confirmAbort = false;
    await Promise.all([reloadTab(tab), onchanged()]);
  }
  const abortMerge = () => run("git merge --abort", { AbortMerge: { repo: tab.path } });
  const stageUnmerged = () => run(`git add ${unmerged.join(" ")}`, { Stage: { repo: tab.path, paths: unmerged } });

  function advancedMenu(e: MouseEvent) {
    showMenu(e.currentTarget as HTMLElement, [
      { label: "Amend Previous Commit (--amend)", checked: amend, disabled: !tab.info.oid, run: () => void toggleAmend() },
      "-",
      { label: "Commit without Commit Hooks (--no-verify)", disabled: !canCommit(false), run: () => void commit(false, true) },
      { label: "Amend Commit without Commit Hooks (--amend --no-verify)", disabled: !tab.info.oid || !canCommit(true), run: () => void commit(true, true) },
    ]);
  }
  function historyMenu(at: HTMLElement) {
    showMenu(at, app.messages.length
      ? app.messages.map((m) => ({ label: m.split("\n")[0], run: () => { message = m; view?.focus(); } }))
      : [{ label: "No previous messages", disabled: true }]);
  }
  let historyBtn = $state<HTMLButtonElement>();
  function setUserDetails() {
    showOverlay({
      placeholder: "Your name", pills: ["User Details"], items: [], text: true,
      pick: (n) => {
        const name = n.label.trim();
        if (!name) return;
        return {
          placeholder: "Your email address", pills: ["User Details", name], items: [], text: true,
          pick: (m) => {
            const email = m.label.trim();
            if (!email) return;
            hideOverlay();
            void run(`git config --global user.name/user.email`, { SetIdentity: { repo: tab.path, name, email } }).then(loadIdentity);
          },
        };
      },
    });
  }
  $effect(() => {
    const v = new EditorView({
      parent: host!,
      doc: untrack(() => message),
      extensions: [
        history(),
        keymap.of([{ key: "Mod-Enter", run: () => { void commit(); return true; } }, { key: "Tab", run: () => acceptSuggestion() }, ...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": "Commit message", spellcheck: "true" }),
        hint.of(cmPlaceholder("Commit Message")),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) message = u.state.doc.toString();
          if (u.focusChanged) focused = u.view.hasFocus;
          const head = u.state.selection.main.head, line = u.state.doc.lineAt(head);
          caret = { line: line.number, col: head - line.from + 1 };
        }),
      ],
    });
    view = v;
    return () => { v.destroy(); view = null; };
  });
  // message set from outside (history, merge prefill, amend, cleared after a commit) -> the editor
  $effect(() => {
    const m = message;
    if (view && view.state.doc.toString() !== m) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: m } });
  });
  $effect(() => { view?.dispatch({ effects: hint.reconfigure(cmPlaceholder(placeholderFor(suggestion))) }); });

  const scope = tabScope();
  $effect(() => {
    if (!scope.active()) return;
    const offs = [
      registerCommand("commit", { run: () => commit() }),
      registerCommand("generate_commit_message", { caption: "Generate Commit Message", disabled: staged ? (llm.writing ? "A commit message is being written." : undefined) : "Nothing is staged.", run: generateNow }),
      registerCommand("show_commit_message_history", { run: () => { if (historyBtn) historyMenu(historyBtn); } }),
    ];
    return () => offs.forEach((off) => off());
  });
  const label = $derived(committing ? "Committing…" : amend ? "Amend commit" : staged ? `Commit ${staged} file${staged === 1 ? "" : "s"}` : "Nothing to commit");
</script>

<form class="commitbox" onsubmit={(e) => { e.preventDefault(); void commit(); }}>
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  <div class="msgrow">
    <div class="msged" bind:this={host}></div>
    {#if suggestion}<div class="sugg" role="status" data-testid="commit-suggestion">{suggestion} <span class="kbd">Tab</span></div>{/if}
    <button type="button" class="ib hist" bind:this={historyBtn} aria-label="Message history" title="Message history" onclick={(e) => historyMenu(e.currentTarget)}><svg class="i"><use href="#i-down" /></svg></button>
  </div>
  <div class="ft">
    {#if focused}
      <span class="who">Line {caret.line}, Column {caret.col}</span>
    {:else if identity === ""}
      <button type="button" class="who link" onclick={setUserDetails}>Click here to set user details</button>
    {:else}
      <span class="who">{identity ?? ""}</span>
    {/if}
    {#if merge !== null}
      {#if confirmAbort}
        <button type="button" class="btn danger" onclick={abortMerge}>Really abort the merge</button>
        <button type="button" class="btn" onclick={() => (confirmAbort = false)}>Cancel</button>
      {:else}
        <button type="button" class="btn" onclick={() => (confirmAbort = true)}>Abort merge</button>
      {/if}
    {/if}
    {#if unmerged.length}
      <button type="button" class="primary" onclick={stageUnmerged}>Stage all unmerged files to continue</button>
    {:else}
      <label><input type="checkbox" checked={amend} onchange={toggleAmend} disabled={!tab.info.oid} /> Amend</label>
      <label><input type="checkbox" bind:checked={signoff} /> Sign off</label>
      <div class="split commit">
        <button class="primary" disabled={!canCommit(amend)}>{label}</button>
        <button type="button" class="primary dd" aria-label="Advanced commit options" title="Advanced Commit" onclick={advancedMenu}><svg class="i"><use href="#i-down" /></svg></button>
      </div>
    {/if}
  </div>
</form>
