// M5a branch/ref overlays: argument checks and step state. Pure and import-free (node-tested).
// The backend checks every argument again (git check-ref-format, existing refs); this is for instant feedback.

/** Why `name` cannot be a new branch/tag name (git's check-ref-format rules, plus no option-like values), or null. */
export function refNameError(name: string): string | null {
  if (!name) return "Enter a name";
  if (name.startsWith("-")) return "A name cannot start with '-'";
  if (/[\s\x00-\x1f\x7f]/.test(name)) return "A name cannot contain spaces or control characters";
  if (/[~^:?*[\\]/.test(name)) return "A name cannot contain ~ ^ : ? * [ or \\";
  if (name === "@" || name === "HEAD") return `'${name}' is reserved`;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return "A name cannot contain '..', '@{' or '//'";
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return "A name cannot start or end with '/' or end with '.'";
  if (name.split("/").some((p) => p.startsWith(".") || p.endsWith(".lock"))) return "No part may start with '.' or end with '.lock'";
  return null;
}

/** Flags of a command (Merge, Stash): each picked flag becomes a pill; `excludes` are flags git refuses together. */
export interface Flag { flag: string; detail: string; excludes?: string[] }

export const MERGE_FLAGS: Flag[] = [
  { flag: "--no-ff", detail: "Always create a merge commit", excludes: ["--ff-only", "--squash"] },
  { flag: "--ff-only", detail: "Only fast-forward; refuse when a merge commit is needed", excludes: ["--no-ff", "--squash"] },
  { flag: "--squash", detail: "Stage the combined changes without committing or recording a merge", excludes: ["--no-ff", "--ff-only"] },
  { flag: "--no-commit", detail: "Merge, but stop before committing" },
];

/** Flags still offered after `chosen`: not chosen yet and not excluded by a chosen one (either way round). */
export function remainingFlags(all: Flag[], chosen: string[]): Flag[] {
  const by = new Map(all.map((f) => [f.flag, f]));
  return all.filter((f) => !chosen.includes(f.flag)
    && !chosen.some((c) => by.get(c)?.excludes?.includes(f.flag) || f.excludes?.includes(c)));
}

/** `origin/feature/x` -> ["origin", "feature/x"], matching the longest remote name (remote names may contain '/'). */
export function splitRemote(remotes: string[], name: string): [string, string] | null {
  const r = remotes.filter((x) => name.startsWith(`${x}/`) && name.length > x.length + 1).sort((a, b) => b.length - a.length)[0];
  return r ? [r, name.slice(r.length + 1)] : null;
}

/** git refused `branch -d` because the branch has commits nowhere else: offer `-D`. */
export const isUnmerged = (error: string): boolean => /not fully merged/.test(error);

export type ResetMode = "soft" | "mixed" | "keep" | "hard";
export const RESET_MODES: [ResetMode, string][] = [
  ["soft", "Keep index and working directory, differences will show as staged"],
  ["mixed", "Keep working directory, differences will show as modifications"],
  ["keep", "Reset index and working directory, but abort if any local changes would be discarded"],
  ["hard", "Reset index and working directory, ALL local changes are discarded"],
];

/** The confirm line of a hard reset: what is lost. `commits`: commits that leave the branch, `files`: changed files. */
export function hardResetLoss(branch: string, commits: number, files: number): string {
  const s = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const parts = [commits && `${s(commits, "commit")} will leave ${branch}`, files && `${s(files, "uncommitted file change")} will be discarded`].filter(Boolean);
  return parts.length ? `${parts.join("; ")}.` : "Nothing is lost: no commits leave the branch and the working directory is clean.";
}

/** What is in progress, for the banner: `op` from Status (rebase/cherry-pick/revert); merge has its own UI. */
export function sequenceTitle(op: string): string {
  return op === "cherry-pick" ? "Cherry-pick in progress" : op === "revert" ? "Revert in progress" : "Rebase in progress";
}

// ---- pull/push option overlays, remotes

/** Pull options: what runs, and a description. */
export const PULL_OPTIONS: { label: string; verb: "pull" | "fetch"; flags: string[]; detail: string }[] = [
  { label: "pull", verb: "pull", flags: [], detail: "Retrieves changes from the remote and merges them into the current branch" },
  { label: "pull --ff-only", verb: "pull", flags: ["--ff-only"], detail: "Retrieves changes from the remote and fast-forwards the current branch" },
  { label: "pull --rebase", verb: "pull", flags: ["--rebase"], detail: "Retrieves changes from the remote and rebases the current branch onto them" },
  { label: "pull --rebase --autostash", verb: "pull", flags: ["--rebase", "--autostash"], detail: "Stashes any uncommitted changes before running pull --rebase" },
  { label: "fetch", verb: "fetch", flags: [], detail: "Retrieves changes from the remote" },
  { label: "fetch --tags", verb: "fetch", flags: ["--tags"], detail: "Retrieves changes from the remote including all tags" },
  { label: "fetch --prune", verb: "fetch", flags: ["--prune"], detail: "Retrieves changes from the remote and removes deleted remote branches" },
];

/** Push options; `confirm`: asks again before running (it can throw away commits on the remote). */
export const PUSH_OPTIONS: { label: string; flags: string[]; detail: string; confirm?: boolean }[] = [
  { label: "push", flags: [], detail: "Sends changes from the current local branch to the remote" },
  { label: "push --force", flags: ["--force"], detail: "Replaces the branch on the remote with the current local branch", confirm: true },
  { label: "push --force-with-lease", flags: ["--force-with-lease"], detail: "push --force but checks that the remote branch hasn't been updated since the last fetch" },
  { label: "push --no-verify", flags: ["--no-verify"], detail: "Push without running the pre-push hook" },
];

/**
 * Push › branch › remote: the defaults from the branch's upstream (`origin/main`). A null field is a step the user
 * must answer: no branch when HEAD is detached, no remote when there is no upstream and not exactly one remote.
 */
export function pushTarget(branch: string | null, upstream: string | null | undefined, remotes: string[]): { branch: string | null; remote: string | null } {
  const up = upstream ? splitRemote(remotes, upstream)?.[0] : undefined;
  return { branch, remote: up ?? (remotes.length === 1 ? remotes[0] : null) };
}

/** Why `url` cannot be a remote URL (the backend checks again), or null. */
export function remoteUrlError(url: string): string | null {
  const u = url.trim();
  if (!u) return "Enter a URL or path";
  if (u.startsWith("-")) return "A URL cannot start with '-'";
  if (/[\x00-\x1f\x7f]/.test(u)) return "A URL cannot contain control characters";
  if (/^ext::/i.test(u)) return "ext:: URLs run commands; not allowed";
  return null;
}
