// The multi-repository dashboard's pure parts: a row's state badge, sorting, the fast-forward-only pull check,
// offline detection, a timeout and a bounded worker pool. Import-free (node tests).
export interface OverviewLike { branch: string | null; upstream: string | null; ahead: number; behind: number; changed: number; time: number | null }
export type RowState = "loading" | "clean" | "dirty" | "ahead" | "behind" | "diverged" | "error" | "offline";
export type SortBy = "name" | "dirty" | "activity";

/** Status reads at once, and fetches at once (Fetch All). */
export const READ_LIMIT = 4;
export const FETCH_LIMIT = 3;
/** A row's status read gives up after this: its repository shows "offline" (remote) or the error (local). */
export const READ_TIMEOUT_MS = 15_000;

/** One badge per row, the most pressing first: diverged, uncommitted changes, behind, ahead, clean. */
export function stateOf(o: OverviewLike | null, error: string | null, offline: boolean): RowState {
  if (offline) return "offline";
  if (error) return "error";
  if (!o) return "loading";
  if (o.ahead && o.behind) return "diverged";
  if (o.changed) return "dirty";
  return o.behind ? "behind" : o.ahead ? "ahead" : "clean";
}

/** A remote repository whose host did not answer in time, or whose ssh link / agent failed (not a git error there).
 *  shortcut: matched on the message text, since connection and git errors reach the UI as plain strings; a
 *  structured error kind from the runner would be exact. */
export const isOffline = (location: string, error: string): boolean =>
  location.startsWith("ssh:") && /timed out|ssh|connect|unreachable|resolve hostname|host key|broken pipe|agent|reconnecting/i.test(error);

/** Why the dashboard's fast-forward-only pull is refused before it runs, or null when it may run. */
export function pullRefusal(o: OverviewLike | null): string | null {
  if (!o) return "Its status is not known yet.";
  if (!o.branch) return "HEAD is detached: check out a branch first.";
  if (!o.upstream) return `${o.branch} has no upstream branch to pull from.`;
  if (o.ahead && o.behind) return diverged(o.branch, o.upstream);
  return null;
}
const diverged = (branch: string, upstream: string) => `Not a fast-forward: ${branch} and ${upstream} have diverged. Merge or rebase in its tab.`;
/** git's own refusal (the upstream moved since the last look) in the same words. */
export const pullError = (error: string, o: OverviewLike | null): string =>
  /not possible to fast-forward|diverg/i.test(error) ? diverged(o?.branch ?? "the branch", o?.upstream ?? "its upstream") : error;

/** Sorted copy: by `name`; uncommitted changes first (most first); or the newest last commit first. Ties by name. */
export function sortRows<R>(rows: R[], by: SortBy, name: (r: R) => string, o: (r: R) => OverviewLike | null): R[] {
  const byName = (a: R, b: R) => name(a).localeCompare(name(b));
  const key = (r: R) => (by === "dirty" ? o(r)?.changed ?? -1 : by === "activity" ? o(r)?.time ?? -1 : 0);
  return [...rows].sort((a, b) => key(b) - key(a) || byName(a, b));
}

/** `p`, or a rejection with "timed out after N s" (the request itself keeps running; its answer is ignored). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(`timed out after ${Math.round(ms / 1000)} s`), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** `fn` over `items` in order, at most `limit` at once; no new one starts once `stopped()` is true. `fn` handles its
 *  own errors (a rejection is ignored so the other workers go on). */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>, stopped: () => boolean = () => false): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stopped()) await fn(items[next++]).catch(() => {});
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
