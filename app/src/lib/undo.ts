// Undo/Redo of git operations from the console journal (session-only, per repository). Pure and import-free
// (node-tested). The backend (`Req::Undo`) checks everything again against the repository before moving anything.
import type { Job, Moved, UndoMode } from "./journal";

/** Refs Undo restores: local branches, tags and the stash (remote-tracking refs show what the remote has). */
const LOCAL = /^refs\/(heads|tags)\/|^refs\/stash$/;
const headMoved = (m: Moved) => m.head_before.branch !== m.head_after.branch || m.head_before.oid !== m.head_after.oid;
export const movesLocal = (m: Moved): boolean => headMoved(m) || m.refs.some((r) => LOCAL.test(r.name));

/** How Undo moves HEAD back for a request: a commit's changes return staged, a reset comes back the way it went. */
export function undoModeOf(req: object): UndoMode {
  if ("Commit" in req) return "soft";
  const reset = (req as { Reset?: { mode: string } }).Reset;
  return reset?.mode === "soft" ? "soft" : reset?.mode === "mixed" ? "mixed" : "keep";
}

/**
 * Replay the repo's journal: entries that moved something stack up for Undo; an Undo moves its entry to the Redo
 * stack and a Redo moves it back; any other write that ran clears Redo (it may depend on the undone state).
 */
export function undoStacks(jobs: readonly Job[], repo: string): { done: Job[]; redo: Job[] } {
  const done: Job[] = [], redo: Job[] = [];
  for (const j of jobs) {
    if (j.repo !== repo || j.start === null || j.status === "running") continue; // never ran, or not finished
    if (j.undo) {
      if (j.status !== "ok") continue;
      const [from, to] = j.undo.redo ? [redo, done] : [done, redo];
      const i = from.findIndex((x) => x.id === j.undo!.of);
      if (i >= 0) to.push(...from.splice(i, 1));
      continue;
    }
    redo.length = 0;
    if (j.status === "ok" && j.moved && (movesLocal(j.moved) || j.moved.refs.length)) done.push(j);
  }
  return { done, redo };
}

/** What the repository looks like now: `branch` is the short name (null when detached). */
export interface RepoNow { branch: string | null; oid: string | null; busy: boolean; op: string | null }
/** The entry Undo (Redo) would act on, the menu caption, and why it is refused (null = allowed, pending the backend's check). */
export interface UndoPlan { job: Job | null; caption: string; reason: string | null }

export const shortLabel = (label: string): string => label.replace(/^git /, "");

export function undoPlan(stacks: { done: Job[]; redo: Job[] }, redo: boolean, now: RepoNow): UndoPlan {
  const verb = redo ? "Redo" : "Undo";
  const job = (redo ? stacks.redo : stacks.done).at(-1) ?? null;
  if (!job?.moved) return { job: null, caption: verb, reason: `Nothing to ${verb.toLowerCase()}` };
  const caption = `${verb}: ${shortLabel(job.label)}`;
  const at = redo ? job.moved.head_before : job.moved.head_after;
  const reason = now.busy ? "a git command is running"
    : !movesLocal(job.moved) ? "it only changed remote-tracking branches"
    : now.op ? `a ${now.op} is in progress`
    : at.oid !== now.oid || at.branch !== (now.branch && `refs/heads/${now.branch}`) ? "the repository changed since"
    : null;
  return { job, caption, reason };
}

/** A menu entry: the caption, with the reason when it is refused. */
export const planCaption = (p: { caption: string; reason: string | null }): string => (p.reason && p.reason !== `Nothing to ${p.caption.toLowerCase()}` ? `${p.caption} (${p.reason})` : p.caption);
