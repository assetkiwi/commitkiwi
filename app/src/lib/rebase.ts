// Interactive rebase editor (components/RebaseEditor.svelte): rows in todo order (oldest first), moves, actions,
// the resulting commits, validation and the steps sent to Req::InteractiveRebase. Pure and import-free
// (node-tested); core checks everything again.

export type TodoAction = "pick" | "reword" | "squash" | "fixup" | "drop";
/** crates/protocol RebaseCommit */
export interface RebaseCommit { oid: string; author: string; time: number; subject: string; message: string; published: boolean }
/** `message`: the edited message of a reword row (null: not edited yet, the commit's own) */
export interface Row { commit: RebaseCommit; action: TodoAction; message: string | null }
export interface Step { oid: string; action: TodoAction; message: string | null }
/** A commit of the result: the row it starts from, the rows squashed or fixed up into it, and its subject. */
export interface Result { head: Row; joined: Row[]; subject: string }

export const ACTIONS: { action: TodoAction; key: string; label: string; detail: string }[] = [
  { action: "pick", key: "p", label: "Pick", detail: "keep the commit" },
  { action: "reword", key: "r", label: "Reword", detail: "keep it, new message" },
  { action: "squash", key: "s", label: "Squash", detail: "join the commit above, both messages" },
  { action: "fixup", key: "f", label: "Fixup", detail: "join the commit above, keep its message" },
  { action: "drop", key: "d", label: "Drop", detail: "remove the commit" },
];
export const actionForKey = (key: string): TodoAction | null => ACTIONS.find((a) => a.key === key.toLowerCase())?.action ?? null;

export const initialRows = (commits: RebaseCommit[]): Row[] => commits.map((commit) => ({ commit, action: "pick", message: null }));

/** `rows` with the row at `from` moved to index `to` (clamped). */
export function moveRow(rows: Row[], from: number, to: number): Row[] {
  const t = Math.max(0, Math.min(rows.length - 1, to));
  if (from === t || from < 0 || from >= rows.length) return rows;
  const out = [...rows];
  const [r] = out.splice(from, 1);
  out.splice(t, 0, r);
  return out;
}

/** Reword starts with the commit's message to edit. */
export function setAction(rows: Row[], i: number, action: TodoAction): Row[] {
  return rows.map((r, k) => (k !== i ? r : { ...r, action, message: action === "reword" ? (r.message ?? r.commit.message) : r.message }));
}

const firstLine = (m: string) => m.split("\n", 1)[0];

/** The commits the rebase leaves, oldest first: squash/fixup rows join the nearest kept row above them. */
export function preview(rows: Row[]): Result[] {
  const out: Result[] = [];
  for (const r of rows) {
    if (r.action === "drop") continue;
    if ((r.action === "squash" || r.action === "fixup") && out.length) { out[out.length - 1].joined.push(r); continue; }
    out.push({ head: r, joined: [], subject: firstLine(r.action === "reword" ? (r.message ?? r.commit.message) : r.commit.message) });
  }
  return out;
}

export function toSteps(rows: Row[]): Step[] {
  return rows.map((r) => ({ oid: r.commit.oid, action: r.action, message: r.action === "reword" ? (r.message ?? r.commit.message) : null }));
}

/** Index of the first row that differs from the original list (everything from there is rewritten); -1: no change. */
export function firstChange(rows: Row[], original: RebaseCommit[]): number {
  return rows.findIndex((r, i) => r.action !== "pick" || r.commit.oid !== original[i]?.oid);
}

/** Commits already on a remote branch that the rebase would rewrite (they then need a force push). */
export function publishedRewritten(rows: Row[], original: RebaseCommit[]): number {
  const i = firstChange(rows, original);
  return i < 0 ? 0 : original.slice(i).filter((c) => c.published).length;
}

const short = (r: Row) => r.commit.oid.slice(0, 7);

/** Why Apply is not possible yet, or null. */
export function validate(rows: Row[], original: RebaseCommit[]): string | null {
  let kept = false;
  for (const r of rows) {
    if ((r.action === "squash" || r.action === "fixup") && !kept) return `${short(r)} cannot be ${r.action}: there is no kept commit above it to join.`;
    if (r.action === "reword" && !(r.message ?? r.commit.message).trim()) return `The new message for ${short(r)} is empty.`;
    kept ||= r.action !== "drop";
  }
  if (firstChange(rows, original) < 0) return "Nothing to change yet: drag commits or choose another action.";
  return null;
}

/** The console label: `git rebase -i <base> (3 commits: 1 moved, 1 squash, …)` */
export function jobLabel(rows: Row[], original: RebaseCommit[], base: string | null): string {
  const n: Record<string, number> = {};
  rows.forEach((r, i) => {
    if (r.action !== "pick") n[r.action] = (n[r.action] ?? 0) + 1;
    else if (r.commit.oid !== original[i]?.oid) n.moved = (n.moved ?? 0) + 1;
  });
  const what = Object.entries(n).map(([k, v]) => `${v} ${k}`).join(", ");
  return `git rebase -i ${base ? base.slice(0, 7) : "--root"} (${rows.length} commit${rows.length === 1 ? "" : "s"}${what ? `: ${what}` : ""})`;
}
