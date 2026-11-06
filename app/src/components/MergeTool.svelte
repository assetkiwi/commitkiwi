<script lang="ts">
  // The merge tool: ours | Merged (editable, CM6; or Base) | theirs, connector lines between the
  // columns, ▶ / ◀ per hunk to take a side (right-click: Take Both), CONFLICT on every unresolved hunk,
  // Prev/Next Conflict, Cancel, Save and Stage ▾. Binary, symlink, submodule, mode and delete conflicts get a
  // whole-file choice instead. Pure merge logic: lib/merge3.ts.
  import { onDestroy, onMount, tick } from "svelte";
  import { EditorState, StateEffect, StateField, type Range } from "@codemirror/state";
  import { Decoration, EditorView, WidgetType, keymap, lineNumbers } from "@codemirror/view";
  import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
  import { api } from "../lib/api";
  import { CANCELLED, runGit } from "../lib/jobs.svelte";
  import { registerCommand } from "../lib/commands";
  import { tabScope } from "../lib/tabScope";
  import { openInEditor, type Tab } from "../lib/state.svelte";
  import { showMenu } from "../lib/ui.svelte";
  import { PLACEHOLDER, buildMerged, diff3, mapLine, segments, splitLines, takeLines, withMarkers, type Chunk } from "../lib/merge3";
  import type { ConflictFile, ConflictSide } from "../lib/types";

  let { tab, path, onclose }: { tab: Tab; path: string; onclose: (changed: boolean) => void } = $props();

  let data = $state.raw<ConflictFile | null>(null);
  let error = $state("");
  let busy = $state(false);
  let showBase = $state(false);
  let confirm = $state<null | "cancel" | "save" | "stage">(null);
  let openCount = $state(0); // unresolved conflicts
  let dirty = $state(false);
  let chunks: Chunk[] = [];
  let links = $state.raw<{ left: Link[]; right: Link[] }>({ left: [], right: [] });
  interface Link { c: number; kind: Chunk["kind"]; open: boolean; a: [number, number]; b: [number, number] }

  const repo = $derived(tab.path);
  const short = (o: string | null) => (o ? o.slice(0, 8) : "?");
  const refsAt = (o: string | null) => tab.refs.refs.filter((r) => r.oid === o).map((r) => r.name);
  const sideLabel = (o: string | null) => `Commit ${short(o)}${refsAt(o).length ? ` on ${refsAt(o).join(", ")}` : ""}`;

  /** why this conflict can't be merged line by line (null = it can) */
  function wholeFileReason(d: ConflictFile): string | null {
    const sides: [string, ConflictSide | null][] = [["ours", d.ours], ["theirs", d.theirs]];
    for (const [n, s] of sides) if (!s) return `Deleted in ${n}.`;
    for (const [n, s] of [...sides, ["base", d.base] as [string, ConflictSide | null]]) {
      if (!s) continue;
      if (s.mode === "160000") return "A submodule conflict.";
      if (s.mode === "120000") return "A symlink conflict.";
      if (s.blob.binary) return `A binary file (${n}: ${s.blob.size.toLocaleString()} bytes).`;
      if (s.blob.truncated) return `Too large to merge here (${n}: ${s.blob.size.toLocaleString()} bytes).`;
    }
    if (d.ours!.mode !== d.theirs!.mode) return `The file mode differs (ours ${d.ours!.mode}, theirs ${d.theirs!.mode}).`;
    return null;
  }
  const reason = $derived(data ? wholeFileReason(data) : null);

  // ---- editors
  let oursEl = $state<HTMLElement>(), theirsEl = $state<HTMLElement>(), mergedEl = $state<HTMLElement>(), baseEl = $state<HTMLElement>(), area = $state<HTMLElement>();
  let ours: EditorView | null = null, theirs: EditorView | null = null, merged: EditorView | null = null, base: EditorView | null = null;
  let initial = "";

  /** Merged's chunk boundaries (`bounds[c]..bounds[c + 1]`) and the hunks a side was taken for */
  interface Track { bounds: number[]; taken: ReadonlySet<number> }
  const setTrack = StateEffect.define<Track>();
  const track = StateField.define<Track>({
    create: () => ({ bounds: [], taken: new Set() }),
    update(t, tr) {
      for (const e of tr.effects) if (e.is(setTrack)) return e.value;
      if (!tr.docChanged) return t;
      const last = t.bounds.length - 1;
      // typing at a boundary belongs to the hunk after it; the end stays the end
      return { ...t, bounds: t.bounds.map((p, i) => tr.changes.mapPos(p, i === last ? 1 : -1)) };
    },
  });
  const isOpen = (s: EditorState, c: number) => {
    const t = s.field(track);
    return chunks[c].kind === "conflict" && !t.taken.has(c) && s.doc.sliceString(t.bounds[c], t.bounds[c + 1]) === PLACEHOLDER;
  };
  class ConflictMark extends WidgetType {
    toDOM() { const s = document.createElement("span"); s.className = "mt-mark"; s.textContent = "CONFLICT"; return s; }
    eq() { return true; }
  }
  const mergedDeco = EditorView.decorations.compute([track, "doc"], (s) => {
    const { bounds } = s.field(track);
    const out: Range<Decoration>[] = [];
    chunks.forEach((ch, c) => {
      if (ch.kind === "same" || bounds[c] === undefined) return;
      const open = isOpen(s, c);
      for (let p = bounds[c]; p < bounds[c + 1]; ) {
        const line = s.doc.lineAt(p);
        out.push(Decoration.line({ class: open ? "mt-open" : ch.kind === "conflict" ? "mt-done" : "mt-auto" }).range(line.from));
        if (open) out.push(Decoration.widget({ widget: new ConflictMark(), side: -1 }).range(line.from));
        p = line.to + 1;
      }
    });
    return Decoration.set(out, true);
  });
  /** a side column: its changed lines shaded (conflicts stronger) */
  function sideDeco(side: "ours" | "theirs" | "base", doc: EditorState["doc"]) {
    const out: Range<Decoration>[] = [];
    let line = 1;
    for (const ch of chunks) {
      const n = ch[side].length;
      if (ch.kind !== "same") for (let k = 0; k < n; k++) out.push(Decoration.line({ class: ch.kind === "conflict" ? "mt-conflict" : "mt-change" }).range(doc.line(line + k).from));
      line += n;
    }
    return EditorView.decorations.of(Decoration.set(out, true));
  }
  const sideView = (el: HTMLElement, text: string, side: "ours" | "theirs" | "base", label: string) => {
    const state = EditorState.create({ doc: text, extensions: [lineNumbers(), EditorState.readOnly.of(true), EditorView.editable.of(false),
      EditorView.contentAttributes.of({ "aria-label": label })] });
    const v = new EditorView({ state, parent: el });
    v.dispatch({ effects: StateEffect.appendConfig.of(sideDeco(side, v.state.doc)) });
    return v;
  };

  // ---- scroll sync and connector lines
  let driver: EditorView | null = null;
  const views = () => [ours, showBase ? base : merged, theirs].filter((v): v is EditorView => !!v);
  /** chunk line ranges of a view's column */
  function segs(v: EditorView): [number, number][] {
    if (v === ours) return segments(chunks, "ours");
    if (v === theirs) return segments(chunks, "theirs");
    if (v === base) return segments(chunks, "base");
    const { bounds } = v.state.field(track), doc = v.state.doc;
    const end = doc.toString().endsWith("\n") ? doc.lines - 1 : doc.lines;
    const idx = (p: number) => (p >= doc.length ? end : doc.lineAt(p).number - 1);
    return chunks.map((_, c) => { const s = idx(bounds[c]); return [s, Math.max(s, idx(bounds[c + 1]))]; });
  }
  /** y of the top of 0-based line `l` (fractional), relative to the columns area */
  function yOf(v: EditorView, l: number): number {
    const doc = v.state.doc, top = area!.getBoundingClientRect().top;
    if (l >= doc.lines) { const b = v.lineBlockAt(doc.length); return b.bottom + v.documentTop - top; }
    const b = v.lineBlockAt(doc.line(Math.floor(l) + 1).from);
    return b.top + (l % 1) * b.height + v.documentTop - top;
  }
  function midLine(v: EditorView): number {
    const h = v.scrollDOM.clientHeight / 2, b = v.lineBlockAtHeight(v.scrollDOM.scrollTop + h);
    return v.state.doc.lineAt(b.from).number - 1 + (b.height ? (v.scrollDOM.scrollTop + h - b.top) / b.height : 0);
  }
  function follow(src: EditorView) {
    const from = segs(src), line = midLine(src);
    for (const v of views()) {
      if (v === src) continue;
      const to = mapLine(from, segs(v), line), doc = v.state.doc;
      const l = Math.min(Math.floor(to), doc.lines - 1), b = v.lineBlockAt(doc.line(l + 1).from);
      v.scrollDOM.scrollTop = b.top + (to - l) * b.height - v.scrollDOM.clientHeight / 2;
    }
  }
  let frame = 0;
  function redraw() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const mid = showBase ? base : merged;
      if (!ours || !theirs || !mid || !area) return;
      const [so, sm, st] = [segs(ours), segs(mid), segs(theirs)];
      const link = (av: EditorView, as: [number, number][], bv: EditorView, bs: [number, number][]) => chunks.flatMap((ch, c): Link[] => ch.kind === "same" ? [] : [{
        c, kind: ch.kind, open: !showBase && isOpen(merged!.state, c),
        a: [yOf(av, as[c][0]), yOf(av, as[c][1])], b: [yOf(bv, bs[c][0]), yOf(bv, bs[c][1])],
      }]);
      links = { left: link(ours, so, mid, sm), right: link(mid, sm, theirs, st) };
    });
  }
  function onScroll(v: EditorView) {
    if (v === driver) follow(v);
    redraw();
  }

  function build(d: ConflictFile) {
    chunks = diff3(splitLines(d.base?.blob.text ?? ""), splitLines(d.ours!.blob.text ?? ""), splitLines(d.theirs!.blob.text ?? ""));
    const m = buildMerged(chunks);
    initial = m.text;
    ours = sideView(oursEl!, d.ours!.blob.text ?? "", "ours", "Ours");
    theirs = sideView(theirsEl!, d.theirs!.blob.text ?? "", "theirs", "Theirs");
    base = sideView(baseEl!, d.base?.blob.text ?? "", "base", "Base");
    merged = new EditorView({
      parent: mergedEl!,
      state: EditorState.create({
        doc: m.text,
        extensions: [track, mergedDeco, lineNumbers(), history(), keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.contentAttributes.of({ "aria-label": "Merged" }),
          EditorView.updateListener.of((u) => { if (u.docChanged || u.transactions.some((t) => t.effects.length)) { refreshCounts(); redraw(); } })],
      }),
    });
    merged.dispatch({ effects: setTrack.of({ bounds: m.bounds, taken: new Set() }) });
    for (const v of [ours, theirs, base, merged]) {
      v.scrollDOM.addEventListener("scroll", () => onScroll(v));
      for (const ev of ["wheel", "mousedown", "keydown", "touchstart"]) v.dom.addEventListener(ev, () => (driver = v), { passive: true });
    }
    refreshCounts();
    redraw();
    // start at the first conflict
    void tick().then(() => step(1, -1));
  }
  function refreshCounts() {
    if (!merged) return;
    openCount = chunks.filter((_, c) => isOpen(merged!.state, c)).length;
    dirty = merged.state.doc.toString() !== initial;
  }

  // ---- actions
  function take(c: number, which: "ours" | "theirs" | "both") {
    if (!merged) return;
    const t = merged.state.field(track);
    const [from, to] = [t.bounds[c], t.bounds[c + 1]];
    const insert = takeLines(chunks[c], which);
    const delta = insert.length - (to - from);
    merged.dispatch({
      changes: { from, to, insert },
      effects: setTrack.of({ bounds: t.bounds.map((p, i) => (i <= c ? p : p + delta)), taken: new Set([...t.taken, c]) }),
    });
    dirty = true;
  }
  function takeMenu(e: MouseEvent, c: number) {
    e.preventDefault();
    showMenu(e, [
      { label: "Take Left", run: () => take(c, "ours") },
      { label: "Take Right", run: () => take(c, "theirs") },
      { label: "Take Both (Left First)", run: () => take(c, "both") },
    ]);
  }
  /** the hunk under Merged's cursor, else the next open conflict */
  function current(): number {
    if (!merged) return -1;
    const pos = merged.state.selection.main.head, { bounds } = merged.state.field(track);
    const at = chunks.findIndex((ch, c) => ch.kind !== "same" && pos >= bounds[c] && pos < Math.max(bounds[c + 1], bounds[c] + 1));
    return at >= 0 ? at : chunks.findIndex((_, c) => isOpen(merged!.state, c));
  }
  /** Prev/Next Conflict: open ones first; once all are resolved, every conflict hunk */
  function step(dir: 1 | -1, from?: number) {
    if (showBase) showBase = false;
    if (!merged) return;
    const { bounds } = merged.state.field(track);
    const open = chunks.map((_, c) => c).filter((c) => isOpen(merged!.state, c));
    const list = open.length ? open : chunks.map((ch, c) => (ch.kind === "conflict" ? c : -1)).filter((c) => c >= 0);
    if (!list.length) return;
    const pos = from ?? merged.state.selection.main.head;
    const next = dir > 0 ? list.find((c) => bounds[c] > pos) ?? list[0] : [...list].reverse().find((c) => bounds[c] < pos) ?? list.at(-1)!;
    driver = merged;
    merged.dispatch({ selection: { anchor: bounds[next] }, effects: EditorView.scrollIntoView(bounds[next], { y: "center" }) });
    merged.focus();
    requestAnimationFrame(() => { if (merged) follow(merged); redraw(); });
  }

  async function save(stage: boolean, sure = false) {
    if (!merged) return;
    const open = chunks.map((_, c) => c).filter((c) => isOpen(merged!.state, c));
    if (open.length && !sure) { confirm = stage ? "stage" : "save"; return; }
    confirm = null;
    const text = withMarkers(merged.state.doc.toString(), chunks, merged.state.field(track).bounds, open);
    await finish(`save merged ${path}${stage ? " && git add" : ""}`, { SaveMerge: { repo, path, text, stage } });
  }
  async function finish(label: string, req: Parameters<typeof runGit>[2]) {
    busy = true;
    error = "";
    try { await runGit(tab, label, req); onclose(true); } catch (e) { if (e !== CANCELLED) error = String(e); } finally { busy = false; }
  }
  const resolveWith = (theirs: boolean) => finish(`git checkout --${theirs ? "theirs" : "ours"} ${path}`, { Resolve: { repo, path, theirs } });
  function cancel(sure = false) {
    if (dirty && !sure) { confirm = "cancel"; return; }
    onclose(false);
  }
  function saveMenu(e: MouseEvent) {
    showMenu(e.currentTarget as HTMLElement, [{ label: "Save without Staging", run: () => void save(false) }]);
  }
  function fileMenu(e: MouseEvent) {
    showMenu(e.currentTarget as HTMLElement, [
      { label: "Resolve Using Ours", run: () => void resolveWith(false) },
      { label: "Resolve Using Theirs", run: () => void resolveWith(true) },
      "-",
      { label: "Open in Editor", run: () => void openInEditor(tab, path) },
    ]);
  }
  const focusCol = (v: EditorView | null) => { driver = v; v?.focus(); };

  // the middle column switched: measure the one now shown, line it up with ours
  $effect(() => { void showBase; void tick().then(() => { const mid = showBase ? base : merged; mid?.requestMeasure(); requestAnimationFrame(() => { if (ours && mid) follow(ours); redraw(); }); }); });

  const scope = tabScope();
  onMount(() => {
    scope.modes.merge_mode = true;
    api.conflict(tab.location, repo, path).then(async (d) => {
      data = d;
      if (wholeFileReason(d)) return;
      await tick();
      build(d);
    }).catch((e) => (error = String(e)));
  });
  $effect(() => {
    if (!scope.active()) return;
    const offs = [
      registerCommand("next_conflict", { caption: "Merge: Next Conflict", run: () => step(1) }),
      registerCommand("prev_conflict", { caption: "Merge: Previous Conflict", run: () => step(-1) }),
      registerCommand("save", { caption: "Merge: Save and Stage", run: () => save(true) }),
      registerCommand("save_without_staging", { caption: "Merge: Save without Staging", run: () => save(false) }),
      registerCommand("toggle_merged_vs_base", { caption: "Merge: Toggle Merged / Base", run: () => { showBase = !showBase; } }),
      registerCommand("use_left_hunk", { run: () => { const c = current(); if (c >= 0) take(c, "ours"); } }),
      registerCommand("use_right_hunk", { run: () => { const c = current(); if (c >= 0) take(c, "theirs"); } }),
      registerCommand("take_ours", { run: () => { const c = current(); if (c >= 0) take(c, "ours"); } }),
      registerCommand("take_theirs", { run: () => { const c = current(); if (c >= 0) take(c, "theirs"); } }),
      registerCommand("focus_left", { run: () => focusCol(ours) }),
      registerCommand("focus_middle", { run: () => focusCol(showBase ? base : merged) }),
      registerCommand("focus_right", { run: () => focusCol(theirs) }),
    ];
    return () => offs.forEach((off) => off());
  });
  $effect(() => {
    const onResize = () => redraw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });
  onDestroy(() => {
    scope.modes.merge_mode = false;
    cancelAnimationFrame(frame);
    for (const v of [ours, theirs, base, merged]) v?.destroy();
  });
  const poly = (l: Link, w: number) => `0,${l.a[0]} ${w},${l.b[0]} ${w},${Math.max(l.b[1], l.b[0] + 1)} 0,${Math.max(l.a[1], l.a[0] + 1)}`;
  const W = 34; // connector strip width
</script>

<div class="mtool" aria-label="Merge tool">
  <header class="mt-bar">
    <div class="grp">
      <button class="btn" onclick={() => step(-1)} disabled={!!reason || !data}>Prev Conflict</button>
      <button class="btn" onclick={() => step(1)} disabled={!!reason || !data}>Next Conflict</button>
    </div>
    <div class="grp mid">
      <span class="mt-file mono" title={path}>{path}</span>
      <button class="ib" aria-label="Merge tool file actions" title="File actions" onclick={fileMenu}><svg class="i"><use href="#i-dots" /></svg></button>
    </div>
    <div class="grp end">
      {#if confirm === "cancel"}
        <span class="mt-warn">Discard your merge edits?</span>
        <button class="btn danger" onclick={() => cancel(true)}>Discard</button>
        <button class="btn" onclick={() => (confirm = null)}>Keep editing</button>
      {:else if confirm}
        <span class="mt-warn">{openCount} unresolved conflict{openCount === 1 ? "" : "s"}: saved as conflict markers{confirm === "stage" ? " and staged" : ""}</span>
        <button class="btn danger" onclick={() => save(confirm === "stage", true)}>Save anyway</button>
        <button class="btn" onclick={() => (confirm = null)}>Back</button>
      {:else}
        <button class="btn" onclick={() => cancel()}>Cancel</button>
        <span class="split">
          <button class="btn" disabled={busy || !!reason || !data} onclick={() => save(true)}>Save and Stage</button>
          <button class="btn dd" aria-label="Save options" disabled={busy || !!reason || !data} onclick={saveMenu}><svg class="i"><use href="#i-down" /></svg></button>
        </span>
      {/if}
    </div>
  </header>
  {#if error}<p class="err pad" role="alert">{error}</p>{/if}
  {#if !data && !error}<p class="hint pad">Loading…</p>
  {:else if data && reason}
    <div class="mt-whole">
      <h2>{path}</h2>
      <p>{reason} It can't be merged line by line; keep one whole side.</p>
      <div class="row">
        <button class="btn" disabled={busy} onclick={() => resolveWith(false)}>Resolve Using Ours{data.ours ? "" : " (delete the file)"}</button>
        <button class="btn" disabled={busy} onclick={() => resolveWith(true)}>Resolve Using Theirs{data.theirs ? "" : " (delete the file)"}</button>
        <button class="btn" onclick={() => openInEditor(tab, path)}>Open in Editor</button>
      </div>
      <p class="hint">Ours: {sideLabel(data.ours_commit)} · Theirs: {sideLabel(data.theirs_commit)}</p>
    </div>
  {:else if data}
    <div class="mt-heads">
      <span title="Ours">{sideLabel(data.ours_commit)}</span>
      <span></span>
      <span class="seg" role="tablist">
        <button role="tab" class:on={showBase} aria-selected={showBase} onclick={() => (showBase = true)}>Base</button>
        <button role="tab" class:on={!showBase} aria-selected={!showBase} onclick={() => (showBase = false)}>Merged{openCount ? ` (${openCount})` : ""}</button>
      </span>
      <span></span>
      <span title="Theirs">{sideLabel(data.theirs_commit)}</span>
    </div>
    <div class="mt-cols" bind:this={area}>
      <div class="mt-col" bind:this={oursEl}></div>
      <div class="mt-strip">
        <svg width={W} height="100%" aria-hidden="true">{#each links.left as l (l.c)}<polygon class="mt-link {l.kind}" class:open={l.open} points={poly(l, W)} />{/each}</svg>
        {#each links.left as l (l.c)}<button class="mt-arrow" style:top="{l.a[0]}px" title="Take this hunk from ours (right-click: more)" aria-label="Take ours for hunk {l.c}"
          onclick={() => take(l.c, "ours")} oncontextmenu={(e) => takeMenu(e, l.c)} disabled={showBase}>▶</button>{/each}
      </div>
      <div class="mt-col" class:gone={showBase} bind:this={mergedEl}></div>
      <div class="mt-col" class:gone={!showBase} bind:this={baseEl}></div>
      <div class="mt-strip">
        <svg width={W} height="100%" aria-hidden="true">{#each links.right as l (l.c)}<polygon class="mt-link {l.kind}" class:open={l.open} points={poly(l, W)} />{/each}</svg>
        {#each links.right as l (l.c)}<button class="mt-arrow right" style:top="{l.b[0]}px" title="Take this hunk from theirs (right-click: more)" aria-label="Take theirs for hunk {l.c}"
          onclick={() => take(l.c, "theirs")} oncontextmenu={(e) => takeMenu(e, l.c)} disabled={showBase}>◀</button>{/each}
      </div>
      <div class="mt-col" bind:this={theirsEl}></div>
    </div>
  {/if}
</div>
