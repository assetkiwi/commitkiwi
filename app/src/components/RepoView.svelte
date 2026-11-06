<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { Tab } from "../lib/state.svelte";
  import { LAYOUTS, app, getPreference, hostOf, onTabChange, openInEditor, openRepo, reloadTab, setDirty, setHidden, setLayout, setPreference } from "../lib/state.svelte";
  import { llm } from "../lib/llm.svelte";
  import { CANCELLED, journal, runGit } from "../lib/jobs.svelte";
  import { consoleState } from "../lib/journal";
  import { fullRef } from "../lib/refs";
  import { registerCommand, runCommand } from "../lib/commands";
  import { hideOverlay, showMenu, showOverlay, ui, type OverlayStep } from "../lib/ui.svelte";
  import { copyLater } from "../lib/clipboard";
  import { provideTabScope } from "../lib/tabScope";
  import { contextVars, showContextMenu } from "../lib/mainMenu";
  import { ACTIONS, BRANCH_ON_COMMIT, COMMIT, REMOTE_BRANCH_ON_COMMIT, TAG, joinMenus } from "../lib/contextMenus";
  import { fillMenu } from "../lib/menu";
  import { fillArgv, fillSelector, nextSelector, type Selector } from "../lib/customGit";
  import { platform } from "../lib/keys.svelte";
  import { sideColumns, visibleSide, type Side } from "../lib/layout";
  import { forGit, isEmptyQuery, parseSearch } from "../lib/search";
  import { positionOf } from "../lib/collapse";
  import { api } from "../lib/api";
  import { MERGE_FLAGS, PULL_OPTIONS, PUSH_OPTIONS, RESET_MODES, hardResetLoss, isUnmerged, pushTarget, refNameError, remainingFlags, remoteUrlError, sequenceTitle, splitRemote, type ResetMode } from "../lib/branchOps";
  import { planCaption, undoPlan, undoStacks, type UndoPlan } from "../lib/undo";
  import type { Commit, RefItem, RefKind, Req, RewriteAction, Stash, Status } from "../lib/types";
  import Sidebar from "./Sidebar.svelte";
  import CommitList from "./CommitList.svelte";
  import CommitDetail from "./CommitDetail.svelte";
  import FilesPane from "./FilesPane.svelte";
  import FileView from "./FileView.svelte";
  import WorkingDir from "./WorkingDir.svelte";
  import SearchBar from "./SearchBar.svelte";
  import Console from "./Console.svelte";
  import MergeTool from "./MergeTool.svelte";
  import ForgeRequest from "./ForgeRequest.svelte";
  import BranchCleanup from "./BranchCleanup.svelte";
  import RebaseEditor from "./RebaseEditor.svelte";
  import { requestNoun } from "../lib/forge";

  const CAPTION: Record<Side, string> = { locations: "Locations", commits: "Commits", files: "Files" };

  let { tab }: { tab: Tab } = $props();
  // every open tab stays mounted (App.svelte hides the others): its commands and modes count only while shown
  const active = $derived(app.active === tab.id);
  const tabId = untrack(() => tab.id); // a RepoView lives for one tab (App.svelte keys them by id)
  ui.tabModes[tabId] = {};
  const modes = ui.tabModes[tabId];
  provideTabScope({ active: () => active, modes });
  $effect(() => () => { delete ui.tabModes[tabId]; });
  /** which of Commits/Files drives the details pane */
  let pane = $state<"commits" | "files">("commits");
  /** the visible tab of the (at most one) tabbed sidebar column */
  let shown = $state<Side>("commits");
  let selected = $state<Commit | null>(null);
  let from = $state<Commit | null>(null); // oldest commit of a multi-selection
  let file = $state<string | null>(null); // Tree file shown in the details pane
  let fileAt = $state<string | null>(null); // the commit that file is shown at (Blame from a menu); null = treeOid
  let fileMode = $state<"file" | "blame" | "history">("file"); // the mode a file opened by Blame… / File History… starts in
  let mergeFile = $state<string | null>(null); // the unmerged file open in the merge tool
  let editingMsg = $state<string | null>(null); // the commit whose message is being edited (Edit Commit Message)
  let request = $state<{ source: string | null } | null>(null); // the Create Pull/Merge Request dialog
  let cleanup = $state(false); // the Clean Up Branches dialog
  let rebaseFrom = $state<{ from: string | null } | null>(null); // the interactive rebase editor (null start: the unpushed commits)
  let commitFile = $state<string | null>(null); // file tab of the selected commit
  let workFocus = $state<string | null>(null); // file tab of the working directory: `u:`/`s:` + path
  let filesMode = $state<"changes" | "tree">("changes");
  let filters = $state({ locations: false, files: false });
  let target = $state<{ index: number; n: number } | null>(null);
  let notice = $state("");
  let view = $state<"commit" | "work" | "stash">("commit");
  let stashSel = $state<Stash | null>(null);
  // the shown stash was popped or dropped: back to the commit view
  $effect(() => { if (view === "stash" && !tab.refs.stashes.some((s) => s.oid === stashSel?.oid)) view = "commit"; });
  let work = $state.raw<Status | null>(null);
  let workKey = "";
  let seq = 0;
  const host = $derived(hostOf(tab.location));
  // Files shows the tree of the commit selected in Commits (HEAD until one is selected).
  const treeOid = $derived(selected?.oid ?? tab.info.oid);

  // A different commit may not have this file.
  $effect(() => { void [selected?.oid, from?.oid]; file = null; fileAt = null; commitFile = null; });
  /** what the Files column highlights (the open file tab) */
  const current = $derived(filesMode === "tree" ? (pane === "files" ? file && `t:${file}` : null)
    : view === "work" ? workFocus
    : view === "commit" ? commitFile && `c:${commitFile}` : null);

  async function refreshWork() {
    try {
      const s = await api.status(tab.location, tab.path);
      const key = JSON.stringify(s);
      if (key !== workKey) { workKey = key; work = s; } // identical status: no re-render
      setDirty(tab, s.files.length > 0);
    } catch { /* repo busy or briefly unavailable: keep showing the last status */ }
  }
  /** HEAD or refs moved outside this view (a terminal, the watcher): reload the tab when they really differ */
  async function refreshRefs() {
    try {
      const [info, refs] = await Promise.all([api.open(tab.location, tab.path), api.refs(tab.location, tab.path)]);
      if (JSON.stringify([info, refs]) !== JSON.stringify([tab.info, tab.refs])) await reloadTab(tab);
    } catch { /* briefly unavailable: the next change tries again */ }
  }
  // File events (M8) drive refreshes; the window regaining focus refreshes too.
  $effect(() => onTabChange(tab.id, (c) => { if (c.work) void refreshWork(); if (c.refs) void refreshRefs(); }));
  // The first status as soon as the view exists (with file events nothing else would ask: the old "Checking…"
  // that never ended after a tab switch), and again when a tab without file events is shown: in the background,
  // the last status stays on screen meanwhile.
  $effect(() => { if (active && (untrack(() => work) === null || tab.watching !== null)) untrack(refreshWork); });
  // Polling only where there are no file events (`tab.watching` is the reason) or until the watcher answers.
  // Throttled by how slow `git status` is on this repo, paused when hidden or not the shown tab.
  $effect(() => {
    let stop = false;
    (async () => {
      let t = performance.now();
      while (!stop) {
        await new Promise((r) => setTimeout(r, Math.max(3000, (performance.now() - t) * 4)));
        t = performance.now();
        if (!stop && !document.hidden && active && tab.watching !== null) await refreshWork();
      }
    })();
    const onFocus = () => { if (active) void refreshWork(); };
    window.addEventListener("focus", onFocus);
    return () => { stop = true; window.removeEventListener("focus", onFocus); };
  });
  const counts = $derived.by(() => {
    const f = work?.files ?? [];
    return {
      unstaged: f.filter((x) => x.kind === "untracked" || (x.kind === "changed" && x.worktree !== ".")).length,
      staged: f.filter((x) => x.kind === "changed" && x.index !== ".").length,
      conflicts: f.filter((x) => x.kind === "conflicted").length,
      total: f.length,
    };
  });
  const files = (n: number, what: string) => `${n} ${what} file${n === 1 ? "" : "s"}`;
  // The pending-changes row: counts, then what committing would do.
  const pending = $derived(!work ? ["Checking…", ""]
    : counts.conflicts || work.merge !== null ? [[files(counts.conflicts, "unmerged"), counts.staged && files(counts.staged, "staged")].filter(Boolean).join(", "), "Merge Changes"]
    : counts.total ? [[counts.staged && files(counts.staged, "staged"), counts.unstaged && files(counts.unstaged, "unstaged")].filter(Boolean).join(", "), "Commit Changes"]
    : ["No changes", ""]);
  const showWork = () => { pane = "commits"; view = "work"; };
  const workOp = (cmd: string, list: string[], req: (paths: string[]) => Req) => (list.length ? op(`${cmd} ${list.join(" ")}`, req(list)) : undefined);
  const workFiles = (test: (f: Status["files"][number]) => boolean) => (work?.files ?? []).filter(test).map((f) => f.path);

  async function jumpTo(oid: string) {
    notice = "";
    ui.sidebar = true; // the commit list is part of the side bar
    try {
      const index = await api.locate(tab.location, tab.path, oid, tab.hidden);
      if (index === null) { notice = tab.hidden.length ? "That commit is not in the graph (it may be on a hidden branch)." : "That commit is not reachable from any branch, tag or remote."; return; }
      if (found && positionOf(found.rows, index) < 0) search = null; // not a result: back to the full list
      pane = "commits";
      if (shown === "files") shown = "commits";
      view = "commit";
      target = { index, n: ++seq };
    } catch (e) { notice = String(e); }
  }

  // ---- search mode (⌘F): the commit list shows only the matching rows
  let search = $state<string | null>(null); // the query; null = not searching
  let found = $state.raw<{ rows: Int32Array; truncated: boolean } | null>(null);
  let searchErr = $state("");
  let searchFocus = $state(0);
  let hit = 0; // index into found.rows for next/previous
  let searchSeq = 0;
  $effect(() => { modes.search_mode = search !== null; });
  $effect(() => {
    const text = search, hidden = tab.hidden;
    void tab.rev; // rows are positions in the list: search again after a reload
    const q = text === null ? null : parseSearch(text);
    const n = ++searchSeq;
    if (!q || isEmptyQuery(q)) { found = null; searchErr = ""; return; }
    const t = setTimeout(() => {
      api.search(tab.location, tab.path, forGit(q), hidden).then((r) => {
        if (n !== searchSeq) return;
        found = { rows: Int32Array.from(r.rows), truncated: r.truncated };
        searchErr = "";
        hit = 0;
      }).catch((e) => { if (n === searchSeq) { found = null; searchErr = String(e); } });
    }, 250);
    return () => clearTimeout(t);
  });
  const searchInfo = $derived(searchErr || (!found ? "" : !found.rows.length ? "No results"
    : `${found.truncated ? "First " : ""}${found.rows.length} result${found.rows.length === 1 ? "" : "s"}`));
  function openSearch(query?: string) {
    ui.sidebar = true; // results show in the commit list
    if (query !== undefined) search = query;
    else search ??= "";
    searchFocus++;
    pane = "commits";
    if (shown === "files") shown = "commits";
    view = "commit";
  }
  function stepResult(dir: 1 | -1) {
    const rows = found?.rows;
    if (!rows?.length) return;
    hit = (hit + dir + rows.length) % rows.length;
    pane = "commits";
    view = "commit";
    target = { index: rows[hit], n: ++seq };
  }
  $effect(() => {
    if (!active) return;
    const offs = [
      registerCommand("toggle_search", {
        caption: "Search",
        run: () => { if (search !== null && document.activeElement?.closest("[data-control=search_input]")) search = null; else openSearch(); },
      }),
      // the `search {query}` command (e.g. from a branch's context menu)
      registerCommand("search", { run: (a) => openSearch(typeof a.query === "string" ? a.query : undefined) }),
      registerCommand("exit_search", { run: () => { search = null; } }),
      // the ✨ toggle: opens the search in natural-language mode, or switches the mode while it is open
      registerCommand("toggle_natural_search", {
        caption: "Search: Natural Language Mode",
        run: () => {
          if (!llm.models.some((m) => m.installed)) {
            app.notice = "Natural-language search needs the commit message model (Preferences > Git).";
            runCommand("download_commit_model");
            return;
          }
          setPreference("natural_search", search === null || !getPreference("natural_search"));
          openSearch();
        },
      }),
      registerCommand("find_next", { run: () => stepResult(1) }),
      registerCommand("find_prev", { run: () => stepResult(-1) }),
    ];
    return () => offs.forEach((off) => off());
  });

  // ---- back/forward: a history of what the details pane showed ("work" or a commit oid)
  let hist = $state.raw<string[]>([]);
  let at = $state(-1);
  let pendingNav: string | null = null; // where back/forward is heading; selections on the way are not history
  const here = $derived(view === "work" ? "work" : (selected?.oid ?? null));
  $effect(() => {
    const loc = here;
    if (!loc) return;
    untrack(() => {
      if (pendingNav !== null) { if (loc === pendingNav) pendingNav = null; return; }
      if (loc === hist[at]) return;
      hist = [...hist.slice(Math.max(0, at - 99), at + 1), loc];
      at = hist.length - 1;
    });
  });
  async function navigate(step: 1 | -1) {
    const to = hist[at + step];
    if (to === undefined) return;
    at += step;
    if (to === here) return;
    pendingNav = to;
    if (to === "work") { pane = "commits"; view = "work"; return; }
    await jumpTo(to);
    if (notice) pendingNav = null; // the commit is gone (history rewritten)
  }

  // ---- git write commands: queued in this repo's console (one at a time, in order), then everything reloads
  /** `onError`: handles git's error itself (true = handled, no banner); `undo`: this is an Undo/Redo of that entry */
  async function op(cmd: string, req: Req, onError?: (e: string) => boolean, undo?: { of: number; redo: boolean }) {
    notice = "";
    try { await runGit(tab, cmd, req, undo); } catch (e) { if (e !== CANCELLED && !onError?.(String(e))) notice = String(e); }
    try { await Promise.all([refreshWork(), reloadTab(tab)]); } catch (e) { notice ||= String(e); }
  }
  /** merge/rebase/cherry-pick/revert: a conflict stops half-way; show the Working Directory to resolve it */
  async function conflictOp(cmd: string, req: Req) {
    await op(cmd, req);
    if (work?.files.some((f) => f.kind === "conflicted")) showWork();
  }
  const repo = $derived(tab.path);
  const stash = (flags: string[]) => op(["git stash push", ...flags].join(" "), { Stash: { repo, flags } });
  const sync = (verb: "pull" | "fetch" | "push", flags: string[]) => {
    const r = { repo, flags };
    return op([`git ${verb}`, ...flags].join(" "), verb === "pull" ? { Pull: r } : verb === "fetch" ? { Fetch: r } : { Push: r });
  };

  const STASH_FLAGS: [string, string][] = [
    ["--include-untracked", "Also stash untracked files"],
    ["--keep-index", "Keep staged changes in the working copy"],
    ["--staged", "Stash only the staged changes"],
  ];
  function stashPrompt(flags: string[]): OverlayStep {
    return {
      placeholder: "Choose flags", pills: ["Stash", ...flags],
      items: [{ label: "stash", detail: "Select to run command", value: null },
        ...STASH_FLAGS.filter(([f]) => !flags.includes(f)).map(([f, d]) => ({ label: f, detail: d, value: f }))],
      pick: (item) => {
        if (item.value === null) { hideOverlay(); void stash(flags); return; }
        return stashPrompt([...flags, item.value as string]);
      },
    };
  }
  /** Pull…: one pill, then the options */
  function pullPrompt() {
    showOverlay({
      placeholder: "Pull Options", pills: ["Pull"], items: PULL_OPTIONS.map((o) => ({ label: o.label, detail: o.detail, value: o })),
      pick: (item) => { const o = item.value as (typeof PULL_OPTIONS)[number]; hideOverlay(); void sync(o.verb, o.flags); },
    });
  }
  /** Push…: Push › branch › remote › options; branch and remote default to the current branch and its
   *  upstream (steps only for what is unknown); --force asks again */
  function pushPrompt(a: Record<string, unknown>) {
    const local = refsOf("branch");
    const optionsStep = (b: string, remote: string): OverlayStep => ({
      placeholder: "Push Options", pills: ["Push", b, remote], items: PUSH_OPTIONS.map((o) => ({ label: o.label, detail: o.detail, value: o })),
      pick: (item) => {
        const o = item.value as (typeof PUSH_OPTIONS)[number];
        const cmd = ["git push", ...o.flags, remote, b].join(" ");
        const run = () => void op(cmd, { Push: { repo, flags: o.flags, remote, branch: b } });
        if (!o.confirm) return finish(run);
        return yesNo(["Push", b, remote, ...o.flags], "Force push?", "Force push", `Replaces ${b} on ${remote} with your local branch: commits only on the remote are lost`, run);
      },
    });
    const remoteStep = (b: string): OverlayStep | null => {
      const t = pushTarget(b, local.find((r) => r.name === b)?.upstream, tab.refs.remotes);
      if (t.remote) return optionsStep(b, t.remote);
      if (!tab.refs.remotes.length) { notice = "This repository has no remotes."; return null; }
      return listStep(["Push", b], "Remote", tab.refs.remotes.map((r) => ({ label: r, value: r })), (v) => optionsStep(b, v as string), Math.max(0, tab.refs.remotes.indexOf("origin")));
    };
    const branch = typeof a.branch === "string" ? a.branch : tab.info.branch;
    if (branch) { show(remoteStep(branch)); return; }
    show(listStep(["Push"], "Branch to push", local.map(refItem), (_, label) => remoteStep(label) ?? undefined));
  }

  // ---- remotes: add, rename, delete, update URL (commands add_remote / rename_remote / delete_remote / update_remote_url)
  function urlStep(pills: string[], run: (url: string) => unknown): OverlayStep {
    const step: OverlayStep = {
      placeholder: "Remote URL", pills, items: [], text: true,
      pick: (item) => {
        const error = remoteUrlError(item.label);
        return error ? { ...step, value: item.label, error } : finish(() => run(item.label.trim()));
      },
    };
    return step;
  }
  function remotePrompt(title: string, a: Record<string, unknown>, next: (remote: string) => void | OverlayStep) {
    if (typeof a.remote === "string") { const step = next(a.remote); if (step) showOverlay(step); return; }
    show(listStep([title], "Remote", tab.refs.remotes.map((r) => ({ label: r, value: r })), (v) => next(v as string)));
  }
  const addRemote = () => showOverlay(nameStep(["Add Remote"], "Remote Name", tab.refs.remotes.length ? "" : "origin", (name) =>
    urlStep(["Add Remote", name], (url) => op(`git remote add ${name} ${url}`, { AddRemote: { repo, name, url } }))));
  const renameRemote = (a: Record<string, unknown>) => remotePrompt("Rename Remote", a, (r) => nameStep(["Rename Remote", r], "New Remote Name", r, (name) =>
    finish(() => op(`git remote rename ${r} ${name}`, { RenameRemote: { repo, name: r, new_name: name } }))));
  const deleteRemote = (a: Record<string, unknown>) => remotePrompt("Delete Remote", a, (r) =>
    yesNo(["Delete Remote", r], "Delete this remote?", `Delete ${r}`, `git remote remove ${r}: its remote-tracking branches go too`, () => void op(`git remote remove ${r}`, { DeleteRemote: { repo, name: r } })));
  const updateRemoteUrl = (a: Record<string, unknown>) => remotePrompt("Update Remote URL", a, (r) =>
    urlStep(["Update Remote URL", r], (url) => op(`git remote set-url ${r} ${url}`, { SetRemoteUrl: { repo, name: r, url } })));

  // ---- M5a branch/ref overlays: a chip per answer, then the next argument (fuzzy list or typed text)
  const KIND: Record<RefKind, string> = { branch: "L", remote: "R", tag: "T" };
  const refsOf = (...kinds: RefKind[]) => tab.refs.refs.filter((r) => kinds.includes(r.kind));
  const refItem = (r: RefItem) => ({ label: r.name, icon: KIND[r.kind], value: fullRef(r.kind, r.name) });
  const short = (oid: string) => oid.slice(0, 7);
  /** start points / targets: the selected commit, HEAD, then refs of `kinds` (values: commit ids or full ref names) */
  function revItems(kinds: RefKind[], head = true) {
    const sel = view === "commit" && selected ? [{ label: `Selected commit ${short(selected.oid)}`, detail: selected.subject, value: selected.oid }] : [];
    const h = head && tab.info.oid ? [{ label: "HEAD", detail: `${tab.info.branch ?? "detached"} ${short(tab.info.oid)}`, value: tab.info.oid }] : [];
    return [...sel, ...h, ...refsOf(...kinds).map(refItem)];
  }
  const labelOf = (rev: string) => rev.replace(/^refs\/(heads|remotes|tags)\//, "").replace(/^[0-9a-f]{40}$/, (o) => short(o));
  /** a free-text name step; a name git would refuse stays open with the reason */
  function nameStep(pills: string[], placeholder: string, value: string, next: (name: string) => void | OverlayStep): OverlayStep {
    const step: OverlayStep = {
      placeholder, pills, items: [], text: true, value,
      pick: (item) => {
        const name = item.label.trim();
        const error = refNameError(name);
        return error ? { ...step, value: item.label, error } : next(name);
      },
    };
    return step;
  }
  function listStep(pills: string[], placeholder: string, items: OverlayStep["items"], next: (value: unknown, label: string) => ReturnType<OverlayStep["pick"]>, selectedRow = 0): OverlayStep | null {
    if (!items.length) { notice = "Nothing to choose from."; return null; }
    return { placeholder, pills, items, selected: selectedRow, pick: (item) => next(item.value, item.label) };
  }
  // ---- the custom `git` command (user palette entries and menu items)
  const SELECT_KINDS: Partial<Record<Selector, RefKind[]>> = {
    select_ref: ["branch", "remote", "tag"], select_branch: ["branch", "remote"], select_local_branch: ["branch"],
    select_remote_branch: ["remote"], select_tag: ["tag"],
  };
  /** argv with the repository's `$variables` filled ($working_dir, $commit, …; a menu filled its own already), then
   *  one overlay step per selector ($select_branch, $text, …), then a console job */
  function customGit(a: Record<string, unknown>) {
    if (typeof a.refused === "string") throw new Error(a.refused);
    const head = tab.info.oid, commit = selected?.oid ?? head;
    const argv = fillArgv(a.argv, {
      working_dir: tab.path, git_dir: tab.path, commit, short_commit: commit && short(commit), head, head_ref: tab.info.branch ?? (head && short(head)),
    });
    return gitStep(argv).then(show);
  }
  async function gitStep(argv: string[]): Promise<OverlayStep | undefined> {
    const sel = nextSelector(argv);
    const label = `git ${argv.join(" ")}`;
    if (!sel) { hideOverlay(); void op(label, { GitCustom: { repo, argv } }); return; }
    const then = (v: string) => gitStep(fillSelector(argv, sel, v));
    const pills = [label];
    if (sel === "text") return { placeholder: "Text", pills, items: [], text: true, pick: (item) => then(item.label) };
    const items = sel === "select_commit"
      ? (await api.log(tab.location, repo, 0, 500, tab.hidden)).map((c) => ({ label: c.subject, detail: short(c.oid), value: c.oid }))
      : sel === "select_stash" ? tab.refs.stashes.map((st) => ({ label: st.message, detail: st.name, value: st.name }))
      : refsOf(...SELECT_KINDS[sel]!).map((r) => ({ label: r.name, icon: KIND[r.kind], value: r.name }));
    return listStep(pills, sel.replace("select_", "").replace("_", " "), items, (v) => then(v as string)) ?? undefined;
  }

  /** Ask before a destructive step; with Preferences → Git → confirm off it just runs (nothing to show). */
  const yesNo = (pills: string[], placeholder: string, yes: string, detail: string, run: () => void, error?: string): OverlayStep | undefined => {
    if (!app.prefs.confirm_destructive) { hideOverlay(); run(); return undefined; }
    return {
      placeholder, pills, error, items: [{ label: yes, detail, value: true }, { label: "Cancel", value: false }],
      pick: (item) => { hideOverlay(); if (item.value) run(); },
    };
  };
  const finish = (run: () => unknown) => { hideOverlay(); void run(); };
  const show = (step: OverlayStep | null | undefined) => { if (step) showOverlay(step); };
  const headRow = (items: { value?: unknown }[]) => Math.max(0, items.findIndex((i) => i.value === (tab.info.branch && `refs/heads/${tab.info.branch}`)));

  /** Checkout…: local branches and tags (local_refs/tag_refs), remote branches with remote_refs */
  function checkoutPrompt(a: Record<string, unknown>) {
    if (typeof a.branch === "string") { checkoutRev(a.branch); return; }
    const kinds: RefKind[] = [...(a.local_refs === false ? [] : ["branch" as const]), ...(a.remote_refs === true ? ["remote" as const] : []), ...(a.tag_refs === false ? [] : ["tag" as const])];
    // the palette's "Branch: Check Out Remote as New Local…" is checkout_branch {create_branch, remote_refs}
    if (a.create_branch === true) { createBranchPrompt(a, kinds); return; }
    const items = refsOf(...kinds).map(refItem);
    show(listStep(["Checkout"], "Branch or Tag Name", items, (v) => { hideOverlay(); checkoutRev(v as string); }, headRow(items)));
  }
  function checkoutRev(rev: string) {
    const remote = rev.startsWith("refs/remotes/") && splitRemote(tab.refs.remotes, rev.slice(13));
    if (remote) {
      // a remote branch: its local branch (created tracking it when missing)
      const local = remote[1];
      if (refsOf("branch").some((r) => r.name === local)) void op(`git checkout ${local}`, { Checkout: { repo, name: local } });
      else void op(`git checkout -b ${local} ${rev.slice(13)}`, { CreateBranch: { repo, name: local, from: rev, checkout: true } });
      return;
    }
    const name = labelOf(rev);
    void op(`git checkout ${name}`, { Checkout: { repo, name: /^[0-9a-f]{40}$/.test(rev) ? rev : name } });
  }

  /** Create Branch…: name, start point (unless `from`), then whether to check it out. `kinds` set: start point first. */
  function createBranchPrompt(a: Record<string, unknown>, kinds?: RefKind[]) {
    const title = "Create Branch";
    const checkoutStep = (name: string, from: string | null, fromLabel: string): OverlayStep => ({
      placeholder: "Check it out?", pills: [title, name, ...(from ? [fromLabel] : [])],
      items: [{ label: "Create and check out", detail: `git checkout -b ${name}`, value: true }, { label: "Create only", detail: `git branch ${name}`, value: false }],
      pick: (item) => finish(() => op(`git ${item.value ? "checkout -b" : "branch"} ${name}${from ? ` ${fromLabel}` : ""}`, { CreateBranch: { repo, name, from, checkout: item.value as boolean } })),
    });
    const from = typeof a.from === "string" ? a.from : null;
    if (kinds) {
      show(listStep([title], "Start Point", refsOf(...kinds).map(refItem), (v, label) => {
        const rev = v as string;
        const guess = rev.startsWith("refs/remotes/") ? (splitRemote(tab.refs.remotes, label)?.[1] ?? "") : "";
        return nameStep([title, label], "Branch Name", guess, (name) => checkoutStep(name, rev, label));
      }));
      return;
    }
    const prefix = typeof a.prefix === "string" && a.prefix ? `${a.prefix.replace(/\/+$/, "")}/` : "";
    showOverlay(nameStep([title], "Branch Name", prefix, (name) => from ? checkoutStep(name, from, labelOf(from))
      : listStep([title, name], "Start Point", revItems(["branch", "remote", "tag"]), (v, label) => checkoutStep(name, v === tab.info.oid ? null : (v as string), label)) ?? undefined));
  }

  function renamePrompt(a: Record<string, unknown>) {
    const rename = (old: string) => nameStep(["Rename Branch", old], "New Branch Name", old, (name) =>
      finish(() => op(`git branch -m ${old} ${name}`, { RenameBranch: { repo, branch: old, name } })));
    if (typeof a.branch === "string") { showOverlay(rename(a.branch)); return; }
    const items = refsOf("branch").map(refItem);
    show(listStep(["Rename Branch"], "Branch Name", items, (_, label) => rename(label), headRow(items)));
  }

  /** Delete Branch…: local (unmerged ones need a second, forced step) or, with remote_refs, a remote branch (confirmed) */
  function deletePrompt(a: Record<string, unknown>) {
    const run = (rev: string) => {
      const label = labelOf(rev);
      if (rev.startsWith("refs/remotes/")) {
        const [remote, branch] = splitRemote(tab.refs.remotes, label) ?? [label, ""];
        show(yesNo(["Delete Remote Branch", label], "Delete it on the remote?", `Delete ${branch} on ${remote}`, `git push ${remote} --delete ${branch}`,
          () => void op(`git push ${remote} --delete ${branch}`, { DeleteRemoteBranch: { repo, branch: rev } })));
        return;
      }
      hideOverlay();
      void op(`git branch -d ${label}`, { DeleteBranch: { repo, branch: label, force: false } }, (e) => {
        if (!isUnmerged(e)) return false;
        show(yesNo(["Delete Branch", label], "Branch is not fully merged", "Force delete", `git branch -D ${label}: its unmerged commits are lost`,
          () => void op(`git branch -D ${label}`, { DeleteBranch: { repo, branch: label, force: true } }), e));
        return true;
      });
    };
    if (typeof a.ref === "string") { run(a.ref); return; }
    const kinds: RefKind[] = [...(a.local_refs === false ? [] : ["branch" as const]), ...(a.remote_refs === true ? ["remote" as const] : [])];
    show(listStep([a.remote_refs === true && a.local_refs === false ? "Delete Remote Branch" : "Delete Branch"], "Branch Name",
      refsOf(...kinds).filter((r) => !r.head).map(refItem), (v) => run(v as string)));
  }

  function mergeFlags(rev: string, label: string, flags: string[]): OverlayStep {
    return {
      placeholder: "Choose flags", pills: ["Merge", label, ...flags],
      items: [{ label: "merge", detail: "Select to run command", value: null },
        ...remainingFlags(MERGE_FLAGS, flags).map((f) => ({ label: f.flag, detail: f.detail, value: f.flag }))],
      pick: (item) => item.value === null
        ? finish(() => conflictOp(["git merge", ...flags, label].join(" "), { Merge: { repo, rev, flags } }))
        : mergeFlags(rev, label, [...flags, item.value as string]),
    };
  }
  function mergePrompt(a: Record<string, unknown>) {
    if (typeof a.branch === "string") { showOverlay(mergeFlags(a.branch, labelOf(a.branch), [])); return; }
    show(listStep(["Merge"], "Branch to merge into the current one", revItems(["branch", "remote", "tag"], false).filter((i) => i.value !== `refs/heads/${tab.info.branch}`),
      (v, label) => mergeFlags(v as string, label, [])));
  }
  function rebasePrompt(a: Record<string, unknown>) {
    const run = (rev: string) => finish(() => conflictOp(`git rebase ${labelOf(rev)}`, { Rebase: { repo, onto: rev } }));
    const given = typeof a.branch === "string" ? a.branch : typeof a.commit === "string" ? a.commit : null;
    if (given) { run(given); return; }
    show(listStep(["Rebase"], `Rebase ${tab.info.branch ?? "HEAD"} onto`, revItems(["branch", "remote", "tag"], false).filter((i) => i.value !== `refs/heads/${tab.info.branch}`), (v) => run(v as string)));
  }
  /** Cherry-pick… / Revert…: one commit (the selected one, HEAD, or a branch/tag tip) */
  function commitPrompt(title: string, a: Record<string, unknown>, run: (rev: string, label: string) => void) {
    if (typeof a.commit === "string") { run(a.commit, labelOf(a.commit)); return; }
    show(listStep([title], "Commit", revItems(["branch", "remote", "tag"]), (v, label) => finish(() => run(v as string, labelOf(v as string) || label))));
  }

  function resetPrompt(a: Record<string, unknown>) {
    const branch = tab.info.branch ?? "HEAD";
    const modeStep = (rev: string, label: string): OverlayStep => ({
      placeholder: "Reset mode", pills: [`Reset ${branch}`, label],
      items: RESET_MODES.map(([m, d]) => ({ label: m, detail: d, value: m })),
      pick: async (item) => {
        const mode = item.value as ResetMode;
        const run = () => void op(`git reset --${mode} ${label}`, { Reset: { repo, rev, mode } });
        if (mode !== "hard") return finish(run);
        // hard: say what is lost before doing it
        const commits = tab.info.oid ? await api.countRange(tab.location, repo, rev, tab.info.oid).catch(() => 0) : 0;
        return yesNo([`Reset ${branch}`, label, "hard"], "Confirm hard reset", "Reset hard", "git reset --hard: ALL local changes are discarded", run,
          hardResetLoss(branch, commits, counts.total));
      },
    });
    const given = typeof a.commit === "string" ? a.commit : null;
    if (given) {
      const m = RESET_MODES.find(([x]) => x === a.mode)?.[0];
      const step = modeStep(given, labelOf(given));
      if (m) void Promise.resolve(step.pick({ label: m, value: m })).then((next) => { if (next) showOverlay(next); }); else showOverlay(step);
      return;
    }
    show(listStep([`Reset ${branch}`], "Reset to commit", revItems(["branch", "remote", "tag"], false), (v, label) => modeStep(v as string, labelOf(v as string) || label)));
  }

  /** Create Tag…: name, commit (unless `commit`), lightweight or annotated (+ message) */
  function createTagPrompt(a: Record<string, unknown>) {
    const kindStep = (name: string, rev: string): OverlayStep => ({
      placeholder: "Tag type", pills: ["Create Tag", name, labelOf(rev)],
      items: [{ label: "Lightweight", detail: `git tag ${name}`, value: false }, { label: "Annotated", detail: `git tag -a ${name} (with a message)`, value: true }],
      pick: (item) => {
        if (!item.value) return finish(() => op(`git tag ${name} ${labelOf(rev)}`, { CreateTag: { repo, name, rev, message: null } }));
        return {
          placeholder: "Tag message", pills: ["Create Tag", name, labelOf(rev), "annotated"], items: [], text: true,
          pick: (m) => {
            const message = m.label.trim();
            if (!message) return { ...kindStep(name, rev), error: "An annotated tag needs a message" };
            finish(() => op(`git tag -a ${name} ${labelOf(rev)}`, { CreateTag: { repo, name, rev, message } }));
          },
        };
      },
    });
    const given = typeof a.commit === "string" ? a.commit : null;
    showOverlay(nameStep(["Create Tag"], "Tag Name", "", (name) => given ? kindStep(name, given)
      : listStep(["Create Tag", name], "Commit", revItems(["branch", "remote", "tag"]), (v) => kindStep(name, v as string)) ?? undefined));
  }
  /** Delete Tag… / Push Tag… / Delete Remote Tag…: a tag (or `ref`), then the remote when there are several */
  function tagPrompt(title: string, a: Record<string, unknown>, run: (name: string, remote: string) => void, remote: boolean) {
    const withRemote = (name: string): void | OverlayStep => {
      if (!remote) return finish(() => run(name, ""));
      const rs = typeof a.remote === "string" ? tab.refs.remotes.filter((r) => r === a.remote) : tab.refs.remotes;
      if (!rs.length) { hideOverlay(); notice = typeof a.remote === "string" ? `No remote named ${a.remote}.` : "This repository has no remotes."; return; }
      if (rs.length === 1) return finish(() => run(name, rs[0]));
      return listStep([title, name], "Remote", rs.map((r) => ({ label: r, value: r })), (v) => finish(() => run(name, v as string))) ?? undefined;
    };
    if (typeof a.ref === "string") { const next = withRemote(labelOf(a.ref)); if (next) showOverlay(next); return; }
    show(listStep([title], "Tag Name", refsOf("tag").map(refItem), (_, label) => withRemote(label)));
  }
  const confirmRemoteTag = (name: string, remote: string) =>
    show(yesNo(["Delete Remote Tag", name], "Delete it on the remote?", `Delete ${name} on ${remote}`, `git push ${remote} --delete refs/tags/${name}`,
      () => void op(`git push ${remote} --delete refs/tags/${name}`, { DeleteRemoteTag: { repo, remote, name } })));

  function upstreamPrompt(a: Record<string, unknown>) {
    const pickUpstream = (branch: string) => listStep(["Set Upstream", branch], "Upstream branch", refsOf("remote").map(refItem),
      (v, label) => finish(() => op(`git branch -u ${label} ${branch}`, { SetUpstream: { repo, branch, upstream: v as string } })));
    const branch = typeof a.branch === "string" ? a.branch : null;
    if (branch) { show(pickUpstream(branch)); return; }
    const items = refsOf("branch").map(refItem);
    show(listStep(["Set Upstream"], "Branch", items, (_, label) => pickUpstream(label) ?? undefined, headRow(items)));
  }
  function unsetUpstream(a: Record<string, unknown>) {
    const branch = typeof a.branch === "string" ? a.branch : tab.info.branch;
    if (!branch) { notice = "HEAD is detached: no branch to unset the upstream of."; return; }
    return op(`git branch --unset-upstream ${branch}`, { SetUpstream: { repo, branch, upstream: null } });
  }

  // ---- a rebase/cherry-pick/revert stopped half-way: Continue / Skip / Abort (banner + commands)
  let confirmSeqAbort = $state(false);
  const seqOp = $derived(work?.op ?? null);
  $effect(() => { if (!seqOp) confirmSeqAbort = false; });
  const sequence = (action: "continue" | "skip" | "abort") => {
    confirmSeqAbort = false;
    return conflictOp(`git ${seqOp ?? "merge"} --${action}`, { Sequence: { repo, action } });
  };
  $effect(() => {
    const what = seqOp === "cherry-pick" ? "Cherry-pick" : seqOp === "revert" ? "Revert" : seqOp ? "Rebase" : null;
    if (!what || !active) return;
    const offs = [
      registerCommand("continue_operation", { caption: `${what}: Continue`, run: () => sequence("continue") }),
      registerCommand("skip_operation", { caption: `${what}: Skip Commit`, run: () => sequence("skip") }),
      registerCommand("abort_operation", { caption: `${what}: Abort`, run: () => sequence("abort") }),
    ];
    return () => offs.forEach((off) => off());
  });

  // ---- console (toggle_console, Esc): this repo's journal
  let consoleOpen = $state(false);
  $effect(() => { modes.console_visible = consoleOpen; });
  const conState = $derived(consoleState(journal.jobs, tab.id));
  const lastJob = $derived(journal.jobs.filter((j) => j.repo === tab.id).at(-1));

  // ---- Undo/Redo (git_undo / git_redo): HEAD and local refs back to before (after) a journal entry, lib/undo.ts
  const stacks = $derived(undoStacks(journal.jobs, tab.id));
  const repoNow = $derived({ branch: tab.info.branch, oid: tab.info.oid, busy: conState === "running", op: work?.op ?? (work && work.merge !== null ? "merge" : null) });
  const plans = $derived({ undo: undoPlan(stacks, false, repoNow), redo: undoPlan(stacks, true, repoNow) });
  // the backend's verdict on what the UI can't see (local changes in the way, refs moved outside the app)
  let refusal = $state<{ undo: string | null; redo: string | null }>({ undo: null, redo: null });
  $effect(() => {
    const { undo, redo } = plans;
    void work;
    void tab.rev;
    let live = true;
    const ask = (p: UndoPlan, isRedo: boolean): Promise<string | null> => (!p.job?.moved || p.reason ? Promise.resolve(null)
      : api.undoCheck(tab.location, repo, p.job.moved, isRedo, p.job.mode ?? "keep").then(() => null, (e) => String(e)));
    const t = setTimeout(() => void Promise.all([ask(undo, false), ask(redo, true)]).then(([u, r]) => { if (live) refusal = { undo: u, redo: r }; }), 150);
    return () => { live = false; clearTimeout(t); };
  });
  const undoNow = $derived({ ...plans.undo, reason: plans.undo.reason ?? refusal.undo });
  const redoNow = $derived({ ...plans.redo, reason: plans.redo.reason ?? refusal.redo });
  const refused = (p: UndoPlan) => (!p.reason ? undefined : !p.job ? p.reason : `Can't ${p.caption.replace(/^(Undo|Redo)/, (v) => v.toLowerCase())}: ${p.reason}`);
  function gitUndo(p: UndoPlan, redo: boolean) {
    if (!p.job?.moved) return;
    return op(p.caption, { Undo: { repo, moved: p.job.moved, redo, mode: p.job.mode ?? "keep", check: false } }, undefined, { of: p.job.id, redo });
  }
  $effect(() => {
    const u = undoNow, r = redoNow;
    if (!active) return;
    const offs = [
      registerCommand("git_undo", { caption: u.caption, menuCaption: planCaption(u), disabled: refused(u), run: () => gitUndo(u, false) }),
      registerCommand("git_redo", { caption: r.caption, menuCaption: planCaption(r), disabled: refused(r), run: () => gitUndo(r, true) }),
    ];
    return () => offs.forEach((off) => off());
  });

  // ---- hide/show refs in the graph (commands hide_ref / show_ref / hide_all_refs_except / show_all_refs)
  const allRefs = () => tab.refs.refs.map((r) => ({ ref: fullRef(r.kind, r.name), r }));
  function refPrompt(title: string, refs: ReturnType<typeof allRefs>, run: (ref: string) => void) {
    if (!refs.length) { notice = "No branches to choose from."; return; }
    showOverlay({
      placeholder: "Branch or Tag Name", pills: [title], items: refs.map(({ ref, r }) => ({ label: r.name, icon: KIND[r.kind], value: ref })),
      pick: (item) => { hideOverlay(); run(item.value as string); },
    });
  }
  const hideRef = (ref: string) => setHidden(tab, [...tab.hidden, ref]);
  const showRef = (ref: string) => setHidden(tab, tab.hidden.filter((h) => h !== ref));
  const hideAllExcept = (ref: string) => setHidden(tab, allRefs().map((x) => x.ref).filter((x) => x !== ref));

  // ---- worktrees and submodules (the gear menus in Locations)
  function addWorktreePrompt() {
    showOverlay({
      placeholder: "Folder for the new worktree (relative to the repository)", pills: ["Add Worktree"], items: [], text: true, value: `../${tab.info.name}-`,
      pick: (item) => {
        const path = item.label.trim();
        if (!path) return;
        return {
          placeholder: "Branch to check out", pills: ["Add Worktree", path],
          items: [{ label: "New branch", detail: "Named after the folder", value: null },
            ...tab.refs.refs.filter((r) => r.kind === "branch" && !r.head).map((r) => ({ label: r.name, icon: "L", value: r.name }))],
          pick: (b) => {
            hideOverlay();
            const branch = b.value as string | null;
            void op(`git worktree add ${path}${branch ? ` ${branch}` : ""}`, { AddWorktree: { repo, path, branch } });
          },
        };
      },
    });
  }
  function addSubmodulePrompt() {
    showOverlay({
      placeholder: "Repository URL", pills: ["Add Submodule"], items: [], text: true,
      pick: (item) => {
        const url = item.label.trim();
        if (!url) return;
        return {
          placeholder: "Path (empty: derived from the URL)", pills: ["Add Submodule", url], items: [], text: true,
          pick: (p) => {
            hideOverlay();
            const path = p.label.trim() || null;
            void op(`git submodule add ${url}${path ? ` ${path}` : ""}`, { AddSubmodule: { repo, url, path } });
          },
        };
      },
    });
  }
  // ---- F8 context-menu commands: each takes its target in args (a menu never acts on the current selection)
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  function need(v: unknown, what: string): string {
    const s = str(v);
    if (!s) throw new Error(`No ${what} given.`);
    return s;
  }
  /** Pop/Apply/Drop a stash by entry (`oid` must still match it; the backend checks again). Pop without one = newest. */
  function stashOp(action: "apply" | "pop" | "drop", a: Record<string, unknown>) {
    const stash = str(a.stash), oid = str(a.oid);
    if (!stash || !oid) return action === "pop" ? op("git stash pop", { PopStash: { repo } }) : undefined;
    const run = () => op(`git stash ${action} ${stash}`, { StashOp: { repo, stash, oid, action } });
    if (action !== "drop") return run();
    show(yesNo(["Drop Stash", stash], "Drop this stash?", `Drop ${stash}`, `git stash drop ${stash}: its changes are lost`, () => void run()));
  }
  const clearStashes = () => show(yesNo(["Clear All Stashes"], "Delete every stash?", `Clear ${tab.refs.stashes.length} stash${tab.refs.stashes.length === 1 ? "" : "es"}`,
    "git stash clear: all stashed changes are lost (no Undo)", () => void op("git stash clear", { ClearStashes: { repo } })));
  /** Revert/Cherry Pick Selected Commits: one queued job each (a failure or conflict stops the rest). `commits`: newest first. */
  async function eachCommit(kind: "revert" | "cherry-pick", a: Record<string, unknown>) {
    const commits = Array.isArray(a.commits) ? a.commits.filter((c): c is string => typeof c === "string") : [];
    // revert undoes the newest first; cherry-pick replays the oldest first
    const list = kind === "revert" ? commits : [...commits].reverse();
    await Promise.all(list.map((c) => kind === "revert"
      ? op(`git revert --no-edit ${short(c)}`, { Revert: { repo, rev: c } })
      : op(`git cherry-pick ${short(c)}`, { CherryPick: { repo, rev: c } })));
    if (work?.files.some((f) => f.kind === "conflicted")) showWork();
  }
  const refsAt = (oid: string) => tab.refs.refs.filter((r) => r.oid === oid).map((r) => fullRef(r.kind, r.name));
  /** Revert File / Cherry Pick File: the commit's patch of that file, reversed or forward, into the working directory */
  async function filePatch(a: Record<string, unknown>, mode: "discard" | "worktree") {
    const [commit, path] = [need(a.commit, "commit"), need(a.path, "file")];
    const p = await api.diff(tab.location, repo, commit, path, str(a.old_path), 3, false, str(a.from));
    if (!p.text.trim()) { notice = `${path}: no textual change to ${mode === "discard" ? "revert" : "cherry-pick"}.`; return; }
    if (/^Binary files /m.test(p.text) || p.truncated) { notice = `${path}: binary or too large to ${mode === "discard" ? "revert" : "cherry-pick"} as a patch.`; return; }
    return op(`git apply${mode === "discard" ? " --reverse" : ""} (${path} from ${short(commit)})`, { Apply: { repo, patch: p.text, mode } });
  }
  const hunkPatch = (a: Record<string, unknown>, mode: "discard" | "worktree") =>
    op(`git apply${mode === "discard" ? " --reverse" : ""} (hunk of ${need(a.path, "file")})`, { Apply: { repo, patch: need(a.patch, "patch"), mode } });
  const workPaths = (a: Record<string, unknown>) => [need(a.path, "file")];
  function discardFile(a: Record<string, unknown>, untracked: boolean) {
    const [p] = workPaths(a);
    show(yesNo([untracked ? "Delete File" : "Discard File", p], untracked ? "Delete this untracked file?" : "Discard the changes to this file?",
      untracked ? `Delete ${p}` : `Discard ${p}`, untracked ? "It is not in git: it is gone for good" : "Its unstaged changes are lost",
      () => void op(`discard ${p}`, { Discard: { repo, paths: [p] } })));
  }
  /** A commit row's menu: a section per branch / remote branch / tag on it (single selection), then the commit's */
  function commitMenu(e: MouseEvent, c: Commit, sel: Commit[]) {
    const multi = sel.length > 1;
    const vars = {
      commit: c.oid, short_commit: c.oid.slice(0, 8), commits: sel.map((x) => x.oid), last_selected_commit: sel.at(-1)?.oid, multi,
      head_ref: tab.info.branch ?? "HEAD", is_head: c.oid === tab.info.oid, refs: refsAt(c.oid).length > 0, any_hidden: tab.hidden.length > 0,
    };
    const local = (name: string) => tab.refs.refs.some((r) => r.kind === "branch" && r.name === splitRemote(tab.refs.remotes, name)?.[1]);
    const sections = multi ? [] : c.labels.map((l) => {
      const ref = fullRef(l.kind, l.name);
      const at = { ...vars, branch: l.name, tag_name: l.name, ref, head: l.head, hidden: tab.hidden.includes(ref), tracked: l.kind === "remote" && local(l.name), request: requestNoun(ui.forgeKinds[tab.id] ?? null) };
      return fillMenu(l.kind === "branch" ? BRANCH_ON_COMMIT : l.kind === "remote" ? REMOTE_BRANCH_ON_COMMIT : TAG, contextVars(at));
    });
    // local branches first (the HEAD one leading), then remote branches, then tags
    const order = { branch: 0, remote: 1, tag: 2 };
    const sorted = sections.map((s, i) => ({ s, l: c.labels[i] })).sort((a, b) => order[a.l.kind] - order[b.l.kind] || Number(b.l.head) - Number(a.l.head)).map((x) => x.s);
    showContextMenu(e, joinMenus(...sorted, fillMenu(COMMIT, contextVars(vars))), null);
  }

  /** Reveal a file (or the repository) in Finder / the file manager: local repositories only */
  function reveal(rel: string | null) {
    if (!rel) return openDir();
    const full = `${tab.path}/${rel}`;
    return mac ? api.openEditor("open -R {path}", full, "") : api.openEditor("xdg-open {path}", full.slice(0, full.lastIndexOf("/")), "");
  }

  /** toggle_ref_filter / toggle_files_filter: open the box (bringing its column forward) or close it */
  function toggleFilter(which: "locations" | "files") {
    if (filters[which]) { filters[which] = false; return; }
    ui.sidebar = true; // the filter boxes live in the side bar
    if (!columns.some((c) => c.length === 1 && c[0] === which)) showTab(which);
    filters[which] = true;
  }

  function layoutMenu(e: MouseEvent) {
    showMenu(e.currentTarget as HTMLElement, LAYOUTS.map((l) => ({ label: l.caption, checked: app.layout === l.value, run: () => setLayout(l.value) })));
  }
  const mac = platform === "mac";
  const openDir = () => api.openEditor(mac ? "open {path}" : "xdg-open {path}", tab.path, "");
  const openRepoInEditor = () => api.openEditor(host ? app.diff.editorRemote : app.diff.editorLocal, tab.path, host);
  const openTerminal = () => api.openEditor(app.prefs.terminal_command, tab.path, "");
  const actionMenu = (e: MouseEvent) => showContextMenu(e.currentTarget as HTMLElement, ACTIONS, { repo_path: tab.path, request: requestNoun(ui.forgeKinds[tab.id] ?? null) });

  const columns = $derived(sideColumns(app.layout, ui.sidebar));
  const visible = (col: Side[]): Side => visibleSide(col, shown);
  function showTab(t: Side) { shown = t; if (t !== "locations") pane = t; }
  // Commands that act on this repository exist only while its tab is open.
  $effect(() => {
    if (!active) return;
    const offs = [
      registerCommand("refresh", { caption: "View: Refresh", run: async () => { await Promise.all([refreshWork(), reloadTab(tab)]); } }),
      registerCommand("navigate_to_head", { run: () => { if (tab.info.oid) return jumpTo(tab.info.oid); } }),
      registerCommand("navigate_back", { caption: "Go: Back", run: () => navigate(-1) }),
      registerCommand("navigate_forward", { caption: "Go: Forward", run: () => navigate(1) }),
      registerCommand("stash", { caption: "Stash", run: (a) => (a.prompt ? showOverlay(stashPrompt([])) : stash([])) }),
      registerCommand("pop_stash", { caption: "Pop Stash", run: (a) => stashOp("pop", a) }),
      registerCommand("apply_stash", { run: (a) => stashOp("apply", a) }),
      registerCommand("drop_stash", { run: (a) => stashOp("drop", a) }),
      registerCommand("pull", {
        caption: "Pull", run: (a) => (a.prompt ? pullPrompt() : sync("pull", [])),
      }),
      registerCommand("fetch", {
        caption: "Fetch",
        run: (a) => (str(a.remote) ? op(`git fetch ${a.remote}`, { Fetch: { repo, flags: [], remote: str(a.remote) } }) : sync("fetch", [])),
      }),
      registerCommand("push", {
        caption: "Push", run: (a) => (a.prompt ? pushPrompt(a) : sync("push", [])),
      }),
      registerCommand("checkout_branch", { caption: "Checkout…", run: checkoutPrompt }),
      registerCommand("checkout_remote_branch", { caption: "Branch: Check Out Remote…", run: () => checkoutPrompt({ local_refs: false, tag_refs: false, remote_refs: true }) }),
      registerCommand("create_branch", { caption: "Create Branch…", run: (a) => createBranchPrompt(a) }),
      registerCommand("create_branch_from_remote_branch", { caption: "Branch: Create from Remote…", run: (a) => createBranchPrompt(a, ["remote"]) }),
      registerCommand("create_branch_from_tag", { caption: "Create Branch from Tag…", run: (a) => (typeof a.from === "string" ? createBranchPrompt(a) : createBranchPrompt(a, ["tag"])) }),
      registerCommand("rename_branch", { caption: "Rename Branch…", run: renamePrompt }),
      registerCommand("delete_branch", { caption: "Delete Branch…", run: deletePrompt }),
      registerCommand("delete_remote_branch", { caption: "Delete Remote Branch…", run: (a) => deletePrompt({ ...a, local_refs: false, remote_refs: true }) }),
      registerCommand("cleanup_branches", { caption: "Branch: Clean Up…", run: () => { cleanup = true; } }),
      registerCommand("merge_branch", { caption: "Merge Branch…", run: mergePrompt }),
      registerCommand("rebase_branch", { caption: "Rebase Branch…", run: rebasePrompt }),
      registerCommand("cherry_pick", { caption: "History: Cherry-pick…", run: (a) => commitPrompt("Cherry-pick", a, (rev, l) => void conflictOp(`git cherry-pick ${l}`, { CherryPick: { repo, rev } })) }),
      registerCommand("revert_commit", { caption: "History: Revert Commit…", run: (a) => commitPrompt("Revert", a, (rev, l) => void conflictOp(`git revert --no-edit ${l}`, { Revert: { repo, rev } })) }),
      registerCommand("reset", { caption: "History: Reset Branch to Commit…", run: resetPrompt }),
      registerCommand("create_tag", { caption: "Create Tag…", run: createTagPrompt }),
      registerCommand("delete_tag", { caption: "Delete Tag…", run: (a) => tagPrompt("Delete Tag", a, (name) => void op(`git tag -d ${name}`, { DeleteTag: { repo, name } }), false) }),
      registerCommand("push_tag", { caption: "Push Tag…", run: (a) => tagPrompt("Push Tag", a, (name, remote) => void op(`git push ${remote} refs/tags/${name}`, { PushTag: { repo, remote, name } }), true) }),
      registerCommand("delete_tag_on_remote", { caption: "Delete Remote Tag…", run: (a) => tagPrompt("Delete Remote Tag", a, confirmRemoteTag, true) }),
      registerCommand("add_remote", { caption: "Add Remote…", run: addRemote }),
      registerCommand("rename_remote", { caption: "Rename Remote…", run: renameRemote }),
      registerCommand("delete_remote", { caption: "Delete Remote…", run: deleteRemote }),
      registerCommand("update_remote_url", { caption: "Remote: Change URL…", run: updateRemoteUrl }),
      registerCommand("set_upstream", { caption: "Set Branch Upstream", run: upstreamPrompt }),
      registerCommand("unset_upstream", { caption: "Unset Branch Upstream", run: unsetUpstream }),
      registerCommand("toggle_console", { caption: "View: Toggle Console", run: () => { consoleOpen = !consoleOpen; } }),
      registerCommand("hide_ref", { run: (a) => (typeof a.ref === "string" ? hideRef(a.ref) : refPrompt("Hide Branch", allRefs().filter((x) => !tab.hidden.includes(x.ref)), hideRef)) }),
      registerCommand("show_ref", {
        caption: "Show Hidden Branch…",
        run: (a) => (typeof a.ref === "string" ? showRef(a.ref) : refPrompt("Show Hidden Branch", allRefs().filter((x) => tab.hidden.includes(x.ref)), showRef)),
      }),
      registerCommand("hide_all_refs_except", {
        caption: "Hide All Branches Except…",
        run: (a) => (typeof a.ref === "string" ? hideAllExcept(a.ref) : refPrompt("Hide All Branches Except", allRefs(), hideAllExcept)),
      }),
      registerCommand("show_all_refs", { caption: "Show All Hidden Branches", run: () => setHidden(tab, []) }),
      registerCommand("toggle_ref_filter", { run: () => toggleFilter("locations") }),
      registerCommand("toggle_files_filter", { run: () => toggleFilter("files") }),
      registerCommand("add_worktree", { caption: "Add Worktree…", run: addWorktreePrompt }),
      registerCommand("add_submodule", { caption: "Add Submodule…", run: addSubmodulePrompt }),
      registerCommand("update_submodule", {
        caption: "Update All Initialized Submodules",
        run: (a) => {
          const init = a.initialize === true, path = str(a.submodule_path);
          return op(`git submodule update${init ? " --init" : ""} --recursive${path ? ` -- ${path}` : ""}`, { UpdateSubmodules: { repo, init, path } });
        },
      }),
      registerCommand("sync_submodule", {
        caption: "Sync All Initialized Submodules",
        run: (a) => { const path = str(a.submodule_path); return op(`git submodule sync --recursive${path ? ` -- ${path}` : ""}`, { SyncSubmodules: { repo, path } }); },
      }),
      registerCommand("open_submodule", { run: (a) => openRepo(tab.location, `${tab.path}/${need(a.submodule_path, "submodule")}`) }),
      registerCommand("open_worktree", { run: (a) => openRepo(tab.location, need(a.worktree_path, "worktree")) }),
      registerCommand("copy_remote_url", { run: async (a) => { await copyLater(api.remoteUrl(tab.location, repo, need(a.remote, "remote"))); } }),
      registerCommand("revert_commits", { run: (a) => eachCommit("revert", a) }),
      registerCommand("cherry_pick_commits", { run: (a) => eachCommit("cherry-pick", a) }),
      registerCommand("hide_all_commit_refs", { run: (a) => setHidden(tab, [...new Set([...tab.hidden, ...refsAt(need(a.commit, "commit"))])]) }),
      registerCommand("hide_all_refs_except_refs_at_commit", {
        run: (a) => { const keep = refsAt(need(a.commit, "commit")); return setHidden(tab, allRefs().map((x) => x.ref).filter((r) => !keep.includes(r))); },
      }),
      registerCommand("blame", { caption: "Blame…", run: (a) => (str(a.path) ? showFileAs(need(a.path, "file"), "blame", str(a.from)) : filePicker("Blame", (p) => showFileAs(p, "blame", null))) }),
      registerCommand("file_history", {
        caption: "File History…",
        run: (a) => (str(a.path) ? showFileAs(need(a.path, "file"), "history", str(a.from)) : filePicker("File History", (p) => showFileAs(p, "history", null))),
      }),
      registerCommand("open_in_editor", {
        // a menu file may pass `file: "$git_dir/.gitignore"`
        run: (a) => openInEditor(tab, str(a.path) ?? need(a.file, "file").replace(/^\$git_dir\//, "")),
      }),
      registerCommand("revert_file", { run: (a) => filePatch(a, "discard") }),
      registerCommand("cherry_pick_file", { run: (a) => filePatch(a, "worktree") }),
      registerCommand("revert_diff_hunk", { run: (a) => hunkPatch(a, "discard") }),
      registerCommand("cherrypick_hunk", { run: (a) => hunkPatch(a, "worktree") }),
      registerCommand("stage_file", { run: (a) => op(`git add ${workPaths(a)[0]}`, { Stage: { repo, paths: workPaths(a) } }) }),
      registerCommand("unstage_file", { run: (a) => op(`git restore --staged ${workPaths(a)[0]}`, { Unstage: { repo, paths: workPaths(a) } }) }),
      registerCommand("discard_file", { run: (a) => discardFile(a, false) }),
      registerCommand("delete_file", { run: (a) => discardFile(a, true) }),
      registerCommand("ignore_file", { run: (a) => op(`ignore ${workPaths(a)[0]}`, { Ignore: { repo, path: workPaths(a)[0] } }) }),
      registerCommand("resolve_merge_conflict", {
        run: (a) => {
          const p = need(a.path, "file");
          if (a.mode !== "ours" && a.mode !== "theirs") { mergeFile = p; return; }
          const theirs = a.mode === "theirs";
          return op(`git checkout --${theirs ? "theirs" : "ours"} ${p}`, { Resolve: { repo, path: p, theirs } });
        },
      }),
      // stage_all, stage_all_modified, unstage_all, navigate_to_commit_message
      registerCommand("stage_all", {
        caption: "Stage All",
        run: () => workOp("git add", workFiles((f) => f.kind !== "changed" || f.worktree !== "."), (paths) => ({ Stage: { repo, paths } })),
      }),
      registerCommand("stage_all_modified", {
        caption: "Stage All Modified Files",
        run: () => workOp("git add", workFiles((f) => f.kind === "changed" && f.worktree !== "."), (paths) => ({ Stage: { repo, paths } })),
      }),
      registerCommand("unstage_all", {
        caption: "Unstage All",
        run: () => workOp("git restore --staged", workFiles((f) => f.kind === "changed" && f.index !== "."), (paths) => ({ Unstage: { repo, paths } })),
      }),
      registerCommand("navigate_to_commit_message", {
        run: async () => { showWork(); await tick(); document.querySelector<HTMLElement>(".tabview:not(.off) .commitbox .cm-content")?.focus(); },
      }),
      registerCommand("open_dir_in_editor", { caption: "Repository: Open in Editor", run: openRepoInEditor }),
      registerCommand("git", { run: customGit }),
      // a menu passes the branch; never the selection
      registerCommand("create_pull_request", { caption: `Create ${requestNoun(ui.forgeKinds[tab.id] ?? null)}…`, run: (a) => { request = { source: str(a.branch) }; } }),
      // local folders only (a remote path means nothing to Finder or Terminal)
      ...(host ? [] : [registerCommand("open_dir", { caption: mac ? "Reveal in Finder" : "Open Containing Folder…", run: (a) => reveal(str(a.path)) })]),
      ...(host || !app.prefs.terminal_command.trim() ? [] : [registerCommand("open_terminal", { caption: "Open Repository in Terminal", run: openTerminal })]),
    ];
    return () => offs.forEach((off) => off());
  });
  /** "View file" from a commit: its Tree, with the file open */
  function openFile(path: string) { pane = "files"; filesMode = "tree"; if (shown === "commits") shown = "files"; file = path; fileAt = null; fileMode = "file"; }
  /** Blame… / File History…: the file at `from` (HEAD when null) in that mode */
  function showFileAs(path: string, mode: "blame" | "history", from: string | null) { openFile(path); fileAt = from ?? tab.info.oid; fileMode = mode; }
  /** a fuzzy list of HEAD's files, then `run` */
  async function filePicker(title: string, run: (path: string) => void) {
    if (!tab.info.oid) { notice = "No commits yet."; return; }
    const paths = await api.files(tab.location, repo, tab.info.oid);
    show(listStep([title], "File", paths.map((p) => ({ label: p, value: p })), (v) => { hideOverlay(); run(v as string); }));
  }
  const closeMerge = async () => { mergeFile = null; await Promise.all([refreshWork(), reloadTab(tab)]); };

  // ---- M6 commit editing: a scripted `git rebase -i` in core (Req::Rewrite); conflicts and Edit stops use the rebase banner
  const commitArg = (a: Record<string, unknown>) => str(a.commit) ?? selected?.oid ?? null;
  const commitsArg = (a: Record<string, unknown>) => (Array.isArray(a.commits) ? a.commits.filter((c): c is string => typeof c === "string") : []);
  const REWRITE_VERB: Record<RewriteAction, string> = { reword: "reword", edit: "edit", squash: "squash", fixup: "fixup", move_up: "move up", move_down: "move down", drop: "drop" };
  /** `done`: called once it ran (also after the published-history confirm) */
  async function rewrite(action: RewriteAction, commits: string[], message: string | null = null, done?: () => void) {
    if (!commits.length) { notice = "No commit selected."; return; }
    const label = `git rebase -i (${REWRITE_VERB[action]} ${commits.map(short).join(" ")})`;
    const req = (published_ok: boolean): Req => ({ Rewrite: { repo, action, commits, message, published_ok } });
    // a conflict or an Edit stop: the Working Directory, under the rebase banner
    const after = (ran: boolean) => { if (ran) done?.(); if (work?.files.some((f) => f.kind === "conflicted") || work?.edit) showWork(); };
    let ok = true;
    await op(label, req(false), (e) => {
      ok = false;
      if (!e.startsWith("PUBLISHED")) return false;
      show(yesNo([label.replace(/^git /, "")], "Rewrite published history?", "Rewrite anyway",
        `${e.replace(/^PUBLISHED: /, "")} Others who have them will need to reset.`, () => {
          let failed = false;
          void op(label, req(true), () => { failed = true; return false; }).then(() => after(!failed));
        }));
      return true;
    });
    after(ok);
  }
  /** Interactive rebase Apply: git's refusal goes back to the editor; a stop (conflict, failed hook) closes it and shows
   *  the Working Directory under the rebase banner (Continue / Skip / Abort) */
  async function applyRebase(label: string, req: Req): Promise<string | null> {
    let error: string | null = null;
    await op(label, req, (e) => { error = e; return true; });
    if (work?.op) { rebaseFrom = null; showWork(); return null; }
    if (!error) rebaseFrom = null;
    return error;
  }
  const saveMessage = (oid: string, message: string) => rewrite("reword", [oid], message, () => (editingMsg = null));
  function dropPrompt(commits: string[]) {
    if (!commits.length) return;
    const n = commits.length;
    show(yesNo(["Drop Commits", ...commits.map(short)], `Drop ${n === 1 ? "this commit" : `these ${n} commits`}?`, `Drop ${n} commit${n === 1 ? "" : "s"}`,
      "git rebase -i: removed from the branch (Undo puts them back)", () => void rewrite("drop", commits)));
  }
  $effect(() => {
    if (!active) return;
    const offs = [
      registerCommand("edit_commit", {
        run: async (a) => {
          const c = commitArg(a);
          if (!c) return;
          if (selected?.oid !== c) await jumpTo(c);
          pane = "commits"; view = "commit"; editingMsg = c;
        },
      }),
      registerCommand("edit_commit_contents", { run: (a) => { const c = commitArg(a); if (c) return rewrite("edit", [c]); } }),
      registerCommand("squash_commit", { run: (a) => { const c = commitArg(a); if (c) return rewrite("squash", [c]); } }),
      registerCommand("squash_commits", { run: (a) => rewrite("squash", commitsArg(a)) }),
      registerCommand("fixup_commits", { run: (a) => rewrite("fixup", commitsArg(a)) }),
      registerCommand("move_commit", { run: (a) => { const c = commitArg(a); if (c) return rewrite(a.down === true ? "move_down" : "move_up", [c]); } }),
      registerCommand("interactive_rebase", { caption: "Rebase: Interactive…", run: (a) => { rebaseFrom = { from: str(a.commit) }; } }),
      registerCommand("drop_commits", { run: (a) => dropPrompt(commitsArg(a).length ? commitsArg(a) : [commitArg(a)].filter((c): c is string => !!c)) }),
    ];
    return () => offs.forEach((off) => off());
  });
  $effect(() => { if (active && tab.refs.stashes.length) return registerCommand("clear_stashes", { caption: "Clear All Stashes", run: clearStashes }); });
</script>

{#if request}<ForgeRequest {tab} source={request.source} onclose={() => (request = null)} />{/if}
{#if cleanup}<BranchCleanup {tab} onclose={() => (cleanup = false)} />{/if}
{#if rebaseFrom}<RebaseEditor {tab} from={rebaseFrom.from} onapply={applyRebase} onclose={() => (rebaseFrom = null)} />{/if}
{#if mergeFile}
  {#key mergeFile}<MergeTool {tab} path={mergeFile} onclose={closeMerge} />{/key}
{:else}
<header class="toolbar">
  <div class="grp">
    <div class="split">
      <button class="ib" title="Toggle Side Bar" aria-label="Toggle side bar" aria-pressed={ui.sidebar} onclick={() => runCommand("toggle_side_bar")}><svg class="i"><use href="#i-panel" /></svg></button>
      <button class="ib dd" title="Side Bar Layout" aria-label="Side bar layout" onclick={layoutMenu}><svg class="i"><use href="#i-down" /></svg></button>
    </div>
    <button class="ib" title="Back" aria-label="Back" disabled={at <= 0} onclick={() => navigate(-1)}><svg class="i"><use href="#i-left" /></svg></button>
    <button class="ib" title="Forward" aria-label="Forward" disabled={at >= hist.length - 1} onclick={() => navigate(1)}><svg class="i flip"><use href="#i-left" /></svg></button>
  </div>
  <div class="grp mid">
    <div class="split">
      <button class="ib" title="Stash" aria-label="Stash" onclick={() => runCommand("stash")}><svg class="i"><use href="#i-stash" /></svg></button>
      <button class="ib dd" title="Stash options" aria-label="Stash options" onclick={() => runCommand("stash", { prompt: true })}><svg class="i"><use href="#i-down" /></svg></button>
    </div>
    <button class="ib" title="Pop Stash" aria-label="Pop stash" disabled={!tab.refs.stashes.length} onclick={() => runCommand("pop_stash")}><svg class="i"><use href="#i-pop" /></svg></button>
    <div class="branchbox">
      <button class="ib console {conState}" class:on={consoleOpen} aria-pressed={consoleOpen} aria-label="Console" onclick={() => runCommand("toggle_console")}
        title={lastJob ? `${lastJob.label}: ${conState === "running" ? "running" : lastJob.status}` : "Console"}>
        {#if conState === "running"}<span class="spinner" aria-hidden="true"></span>{:else}<svg class="i"><use href="#i-terminal" /></svg>{/if}
      </button>
      <button class="branch" title={tab.info.branch ? "Checkout another branch" : "Detached HEAD"} onclick={() => runCommand("checkout_branch")}>
        <span class="mono">{tab.info.branch ?? (tab.info.oid ? `detached @ ${tab.info.oid.slice(0, 7)}` : "no commits yet")}</span>
        {#if tab.info.ahead || tab.info.behind}<span class="sync">↑{tab.info.ahead} ↓{tab.info.behind}</span>{/if}
      </button>
    </div>
    <button class="ib" class:on={search !== null} title="Search" aria-label="Search" aria-pressed={search !== null} onclick={() => (search !== null ? (search = null) : openSearch())}><svg class="i"><use href="#i-search" /></svg></button>
    <button class="ib" title="More actions" aria-label="More actions" onclick={actionMenu}><svg class="i"><use href="#i-dots" /></svg></button>
  </div>
  <div class="grp end">
    <div class="split">
      <button class="ib" title="Pull" aria-label="Pull" onclick={() => runCommand("pull")}><svg class="i"><use href="#i-pull" /></svg></button>
      <button class="ib dd" title="Pull options" aria-label="Pull options" onclick={() => runCommand("pull", { prompt: true })}><svg class="i"><use href="#i-down" /></svg></button>
    </div>
    <div class="split">
      <button class="ib" title="Push" aria-label="Push" onclick={() => runCommand("push")}><svg class="i"><use href="#i-push" /></svg></button>
      <button class="ib dd" title="Push options" aria-label="Push options" onclick={() => runCommand("push", { prompt: true })}><svg class="i"><use href="#i-down" /></svg></button>
    </div>
  </div>
</header>
{#if search !== null}
  <SearchBar bind:value={search} info={searchInfo} error={!!searchErr} onstep={stepResult} onclose={() => (search = null)} focusKey={searchFocus} {tab} />
{/if}
{#if seqOp}
  <div class="banner seq" role="status" aria-label="Operation in progress">
    <span class="t">{#if work?.edit && !counts.conflicts}Editing commit {short(work.edit)}: change files and stage them (Continue amends them into it), or amend it yourself, then Continue{:else}{sequenceTitle(seqOp)}{counts.conflicts ? `: ${counts.conflicts} conflicted file${counts.conflicts === 1 ? "" : "s"}` : ""}{/if}</span>
    {#if confirmSeqAbort}
      <button class="btn danger" onclick={() => sequence("abort")}>Really abort</button>
      <button class="btn" onclick={() => (confirmSeqAbort = false)}>Cancel</button>
    {:else}
      <button class="primary" onclick={() => sequence("continue")}>Continue</button>
      <button class="btn" onclick={() => sequence("skip")}>Skip</button>
      <button class="btn" onclick={() => (confirmSeqAbort = true)}>Abort</button>
    {/if}
  </div>
{/if}
{#if app.links[tab.location] !== undefined}
  <div class="banner warn" role="status" aria-label="Connection">Disconnected, reconnecting… <span class="hint">{app.links[tab.location]}</span></div>
{/if}
{#if tab.info.lfs_warning}<div class="banner warn" role="status" aria-label="Git LFS">{tab.info.lfs_warning}</div>{/if}
{#if notice}<div class="banner" role="status">{notice}<button class="ib" aria-label="Dismiss" onclick={() => (notice = "")}><svg class="i"><use href="#i-x" /></svg></button></div>{/if}

<div class="main">
  {#if consoleOpen}<Console repo={tab.id} />{/if}
  {#each columns as col (col.join())}
    {@const t = visible(col)}
    {@const filterable = t === "locations" || t === "files"}
    <aside class="left col-{col.length > 1 ? 'tabs' : col[0]}">
      <div class="colbar">
        {#if col.length > 1}
          <div class="seg pane-seg" style:grid-template-columns="repeat({col.length}, 1fr)" role="tablist">
            {#each col as c}<button role="tab" class:on={t === c} aria-selected={t === c} onclick={() => showTab(c)}>{CAPTION[c]}</button>{/each}
          </div>
        {:else}
          <div class="colhead">{CAPTION[t]}</div>
        {/if}
        {#if filterable}
          <button class="ib mag" class:on={filters[t as "locations" | "files"]} aria-label="Filter {CAPTION[t]}" title="Filter {CAPTION[t]}"
            onclick={() => runCommand(t === "locations" ? "toggle_ref_filter" : "toggle_files_filter")}><svg class="i"><use href="#i-search" /></svg></button>
        {/if}
      </div>
      {#if t === "locations"}
        <Sidebar {tab} onjump={jumpTo} onstash={(s) => { stashSel = s; pane = "commits"; view = "stash"; }}
          filter={filters.locations} onfilterclose={() => (filters.locations = false)} />
      {:else if t === "commits"}
        <button class="workrow" class:on={view === "work"} onclick={showWork}>
          <span class="dot" class:dirty={counts.total > 0}></span>
          <span class="rb">
            <span class="s">{pending[0]}</span>
            {#if pending[1]}<span class="m">{pending[1]}</span>{/if}
          </span>
        </button>
        {#key tab.rev}
          <CommitList {tab} filter={search !== null ? found?.rows ?? null : null} active={view === "commit"} onpick={() => { pane = "commits"; view = "commit"; }} onselect={(c, f) => { selected = c; from = f; }} oncontext={commitMenu} {target} onconsumed={() => (target = null)} />
        {/key}
      {:else}
        <FilesPane {tab} bind:mode={filesMode} filter={filters.files} onfilterclose={() => (filters.files = false)}
          {work} showWork={view === "work"} commit={selected} {from} {treeOid} {current}
          onworkfile={(path, staged) => { pane = "files"; view = "work"; workFocus = `${staged ? "s" : "u"}:${path}`; }}
          oncommitfile={(path) => { pane = "files"; view = "commit"; commitFile = path; }}
          onopen={(path) => { pane = "files"; file = path; fileAt = null; fileMode = "file"; }} />
      {/if}
    </aside>
  {/each}
  <section class="right">
    <div class="content" class:flush={!(pane === "files" && filesMode === "tree")}>
      {#if pane === "files" && filesMode === "tree"}
        {#if file && (fileAt ?? treeOid)}
          {#key `${fileAt ?? treeOid}:${file}:${fileMode}`}<FileView {tab} oid={(fileAt ?? treeOid)!} path={file} start={fileMode} onjump={jumpTo} />{/key}
        {:else}
          <div class="empty"><div><h2>Select a file</h2><p class="hint">Tree of {treeOid ? treeOid.slice(0, 8) : "—"}{selected ? "" : " (HEAD)"}</p></div></div>
        {/if}
      {:else if view === "work"}
        <WorkingDir {tab} status={work} onchanged={refreshWork} bind:focus={workFocus} />
      {:else if view === "stash" && stashSel}
        {#key stashSel.oid}
          <CommitDetail {tab} stash={stashSel.name} commit={{ oid: stashSel.oid, parents: [], author: "", email: "", time: 0, subject: stashSel.message, files: null, labels: [] }}
            onjump={jumpTo} />
        {/key}
      {:else if selected}
        {#key `${selected.oid}:${from?.oid ?? ""}`}<CommitDetail {tab} commit={selected} {from} bind:focus={commitFile} onjump={jumpTo}
          editing={editingMsg === selected.oid && !from} onsavemessage={(m) => saveMessage(selected!.oid, m)} oncancelmessage={() => (editingMsg = null)} />{/key}
      {:else}
        <div class="empty"><div><h2>{tab.total ? "Select a commit" : "No commits yet"}</h2></div></div>
      {/if}
    </div>
  </section>
</div>
{/if}
