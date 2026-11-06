<script lang="ts">
  // Rebase Interactively…: the commits from `from` (null: the unpushed ones) up to HEAD, oldest at the top like git's
  // todo list. Drag a row's handle (pointer events, as in the tab bar: HTML5 drag and drop belongs to the webview's
  // file drop) or press Alt+↑/↓ to move it, pick an action per row (or press p/r/s/f/d), edit reword messages inline,
  // then Apply: one queued job (Req::InteractiveRebase), Undo puts the branch back. Pure logic in lib/rebase.ts.
  import { tick, untrack } from "svelte";
  import { api } from "../lib/api";
  import { ACTIONS, actionForKey, initialRows, jobLabel, moveRow, preview, publishedRewritten, setAction, toSteps, validate, type Row, type TodoAction } from "../lib/rebase";
  import { ago, fullDate } from "../lib/format";
  import type { RebasePlan, Req } from "../lib/types";
  import type { Tab } from "../lib/state.svelte";

  /** `onapply`: runs the job; resolves with git's refusal (the editor stays open) or null (done, or it stopped) */
  let { tab, from, onapply, onclose }: { tab: Tab; from: string | null; onapply: (label: string, req: Req) => Promise<string | null>; onclose: () => void } = $props();
  const repo = untrack(() => tab.path), loc = untrack(() => tab.location);

  let plan = $state.raw<RebasePlan | null>(null);
  let rows = $state.raw<Row[]>([]);
  let error = $state(""), busy = $state(false), forceOk = $state(false);
  api.rebasePlan(loc, repo, untrack(() => from)).then((p) => { plan = p; rows = initialRows(p.commits); void focusRow(0); }, (e) => { error = String(e); });

  const original = $derived(plan?.commits ?? []);
  const result = $derived(preview(rows));
  const invalid = $derived(plan ? validate(rows, original) : null);
  const pushed = $derived(publishedRewritten(rows, original));
  $effect(() => { if (!pushed) forceOk = false; });
  const short = (oid: string) => oid.slice(0, 7);

  // ---- drag to reorder: a press becomes a drag past DRAG_PX; Escape cancels
  const DRAG_PX = 5;
  let list = $state<HTMLElement>();
  let press: { i: number; y: number; pointer: number } | null = null;
  /** `gap`: where the row would land (0 = above the first); `y`: the insertion mark in the list's coordinates */
  let drag = $state<{ i: number; gap: number; y: number } | null>(null);
  function down(e: PointerEvent, i: number) {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    press = { i, y: e.clientY, pointer: e.pointerId };
  }
  function gapAt(clientY: number): { gap: number; y: number } {
    const rects = [...list!.querySelectorAll<HTMLElement>(":scope > .rb-row")].map((el) => el.getBoundingClientRect());
    const top = list!.getBoundingClientRect().top - list!.scrollTop;
    const at = rects.findIndex((r) => clientY < r.top + r.height / 2);
    const gap = at < 0 ? rects.length : at;
    return { gap, y: (gap < rects.length ? rects[gap].top : rects[rects.length - 1].bottom) - top - 1 };
  }
  function move(e: PointerEvent) {
    if (!press || e.pointerId !== press.pointer) return;
    if (!drag) {
      if (Math.abs(e.clientY - press.y) < DRAG_PX) return;
      list!.querySelectorAll<HTMLElement>(":scope > .rb-row")[press.i]?.setPointerCapture(e.pointerId);
    }
    drag = { i: press.i, ...gapAt(e.clientY) };
  }
  function up(e: PointerEvent) {
    if (!press || e.pointerId !== press.pointer) return;
    const d = drag;
    press = null;
    drag = null;
    if (!d || e.type === "pointercancel") return;
    rows = moveRow(rows, d.i, d.gap > d.i ? d.gap - 1 : d.gap);
  }

  // ---- keyboard: ↑/↓ focus, Alt+↑/↓ move, p/r/s/f/d set the action (on a focused row, not in its fields)
  async function focusRow(i: number) {
    await tick();
    list?.querySelectorAll<HTMLElement>(":scope > .rb-row")[i]?.focus();
  }
  function rowKey(e: KeyboardEvent, i: number) {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey) return;
    const dir = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    const action = e.altKey || e.shiftKey ? null : actionForKey(e.key);
    if (!dir && !action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action) { rows = setAction(rows, i, action); return; }
    const to = Math.max(0, Math.min(rows.length - 1, i + dir));
    if (e.altKey) rows = moveRow(rows, i, to);
    void focusRow(to);
  }
  const setMessage = (i: number, message: string) => { rows = rows.map((r, k) => (k === i ? { ...r, message } : r)); };

  async function apply() {
    if (!plan || invalid || (pushed && !forceOk)) return;
    busy = true;
    error = "";
    const req: Req = { InteractiveRebase: { repo, base: plan.base, head: plan.head, steps: toSteps(rows), published_ok: pushed > 0 } };
    error = (await onapply(jobLabel(rows, original, plan.base), req))?.replace(/^PUBLISHED: /, "") ?? "";
    busy = false;
  }

  const onkeydown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (drag) { e.preventDefault(); press = null; drag = null; } else if (!busy) onclose();
  };
</script>

<svelte:window {onkeydown} onpointermove={move} onpointerup={up} onpointercancel={up} />
<div class="scrim dim" role="presentation" onmousedown={() => { if (!busy) onclose(); }}></div>
<div class="overlay add-repos forge cleanup rebase" role="dialog" aria-label="Interactive Rebase" data-control="rebase_editor">
  <div class="ar-form">
    <h1>Interactive Rebase{plan?.branch ? ` of ${plan.branch}` : ""}</h1>
    <p class="hint">Oldest at the top. Drag a row by its handle or press Alt+↑/↓ to move it; p, r, s, f, d set the action of the focused row. Squash and fixup join the commit above.{plan ? ` Onto ${plan.base ? short(plan.base) : "the root"}.` : ""}</p>
  </div>
  <div class="cl-list rb-body">
    {#if error}<p class="err" role="alert">{error}</p>{/if}
    {#if !plan && !error}<p class="hint">Reading the commits…</p>{/if}
    {#if plan}
      <ol class="rb-rows" class:dragging={!!drag} bind:this={list} aria-label="Todo list" role="listbox">
        {#each rows as r, i (r.commit.oid)}
          <li class="rb-row {r.action}" class:lifted={drag?.i === i} data-oid={r.commit.oid} tabindex="0" role="option" aria-selected="false" aria-label="{r.action} {short(r.commit.oid)} {r.commit.subject}"
            onkeydown={(e) => rowKey(e, i)}>
            <span class="rb-handle" role="presentation" title="Drag to move" onpointerdown={(e) => down(e, i)}>⠿</span>
            <select aria-label="Action for {short(r.commit.oid)}" value={r.action} onchange={(e) => (rows = setAction(rows, i, e.currentTarget.value as TodoAction))}>
              {#each ACTIONS as a}<option value={a.action} title={a.detail}>{a.label}</option>{/each}
            </select>
            <span class="rb-main">
              <span class="rb-subject"><span class="mono">{short(r.commit.oid)}</span> {r.commit.subject}{#if r.commit.published}<span class="cl-tag" title="Already on a remote branch">pushed</span>{/if}</span>
              <span class="sub" title={fullDate(r.commit.time)}>{r.commit.author} · {ago(r.commit.time)}</span>
              {#if r.action === "reword"}
                <textarea aria-label="New message for {short(r.commit.oid)}" value={r.message ?? r.commit.message} spellcheck="false" oninput={(e) => setMessage(i, e.currentTarget.value)}></textarea>
              {/if}
            </span>
          </li>
        {/each}
        {#if drag}<span class="rb-drop" style:top={`${drag.y}px`} aria-hidden="true"></span>{/if}
      </ol>
      <h2 class="rb-h">Result: {result.length} commit{result.length === 1 ? "" : "s"}</h2>
      <ol class="rb-preview" aria-label="Result">
        {#each result as g (g.head.commit.oid)}
          <li><span class="mono">{short(g.head.commit.oid)}</span> {g.subject}{#if g.joined.length}<span class="sub">{` + ${g.joined.map((j) => `${j.action} ${short(j.commit.oid)}`).join(", ")}`}</span>{/if}</li>
        {:else}
          <li class="sub">No commits left: the branch goes back to {plan.base ? short(plan.base) : "nothing"}.</li>
        {/each}
      </ol>
    {/if}
  </div>
  {#if pushed}
    <label class="rb-warn ck"><input type="checkbox" bind:checked={forceOk} />
      <span>{pushed} commit{pushed === 1 ? " is" : "s are"} already pushed. Rewriting {pushed === 1 ? "it" : "them"} will need a force push, and others who have {pushed === 1 ? "it" : "them"} will need to reset.</span></label>
  {/if}
  <div class="ar-bar end">
    <span class="sub">{invalid && rows.length ? invalid : ""}</span>
    <button class="btn" disabled={busy} onclick={onclose}>Cancel</button>
    <button class="primary" disabled={busy || !plan || !!invalid || (pushed > 0 && !forceOk)} onclick={apply}>{busy ? "Rebasing…" : "Apply"}</button>
  </div>
</div>
