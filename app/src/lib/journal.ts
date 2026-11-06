// The console journal's state machine: every git write is a job, run one at a time per repository, in order.
// Import-free (node-tested); `jobs.svelte.ts` drives it.

export type JobStatus = "queued" | "running" | "ok" | "failed" | "cancelled";
/** HEAD before/after a ref-moving job (`Resp::Moved`): what Undo will rewind. */
export interface Head { branch: string | null; oid: string | null }
export interface Moved { head_before: Head; head_after: Head; refs: { name: string; before: string | null; after: string | null }[] }
/** How Undo/Redo moves HEAD on its branch (protocol `UndoMode`): soft keeps index+tree, mixed resets the index, keep updates the tree safely. */
export type UndoMode = "soft" | "mixed" | "keep";
export interface Job {
  id: number;
  /** the tab id (`location|root`): the queue it waits in */
  repo: string;
  /** what the console shows: the git command line */
  label: string;
  status: JobStatus;
  queued: number;
  start: number | null;
  end: number | null;
  /** git's stdout and stderr as they arrived, `\r` redraws applied */
  output: string;
  error: string;
  /** set when Cancel was pressed while it ran (the kill is in flight) */
  cancelling: boolean;
  moved: Moved | null;
  /** how Undo moves HEAD back for this kind of command (set by runGit) */
  mode?: UndoMode;
  /** an Undo/Redo job: the entry it undid or redid */
  undo?: { of: number; redo: boolean };
}

export const NOT_RUN = "Not run: an earlier command failed or was cancelled.";

/** The job to start for `repo`: its oldest queued one, unless one is still running (strict FIFO). */
export function nextJob(jobs: readonly Job[], repo: string): Job | undefined {
  if (jobs.some((j) => j.repo === repo && j.status === "running")) return undefined;
  return jobs.find((j) => j.repo === repo && j.status === "queued");
}

/** What Cancel does: a queued job is dropped on the spot, a running one needs its git process killed. */
export function cancelAction(j: Job): "dequeue" | "kill" | null {
  return j.status === "queued" ? "dequeue" : j.status === "running" && !j.cancelling ? "kill" : null;
}

/** A failed or cancelled job ends its repo's queue: the commands behind it may depend on it. Returns them. */
export function dependents(jobs: readonly Job[], failed: Job): Job[] {
  return jobs.filter((j) => j.repo === failed.repo && j.status === "queued" && j.id > failed.id);
}

/** Append a chunk of git output like a terminal: `\r` returns to the start of the line, so a progress counter redraws. */
export function appendOutput(out: string, chunk: string): string {
  let s = out;
  let cr = s.endsWith("\r"); // a pending carriage return from the previous chunk
  if (cr) s = s.slice(0, -1);
  for (const part of chunk.split(/(\r\n|\r|\n)/)) {
    if (part === "\n" || part === "\r\n") { s += "\n"; cr = false; }
    else if (part === "\r") cr = true;
    else if (part) {
      if (cr) { s = s.slice(0, s.lastIndexOf("\n") + 1); cr = false; }
      s += part;
    }
  }
  return cr ? s + "\r" : s;
}

/** The toolbar console button: busy while anything runs or waits, else how the last command that ran ended. */
export function consoleState(jobs: readonly Job[], repo: string): "idle" | "running" | "ok" | "failed" {
  const mine = jobs.filter((j) => j.repo === repo);
  if (mine.some((j) => j.status === "running" || j.status === "queued")) return "running";
  const last = mine.filter((j) => j.start !== null).at(-1); // dropped from the queue = never ran
  return !last ? "idle" : last.status === "failed" ? "failed" : "ok";
}

/** Keep the journal bounded: drop the oldest finished jobs beyond `max` (never queued or running ones). */
export function trimJobs(jobs: Job[], max: number): Job[] {
  let extra = jobs.length - max;
  if (extra <= 0) return jobs;
  return jobs.filter((j) => extra <= 0 || j.status === "queued" || j.status === "running" || !extra--);
}

/** Hide a password in a URL (`https://user:secret@host` -> `https://user:***@host`): labels show typed URLs. */
export const redactUrls = (text: string): string => text.replace(/(:\/\/[^\s/@:'"]*:)[^\s/@'"]*@/g, "$1***@");
