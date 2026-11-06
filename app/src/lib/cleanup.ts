// Branch cleanup assistant (components/BranchCleanup.svelte): grouping, filter, default selection, what a delete
// sends and how it is labelled. Pure and import-free (node-tested). The backend (Req::CleanupCandidates) decides
// which branches are candidates; the reasons come from it.

/** crates/protocol CleanupBranch: `name` is the full ref, `remote` set for remote-tracking branches */
export interface CleanupBranch {
  name: string; remote: string | null; oid: string; time: number; author: string; subject: string;
  ahead: number; behind: number; merged: boolean; stale: boolean; gone: boolean;
}
export interface Cleanup { default_branch: string | null; branches: CleanupBranch[]; truncated: boolean }

export type GroupId = "merged" | "gone" | "stale" | "remote-merged" | "remote-stale";
export const GROUPS: { id: GroupId; title: string; remote: boolean }[] = [
  { id: "merged", title: "Merged", remote: false },
  { id: "gone", title: "Upstream gone", remote: false },
  { id: "stale", title: "Stale", remote: false },
  { id: "remote-merged", title: "Remote: merged", remote: true },
  { id: "remote-stale", title: "Remote: stale", remote: true },
];

/** One group per branch, by its strongest reason (merged, then upstream gone, then stale); tags show all of them. */
export function groupOf(b: CleanupBranch): GroupId {
  if (b.remote !== null) return b.merged ? "remote-merged" : "remote-stale";
  return b.merged ? "merged" : b.gone ? "gone" : "stale";
}

export const tagsOf = (b: CleanupBranch): string[] =>
  [b.merged && "merged", b.stale && "stale", b.gone && "upstream gone"].filter((t): t is string => !!t);

/** `x` for refs/heads/x, `origin/x` for refs/remotes/origin/x */
export const shortName = (b: CleanupBranch): string => b.name.replace(/^refs\/(heads|remotes)\//, "");
/** the branch name on its remote (`x` for origin/x) */
export const remoteBranchName = (b: CleanupBranch): string => (b.remote ? shortName(b).slice(b.remote.length + 1) : shortName(b));

/** Case-insensitive substring match on the name, subject or author; every word must match. */
export function filterBranches(list: CleanupBranch[], q: string): CleanupBranch[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((b) => { const hay = `${shortName(b)} ${b.subject} ${b.author}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
}

/** Preselected: merged branches only (local and remote). Unmerged ones (stale, upstream gone) wait for a click. */
export const initialSelection = (list: CleanupBranch[]): Set<string> => new Set(list.filter((b) => b.merged).map((b) => b.name));

/** What deleting the selection sends: local `merged` (-d) and `unmerged` (-D, confirmed first) as short names,
 *  remote ones as full refs grouped by remote. */
export function deletePlan(list: CleanupBranch[], selected: ReadonlySet<string>) {
  const chosen = list.filter((b) => selected.has(b.name));
  const local = chosen.filter((b) => b.remote === null);
  const remote = chosen.filter((b) => b.remote !== null);
  return {
    merged: local.filter((b) => b.merged).map(shortName),
    unmerged: local.filter((b) => !b.merged),
    remote,
    remotes: [...new Set(remote.map((b) => b.remote!))].sort(),
  };
}

export const branches = (n: number, kind = ""): string => `${n} ${kind ? `${kind} ` : ""}branch${n === 1 ? "" : "es"}`;
export const localCaption = (n: number): string => `Delete ${branches(n, "local")}`;
export const remoteCaption = (n: number): string => `Delete ${branches(n, "remote")}…`;

/** The console/journal label (Undo shows it): the command and the first few names. */
export function jobLabel(cmd: string, names: string[]): string {
  const shown = names.slice(0, 3).join(" ");
  return names.length <= 3 ? `${cmd} ${shown}` : `${cmd} ${shown} … (${branches(names.length)})`;
}

/** The two settings, cleaned of hand-edit mistakes: a whole number of days (0 = off), non-empty one-line patterns. */
export function cleanupSettings(days: unknown, protectedNames: unknown): { stale_days: number; protected: string[] } {
  const d = typeof days === "number" && Number.isFinite(days) ? Math.max(0, Math.min(36500, Math.floor(days))) : 90;
  const p = Array.isArray(protectedNames) ? protectedNames.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x && !/[\x00-\x1f]/.test(x)) : [];
  return { stale_days: d, protected: [...new Set(p)].slice(0, 200) };
}
