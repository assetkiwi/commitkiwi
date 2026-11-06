// The one runner every git write goes through: a per-repository FIFO queue of console jobs, journaled for the
// console panel and Undo/Redo (`undo.ts`). Session-only. Reads never wait here: they call `api` directly.
import { api } from "./api";
import { appendOutput, cancelAction, dependents, nextJob, NOT_RUN, redactUrls, trimJobs, type Job } from "./journal";
import { undoModeOf } from "./undo";
import type { Req } from "./types";

export type { Job };
export const CANCELLED = "Cancelled";
const MAX_JOBS = 300;

export const journal = $state({ jobs: [] as Job[] });

let seq = 0;
/** what is not in the reactive entry: the request (until it starts), where it runs, and its caller's promise */
const pending = new Map<number, { location: string; req: Req | null; resolve: (r: unknown) => void; reject: (e: unknown) => void }>();
const find = (id: number) => journal.jobs.find((j) => j.id === id);

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  void api.onJobOutput((id, text) => { const j = find(id); if (j) j.output = appendOutput(j.output, text); });
}

/**
 * Queue a git write for the tab's repository and wait for it. `label` is the git command line the console shows.
 * Resolves with the backend's reply; rejects with git's error, or with `CANCELLED`. `undo`: this is an Undo/Redo of that entry.
 */
export function runGit(tab: { id: string; location: string }, label: string, req: Req, undo?: Job["undo"]): Promise<unknown> {
  listen();
  const id = ++seq;
  const mode = typeof req === "string" ? undefined : undoModeOf(req);
  journal.jobs.push({ id, repo: tab.id, label: redactUrls(label), status: "queued", queued: Date.now(), start: null, end: null, output: "", error: "", cancelling: false, moved: null, mode, undo });
  journal.jobs = trimJobs(journal.jobs, MAX_JOBS);
  const done = new Promise((resolve, reject) => pending.set(id, { location: tab.location, req, resolve, reject }));
  void pump(tab.id);
  return done;
}

function finish(j: Job, status: Job["status"], error = "", reply?: unknown) {
  j.status = status;
  j.error = error;
  j.end = Date.now();
  const p = pending.get(j.id);
  pending.delete(j.id);
  if (status === "ok") p?.resolve(reply);
  else p?.reject(status === "cancelled" ? CANCELLED : error);
}

async function pump(repo: string) {
  const j = nextJob(journal.jobs, repo);
  const p = j && pending.get(j.id);
  if (!j || !p?.req) return;
  const req = p.req;
  p.req = null;
  j.status = "running";
  j.start = Date.now();
  try {
    const r = await api.job(p.location, j.id, req);
    if (r && typeof r === "object" && "Moved" in r) j.moved = r.Moved;
    finish(j, "ok", "", r);
  } catch (e) {
    finish(j, j.cancelling ? "cancelled" : "failed", redactUrls(String(e)));
    // the commands behind it may depend on it
    for (const d of dependents(journal.jobs, j)) finish(d, "cancelled", NOT_RUN);
  }
  void pump(repo);
}

/** The console's Cancel button: drop a queued job, or kill the running one's git process. */
export async function cancelJob(id: number): Promise<void> {
  const j = find(id);
  const action = j && cancelAction(j);
  if (!j || !action) return;
  if (action === "dequeue") { finish(j, "cancelled"); return; }
  j.cancelling = true;
  const location = pending.get(id)?.location;
  if (location) await api.cancel(location, id);
}

/** A remote link dropped: its queued writes fail ("connection lost") instead of running blindly after a reconnect.
 *  The running one fails by itself (its call ends with the connection). */
export function failQueued(location: string, why: string): void {
  for (const j of journal.jobs) {
    if (j.status === "queued" && pending.get(j.id)?.location === location) finish(j, "failed", `connection lost: ${why}`);
  }
}
