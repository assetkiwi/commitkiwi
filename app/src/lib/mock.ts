// Browser-only stand-in for the Rust backend; same response shapes as crates/protocol.
import type { GenInput } from "./commitModel";
import type { SearchModelInput } from "./nlSearch";
import type { Commit, DownloadEvent, ModelInfo, RepoChange, Req } from "./types";
import { legacyName, type ImportItem } from "./api";
import { MENU_FILES } from "./contextMenus";

const N = 50_000;
const SUBJECTS = ["Move DDEV, the composer platform and CI to PHP 8.3", "Patch the remaining implicitly nullable params", "Update the scaffolded example.settings.local.php", "Update entity_usage to 5.0", "Update optional_end_date to 2.0", "Attach core/htmx instead of htmx/htmx", "Update diff to 2.1.1", "Replace tokens in block titles", "Patch a contrib settings form", "Export config after the updates"];
const PEOPLE: [string, string][] = [["Jane Doe", "jane@example.com"], ["John Smith", "john@example.com"], ["Alex Martin", "alex@example.com"]];
// oid encodes its index so Stats can map back
const oid = (i: number) => i.toString(16).padStart(8, "0") + "c3f19a2e".repeat(4);
const index = (o: string) => parseInt(o.slice(0, 8), 16);

// every 40th commit is a merge of a 5-commit side branch (rows i+1..i+5, only reachable through the merge)
const parentsOf = (i: number): number[] => (i + 1 >= N ? [] : i % 40 === 0 && i + 6 < N ? [i + 6, i + 1] : [i + 1]);

function commit(i: number): Commit {
  const [author, email] = PEOPLE[i % 7 === 0 ? 1 : i % 11 === 0 ? 2 : 0];
  const labels: Commit["labels"] =
    i === 0 ? [{ name: "feature/d11-upgrade-C", kind: "branch", head: true }, { name: "origin/feature/d11-upgrade-C", kind: "remote", head: false }]
    : i === 12 ? [{ name: "feature/d11-upgrade-B", kind: "branch", head: false }]
    : i === 40 ? [{ name: "v2.4.0", kind: "tag", head: false }] : [];
  return { oid: oid(i), parents: parentsOf(i).map(oid), author, email, time: Math.floor(Date.now() / 1000) - i * 1800,
    subject: `[25505977]: ${SUBJECTS[i % SUBJECTS.length]}`, files: null, labels };
}

// In-memory working copy so staging, discarding and committing can be exercised in the browser.
interface MockFile { path: string; old_path: string | null; index: string; worktree: string; kind: string }
let branch = "feature/d11-upgrade-C"; // Checkout changes it
let head = 0; // HEAD's commit index: Undo/Redo move it (a commit reports moving from its parent, row 1, to row 0)
let remotes = ["origin"];
let work: MockFile[] = [
  { path: "composer.json", old_path: null, index: ".", worktree: "M", kind: "changed" },
  { path: "README.md", old_path: null, index: "M", worktree: "M", kind: "changed" },
  { path: "web/new_feature.php", old_path: null, index: ".", worktree: "?", kind: "untracked" },
  { path: "debug.log", old_path: null, index: ".", worktree: "?", kind: "untracked" },
];
let merge: string | null = null; // MERGE_MSG while a merge is in progress
let op: string | null = null; // a rebase/cherry-pick/revert stopped half-way
let edit: string | null = null; // the rebase stopped at this commit for Edit Commit Contents
// M5a writes change this list (create/rename/delete branch and tag)
let refs: { name: string; kind: string; oid: string; head: boolean; upstream?: string | null }[] = [
  { name: "feature/d11-upgrade-C", kind: "branch", oid: oid(0), head: true, upstream: "origin/feature/d11-upgrade-C" },
  { name: "feature/d11-upgrade-B", kind: "branch", oid: oid(12), head: false },
  { name: "main", kind: "branch", oid: oid(900), head: false, upstream: "origin/main" },
  { name: "origin/main", kind: "remote", oid: oid(900), head: false },
  { name: "origin/feature/d11-upgrade-C", kind: "remote", oid: oid(0), head: false },
  { name: "v2.4.0", kind: "tag", oid: oid(40), head: false },
  { name: "v2.3.0", kind: "tag", oid: oid(300), head: false },
];
const short = (rev: string) => rev.replace(/^refs\/(heads|remotes|tags)\//, "");
/** `__mockConflict.Merge = true`: that kind of job stops with a conflict (merge in progress, or `op` for the others) */
const wc = globalThis as unknown as { __mockConflict: Record<string, boolean> };
wc.__mockConflict = {};
function conflict(kind: string): never {
  if (kind === "Merge") merge = "Merge branch 'x'\n";
  else op = kind === "CherryPick" ? "cherry-pick" : kind === "Revert" ? "revert" : "rebase";
  work = [...work.filter((f) => f.path !== "composer.lock"), { path: "composer.lock", old_path: null, index: "U", worktree: "U", kind: "conflicted" }];
  throw "CONFLICT (content): Merge conflict in composer.lock";
}
const STASH = oid(0xabc0000);
// Tests read what the UI sent through these, and set up states with the last two.
const w = globalThis as unknown as {
  __mockApplied: unknown[]; __mockCommits: unknown[]; __mockCalls: unknown[];
  __mockIdentity: string; __mockMerge: (path?: string) => void; __mockStatusCalls?: number; __mockOpens?: number;
};
w.__mockApplied = []; w.__mockCommits = []; w.__mockCalls = [];
w.__mockIdentity = "Jane Doe <jane@example.com>";
w.__mockMerge = (path = "composer.lock") => {
  merge = `Merge branch 'feature/d11-upgrade-B' into feature/d11-upgrade-C\n\n# Conflicts:\n#\t${path}\n`;
  work = [...work.filter((f) => f.path !== path), { path, old_path: null, index: "U", worktree: "U", kind: "conflicted" }];
};
const wm = globalThis as unknown as { __mockDiffCalls: unknown[]; __mockEditor: unknown[] };
wm.__mockDiffCalls = []; wm.__mockEditor = [];
// 1x1 transparent PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
// The conflicted composer.lock as the Working Directory diff shows it (HEAD -> worktree with markers), so the
// whole-file contents the diff widget reads match its rows.
const LOCK_HEAD = `{\n  "hash": "aaa"\n`;
const LOCK_WORK = `{\n<<<<<<< HEAD\n  "hash": "aaa"\n=======\n  "hash": "bbb"\n>>>>>>> feature/d11-upgrade-B\n`;
// The merge tool's stages: 30 lines, two conflicts (lines 3 and 15), one change only ours (8), only theirs (20),
// the same change on both (25).
const stageText = (side: "base" | "ours" | "theirs") => Array.from({ length: 30 }, (_, k) => {
  const n = k + 1;
  if (n === 3) return side === "base" ? '  "hash": "base",' : side === "ours" ? '  "hash": "aaa",' : '  "hash": "bbb",';
  if (n === 15) return side === "base" ? '  "version": "1.0",' : side === "ours" ? '  "version": "1.1",' : '  "version": "2.0",';
  if (n === 8 && side === "ours") return '  "ours-only": true,';
  if (n === 20 && side === "theirs") return '  "theirs-only": true,';
  if (n === 25 && side !== "base") return '  "both": "same",';
  return n === 1 ? "{" : n === 30 ? "}" : `  "line${n}": ${n},`;
}).join("\n") + "\n";
// Perf harness: `__mockBig = true` (addInitScript) replaces the working copy with 300 modified files of 20-400
// lines (big/f50.php, f150, f250: 5000 lines) and gives every commit the same 300 files. One hunk per file, every
// 10th line changed, so the whole-file contents (ReadFile) match the diff.
const BIG = (globalThis as unknown as { __mockBig?: boolean }).__mockBig === true;
const bigLines = (p: string) => { const i = Number(p.match(/f(\d+)\./)?.[1] ?? 0); return i % 100 === 50 ? 5000 : 20 + ((i * 37) % 381); };
const bigText = (p: string, neu: boolean) => Array.from({ length: bigLines(p) }, (_, k) => (neu && k % 10 === 5 ? `$x${k} = "changed ${k}";` : `$x${k} = ${k}; // ${p}`)).join("\n") + "\n";
function bigDiff(p: string): string {
  const n = bigLines(p);
  const body = Array.from({ length: n }, (_, k) => (k % 10 === 5 ? `-$x${k} = ${k}; // ${p}\n+$x${k} = "changed ${k}";` : ` $x${k} = ${k}; // ${p}`)).join("\n");
  return `diff --git a/${p} b/${p}\nindex 111..222 100644\n--- a/${p}\n+++ b/${p}\n@@ -1,${n} +1,${n} @@\n${body}\n`;
}
const BIG_FILES = Array.from({ length: 300 }, (_, i) => `big/f${i}.php`);
if (BIG) work = BIG_FILES.map((path) => ({ path, old_path: null, index: ".", worktree: "M", kind: "changed" }));
const twoHunks = (p: string) => `diff --git a/${p} b/${p}\nindex 111..222 100644\n--- a/${p}\n+++ b/${p}\n@@ -2,5 +2,5 @@ one\n a\n-old one\n+new one\n b\n c\n d\n@@ -20,4 +20,5 @@ two\n x\n+added line\n y\n z\n-gone\n+kept\n`;

// Console jobs. Tests make a kind of write slow (`__mockSlow.Fetch = 2000`, cancellable meanwhile) or fail
// (`__mockFail.Push = "error: …"`), and read the order jobs started in `__mockJobs`.
const wj = globalThis as unknown as { __mockSlow: Record<string, number>; __mockFail: Record<string, string>; __mockJobs: string[] };
wj.__mockSlow = {}; wj.__mockFail = {}; wj.__mockJobs = [];
const listeners = new Set<(job: number, text: string) => void>();
export function onMockOutput(fn: (job: number, text: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (job: number, text: string) => listeners.forEach((fn) => fn(job, text));
const killers = new Map<number, (e: unknown) => void>();
const PROGRESS: Record<string, [string, string]> = {
  Fetch: ["remote: Counting objects:  50% (1/2)\rremote: Counting objects: 100% (2/2), done.\nReceiving objects:  40% (2/5)\r", "Receiving objects: 100% (5/5), done.\nFrom origin\n   abc1234..def5678  main -> origin/main\n"],
  Pull: ["Receiving objects:  40% (2/5)\r", "Receiving objects: 100% (5/5), done.\nAlready up to date.\n"],
  Push: ["Writing objects:  50% (1/2)\r", "Writing objects: 100% (2/2), done.\nTo origin\n   abc1234..def5678  main -> main\n"],
  Clone: ["Cloning into 'x'...\nReceiving objects:  40% (2/5)\r", "Receiving objects: 100% (5/5), done.\n"],
  ForgeCreate: ["Creating pull request\n", ""],
};

async function mockJob(location: string, job: number, req: Req): Promise<any> {
  const kind = typeof req === "string" ? req : Object.keys(req)[0];
  wj.__mockJobs.push(kind);
  const [first, rest] = PROGRESS[kind] ?? ["", ""];
  if (first) emit(job, first);
  const ms = wj.__mockSlow[kind] ?? 0;
  if (ms) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      killers.set(job, (e) => { clearTimeout(t); reject(e); });
    }).finally(() => killers.delete(job));
  }
  if (wj.__mockFail[kind]) throw wj.__mockFail[kind];
  if (wa.__mockAuth[kind]) {
    // like git through GIT_ASKPASS: username, then password; Cancel makes git give up
    const user = await mockAsk("Username for 'https://example.com': ");
    const pass = user === null ? null : await mockAsk(`Password for 'https://${user}@example.com': `);
    if (pass === null) throw "fatal: could not read Username for 'https://example.com': terminal prompts disabled";
    wa.__mockAuthGot.push({ user, passwordLength: pass.length });
  }
  const before = kind === "Commit" ? head + 1 : head;
  // the cleanup deletes report the refs they removed (local ones are what Undo puts back)
  const removed = typeof req === "string" ? null : "DeleteBranches" in req ? [...req.DeleteBranches.merged, ...req.DeleteBranches.unmerged].map((n) => `refs/heads/${n}`)
    : "DeleteRemoteBranches" in req ? req.DeleteRemoteBranches.branches : null;
  const removedOids = removed?.map((n) => cleanupList.find((b) => b.name === n)?.oid ?? null);
  const r = await mockRpc(location, req);
  if (rest) emit(job, rest);
  const h = (i: number) => ({ branch: `refs/heads/${branch}`, oid: oid(i) });
  if (removed) return { Moved: { head_before: h(head), head_after: h(head), refs: removed.map((name, i) => ({ name, before: removedOids![i], after: null })) } };
  // what a real commit job reports: HEAD and its branch moved (the journal's Undo data)
  if (kind === "InteractiveRebase") {
    return { Moved: { head_before: h(0), head_after: h(head), refs: [{ name: `refs/heads/${branch}`, before: oid(0), after: oid(head) }] } };
  }
  if (kind === "Commit" || kind === "Undo") {
    return { Moved: { head_before: h(before), head_after: h(head), refs: [{ name: `refs/heads/${branch}`, before: oid(before), after: oid(head) }] } };
  }
  return r;
}

// askpass: `__mockAuth.Push = true` makes that kind of job ask for credentials; `__mockAuthGot` records what was
// answered (username, password length only).
const wa = globalThis as unknown as { __mockAuth: Record<string, boolean>; __mockAuthGot: unknown[] };
wa.__mockAuth = {}; wa.__mockAuthGot = [];
const askListeners = new Set<(id: number, prompt: string) => void>();
const askWaiting = new Map<number, (answer: string | null) => void>();
let askSeq = 0;
export function onMockAskpass(fn: (id: number, prompt: string) => void): () => void {
  askListeners.add(fn);
  return () => askListeners.delete(fn);
}
export function answerMockAskpass(id: number, answer: string | null): void {
  askWaiting.get(id)?.(answer);
  askWaiting.delete(id);
}
const mockAsk = (prompt: string) => new Promise<string | null>((resolve) => {
  const id = ++askSeq;
  askWaiting.set(id, resolve);
  askListeners.forEach((fn) => fn(id, prompt));
});
// Pull/merge requests: `__mockRemoteUrls.origin = "https://github.com/o/r.git"` sets a remote's URL,
// `__mockForgeCli = { installed, authenticated }` the CLI the probe reports, `__mockForgeAhead` the ahead count.
const wf = globalThis as unknown as { __mockRemoteUrls: Record<string, string>; __mockForgeCli: { installed: boolean; authenticated: boolean }; __mockForgeAhead?: number | null };
wf.__mockRemoteUrls = {}; wf.__mockForgeCli = { installed: true, authenticated: true };
// Clean Up Branches: made-up candidates (none of them are in `refs`); the deletes remove them, Undo puts local ones back.
const DAY = 86_400, nowS = () => Math.floor(Date.now() / 1000);
type MockCandidate = { name: string; remote: string | null; oid: string; time: number; author: string; subject: string; ahead: number; behind: number; merged: boolean; stale: boolean; gone: boolean };
const cand = (name: string, days: number, r: Partial<MockCandidate>): MockCandidate => ({
  name, remote: name.startsWith("refs/remotes/") ? "origin" : null, oid: oid(2000 + name.length), time: nowS() - days * DAY, author: "Jane Doe",
  subject: `[25505977]: Work on ${name.split("/").pop()}`, ahead: 0, behind: 3, merged: false, stale: days > 90, gone: false, ...r,
});
const CLEANUP: MockCandidate[] = [
  cand("refs/heads/feature/login-form", 5, { merged: true, behind: 12 }),
  cand("refs/heads/fix/typo", 200, { merged: true }),
  cand("refs/heads/spike/graphql", 150, { ahead: 3 }),
  cand("refs/heads/feature/old-api", 20, { gone: true, ahead: 1, author: "Alex Martin" }),
  cand("refs/heads/release/2.0", 300, { merged: true }),
  cand("refs/remotes/origin/feature/login-form", 5, { merged: true }),
  cand("refs/remotes/origin/experiment/cache", 400, { ahead: 2 }),
];
let cleanupList = [...CLEANUP];
const globRe = (p: string) => new RegExp("^" + p.split("*").map((x) => x.replace(/[.+?^$()|[\]{}\\]/g, "\\$&")).join(".*") + "$");
// Undo: `__mockUndoRefuse = "reason"` makes the backend's check (and the undo) refuse
const wu = globalThis as unknown as { __mockUndoRefuse: string };
wu.__mockUndoRefuse = "";

// M8 live updates. The browser has no watcher: repos poll unless a test sets `__mockWatchEvents = true` first
// (addInitScript); `__mockChange(repo, {refs, work, polling})` fires a change, `__mockConnection(location, lost)`
// drops (reason) or restores (null) a location's link (its calls fail meanwhile), `__mockWatched` lists watches.
const wv = globalThis as unknown as {
  __mockWatchEvents?: boolean; __mockWatched: string[]; __mockReinstalled: string[]; __mockCleaned: [string, number][];
  __mockChange: (repo: string, c?: Partial<RepoChange>) => void; __mockConnection: (location: string, lost: string | null) => void;
};
wv.__mockWatched = []; wv.__mockReinstalled = []; wv.__mockCleaned = [];
const changeListeners = new Set<(c: RepoChange) => void>();
const connListeners = new Set<(location: string, lost: string | null) => void>();
const down = new Map<string, string>();
export function onMockChange(fn: (c: RepoChange) => void): () => void { changeListeners.add(fn); return () => changeListeners.delete(fn); }
export function onMockConnection(fn: (location: string, lost: string | null) => void): () => void { connListeners.add(fn); return () => connListeners.delete(fn); }
export async function mockWatch(location: string, repo: string): Promise<string | null> {
  if (down.has(location)) throw `Disconnected, reconnecting… (${down.get(location)})`;
  wv.__mockWatched.push(`${location}|${repo}`);
  return wv.__mockWatchEvents ? null : "browser preview (no file watcher)";
}
wv.__mockChange = (repo, c = {}) => changeListeners.forEach((fn) => fn({ location: "local", repo, refs: false, work: true, polling: null, ...c }));
wv.__mockConnection = (location, lost) => {
  if (lost === null) down.delete(location); else down.set(location, lost);
  connListeners.forEach((fn) => fn(location, lost));
};

// Every request by kind (`__mockReqs.Log`), and `__mockWorkAdd(path)` adds an untracked file (for "changed while hidden").
const wr = globalThis as unknown as { __mockReqs: Record<string, number>; __mockDelay: Record<string, number>; __mockWorkAdd: (path: string) => void };
wr.__mockReqs = {};
wr.__mockDelay = {}; // `__mockDelay.Show = 900`: ms a kind of request takes (default 8, 80 on a remote)
wr.__mockWorkAdd = (path) => { work = [...work, { path, old_path: null, index: ".", worktree: "?", kind: "untracked" }]; };
// Interactive rebase: rows `__mockPushedFrom` and older are on origin; without a start the editor lists the newer ones.
// A start at row 40 or older reaches the merge there and is refused, like core. `__mockRebaseRefuse`: Apply fails so.
const wrb = globalThis as unknown as { __mockPushedFrom: number; __mockRebaseRefuse?: string };
wrb.__mockPushedFrom ??= 3;
function mockRebasePlan(from: string | null) {
  const start = from === null ? wrb.__mockPushedFrom - 1 : index(from);
  if (start < 0) throw "Every commit of this branch is on a remote branch already.";
  if (start >= 40) throw "The commits since then include a merge; rewriting them would flatten it.";
  const commits = Array.from({ length: start + 1 }, (_, k) => {
    const c = commit(start - k);
    return { oid: c.oid, author: c.author, time: c.time, subject: c.subject, message: `${c.subject}\n\nDetails of change ${start - k}.`, published: start - k >= wrb.__mockPushedFrom };
  });
  return { RebasePlan: { base: oid(start + 1), head: oid(head), branch, commits } };
}

// The dashboard: `__mockOverview[path] = { behind: 2 }` changes a repository's answer, a string fails it (an
// error); repositories on hosts named `offline…` do not answer (an ssh error, as when the host is down).
const wo = globalThis as unknown as { __mockOverview: Record<string, Record<string, unknown> | string> };
wo.__mockOverview ??= {};
function mockOverview(location: string, repo: string) {
  const o = wo.__mockOverview[repo];
  if (typeof o === "string") throw o;
  if (location.startsWith("ssh:offline")) throw `ssh: connect to host ${location.slice(4)} port 22: Operation timed out`;
  if (repo.includes("missing")) throw "fatal: not a git repository (or any of the parent directories): .git";
  const h = [...repo].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7); // stable per path
  return { Overview: { branch: "main", upstream: "origin/main", ahead: 0, behind: 0, changed: 0, truncated: false,
    time: Math.floor(Date.now() / 1000) - (h % 864_000), subject: SUBJECTS[h % SUBJECTS.length], ...o } };
}

export async function mockRpc(location: string, req: Req): Promise<any> {
  const kind = typeof req === "string" ? req : Object.keys(req)[0];
  wr.__mockReqs[kind] = (wr.__mockReqs[kind] ?? 0) + 1;
  await new Promise((r) => setTimeout(r, wr.__mockDelay[kind] ?? (location === "local" ? 8 : 80))); // remote feels slower
  if (down.has(location)) throw `Disconnected, reconnecting… (${down.get(location)})`;
  if (req === "Hello") return { Hello: { proto: 1 } };
  if ("Job" in req) return mockJob(location, req.Job.job, req.Job.req);
  if ("Cancel" in req) { killers.get(req.Cancel.job)?.("Cancelled"); return "Done"; }
  if ("Open" in req) {
    const p = req.Open.path;
    w.__mockOpens = (w.__mockOpens ?? 0) + 1;
    if (p.includes("missing")) throw "fatal: not a git repository (or any of the parent directories): .git";
    const root = p.replace(/^~/, "/home/user");
    const lfs_warning = root.includes("lfs") ? "This repository uses Git LFS, but git-lfs is not installed here: LFS files show as pointer files." : null;
    return { Repo: { root, name: root.replace(/\/+$/, "").split("/").pop(), branch, oid: oid(head), ahead: 2, behind: 0, lfs_warning } };
  }
  if ("ScanRepos" in req) {
    w.__mockCalls.push(req);
    const root = req.ScanRepos.root.replace(/^~/, "/home/user").replace(/\/+$/, "");
    if (root.includes("missing")) throw `${root}: No such file or directory`;
    const all = ["demo-repo", "alpha", "clients/beta", "clients/deep/gamma"].filter((p) => p.split("/").length <= req.ScanRepos.depth);
    return { Scan: { paths: all.map((p) => `${root}/${p}`).sort(), truncated: false } };
  }
  if ("Overview" in req) return mockOverview(location, req.Overview.repo);
  if ("RebasePlan" in req) { w.__mockCalls.push(req); return mockRebasePlan(req.RebasePlan.from); }
  if ("Count" in req) { w.__mockCalls.push(req); return { Count: N }; } // hidden refs are recorded, not applied
  if ("Refs" in req) return { Refs: {
    refs: refs.map((r) => ({ ...r, head: r.kind === "branch" && r.name === branch })),
    remotes: [...remotes],
    stashes: [{ name: "stash@{0}", oid: STASH, message: "WIP on feature/d11-upgrade-C: half-done config export" }],
    submodules: [{ path: "vendor/theme", oid: oid(5), initialized: true }],
    worktrees: [
      { path: "/work/demo-repo", branch, oid: oid(0), current: true },
      { path: "/work/demo-repo-hotfix", branch: "main", oid: oid(900), current: false },
    ],
  } };
  if ("Log" in req) {
    const { skip, limit } = req.Log;
    return { Log: Array.from({ length: Math.max(0, Math.min(limit, N - skip)) }, (_, k) => commit(skip + k)) };
  }
  if ("Search" in req) {
    // text filters like core (case-insensitive, all must match); file/content are recorded, not applied
    w.__mockCalls.push(req);
    const { query: q, limit } = req.Search;
    const has = (s: string, t: string) => s.toLowerCase().includes(t.toLowerCase());
    if (q.commit.some((c) => !/^[0-9a-f]+$/i.test(c))) throw `commit: takes a hex hash or prefix, not "${q.commit[0]}"`;
    const rows: number[] = [];
    for (let i = 0; i < N && rows.length <= limit; i++) {
      const c = commit(i);
      const who = (t: string) => has(c.author, t) || has(c.email, t);
      if (q.text.every((t) => has(c.subject, t) || who(t) || c.oid.startsWith(t.toLowerCase())) && q.message.every((t) => has(c.subject, t))
        && q.author.every(who) && q.commit.every((p) => c.oid.startsWith(p.toLowerCase()))) rows.push(i);
    }
    return { Search: { rows: rows.slice(0, limit), truncated: rows.length > limit } };
  }
  if ("Stats" in req) return { Stats: req.Stats.oids.map((o) => [o, 1 + ((index(o) * 13) % 20)]) };
  if ("Graph" in req) return { Graph: { parents: Array.from({ length: N }, (_, i) => parentsOf(i)), tips: [0, 12, 40, 300, 900] } };
  if ("Locate" in req) { const i = index(req.Locate.oid); return { Locate: i < N ? i : null }; }
  if ("Show" in req) {
    if (req.Show.from) w.__mockCalls.push(req);
    const i = index(req.Show.oid), c = commit(i);
    const stash = req.Show.oid === STASH;
    return { Show: { oid: c.oid, tree: "7ree".padEnd(40, "0"), parents: stash ? [oid(0)] : c.parents, author: c.author, email: c.email, time: c.time,
      committer: c.author, commit_time: c.time + (i === 0 ? 3600 : 0), subject: stash ? "WIP on feature/d11-upgrade-C: half-done config export" : c.subject,
      body: "Moves the platform to PHP 8.3 and bumps the CI image.\n\nSee the upgrade notes for the follow-up work.",
      files: BIG ? BIG_FILES.map((path) => ({ path, old_path: null, status: "M", adds: Math.ceil(bigLines(path) / 10), dels: Math.ceil(bigLines(path) / 10) })) : [
        { path: "composer.json", old_path: null, status: "M", adds: 1, dels: 1 },
        { path: ".ddev/config.yaml", old_path: null, status: "M", adds: 1, dels: 1 },
        { path: "web/modules/custom/new_feature.module", old_path: null, status: "A", adds: 24, dels: 0 },
        { path: "docs/renamed.md", old_path: "docs/old-name.md", status: "R", adds: 0, dels: 0 },
        { path: "assets/logo.png", old_path: null, status: "M", adds: null, dels: null },
        { path: "assets/font.woff2", old_path: null, status: "M", adds: null, dels: null },
      ] } };
  }
  if ("Diff" in req) {
    const { path: p, context, ignore_ws } = req.Diff;
    wm.__mockDiffCalls.push({ path: p, context, ignore_ws });
    if (BIG && p.startsWith("big/")) return { Diff: { text: bigDiff(p), truncated: false } };
    if (p.endsWith(".png") || p.endsWith(".woff2")) return { Diff: { text: `Binary files a/${p} and b/${p} differ\n`, truncated: false } };
    if (req.Diff.old_path) return { Diff: { text: "similarity index 100%\nrename from docs/old-name.md\nrename to docs/renamed.md\n", truncated: false } };
    const many = p.includes("new_feature");
    if (many) {
      const body = Array.from({ length: 24 }, (_, k) => `+line ${k + 1} of the new module`).join("\n");
      return { Diff: { text: `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,24 @@\n${body}\n`, truncated: false } };
    }
    const ctx = (n: number, what: string) => Array.from({ length: Math.min(context, n) }, (_, k) => ` ${what}${k}`).join("\n") + (context ? "\n" : "");
    const code = p.endsWith(".php") || p.endsWith(".json");
    const del = code ? '-        "php": "^8.1",' : '-    php: ^8.1';
    const add = code ? '+        "php": "^8.3",' : '+    php: ^8.3';
    return { Diff: { text: `diff --git a/${p} b/${p}\nindex 111..222 100644\n--- a/${p}\n+++ b/${p}\n@@ -12,3 +12,3 @@ "require"\n${ctx(3, "before")}${del}\n${add}\n${ctx(3, "after")}@@ -40,2 +40,2 @@ long\n-short old line\n+${"a very long added line that must stay inside its half of the split view ".repeat(6)}\n${context ? " same tail\n" : ""}`, truncated: false } };
  }
  if ("LineLog" in req) return { Log: Array.from({ length: 3 }, (_, k) => commit(20 + k * 11)) };
  if ("Image" in req) return { Image: { mime: "image/png", base64: PNG, size: 70 } };
  if ("Files" in req) return { Files: ["README.md", "composer.json", "src/Controller/Home.php", "src/index.php", "vendor"] };
  if ("Tree" in req) {
    const p = req.Tree.path;
    if (p === "") return { Tree: [{ name: "src", kind: "tree", size: null }, { name: "vendor", kind: "commit", size: null }, { name: "README.md", kind: "blob", size: 812 }, { name: "composer.json", kind: "blob", size: 2048 }] };
    if (p === "src") return { Tree: [{ name: "Controller", kind: "tree", size: null }, { name: "index.php", kind: "blob", size: 400 }] };
    if (p === "src/Controller") return { Tree: [{ name: "Home.php", kind: "blob", size: 900 }] };
    throw `fatal: path '${p}' does not exist`;
  }
  if ("ReadFile" in req) {
    const { rev, path } = req.ReadFile;
    w.__mockCalls.push(req);
    if (BIG && path.startsWith("big/") && !/^[0-9a-f]{40}$/.test(rev)) { const text = bigText(path, rev === "worktree"); return { Blob: { text, size: text.length, binary: false, truncated: false } }; }
    if (path === "composer.lock" && work.some((f) => f.path === path && f.kind === "conflicted") && (rev === "HEAD" || rev === "worktree")) {
      const text = rev === "HEAD" ? LOCK_HEAD : LOCK_WORK;
      return { Blob: { text, size: text.length, binary: false, truncated: false } };
    }
    if (/\.(png|woff2)$/.test(path)) return { Blob: { text: null, size: rev === "worktree" ? 6002 : rev === "index" || rev === "HEAD" ? 5120 : index(rev) === 0 ? 6002 : 5120, binary: true, truncated: false } };
    // commit diffs here are not built from real files: no contents (the UI then highlights per line)
    if (/^[0-9a-f]{40}$/.test(rev)) throw `mock: no contents for ${path} at ${rev}`;
    if (path.endsWith("new_feature.php")) return { Blob: { text: "<?php\necho 1;\n", size: 14, binary: false, truncated: false } };
    // a 25-line file matching twoHunks (old = HEAD/index, new = worktree)
    const old = Array.from({ length: 25 }, (_, k) => ({ 2: "a", 3: "old one", 4: "b", 5: "c", 6: "d", 20: "x", 21: "y", 22: "z", 23: "gone" } as Record<number, string>)[k + 1] ?? `/* line ${k + 1} */`);
    const neu = [...old.slice(0, 2), "new one", ...old.slice(3, 20), "added line", "y", "z", "kept", ...old.slice(23)];
    const text = (rev === "index" || rev === "HEAD" ? old : neu).join("\n") + "\n";
    return { Blob: { text, size: text.length, binary: false, truncated: false } };
  }
  if ("Blob" in req) {
    if (req.Blob.path.endsWith(".png")) return { Blob: { text: null, size: 5120, binary: true, truncated: false } };
    const text = Array.from({ length: 40 }, (_, k) => `<?php // line ${k + 1} of ${req.Blob.path}`).join("\n") + "\n";
    return { Blob: { text, size: text.length, binary: false, truncated: false } };
  }
  if ("FileLog" in req) return { Log: Array.from({ length: Math.max(0, Math.min(req.FileLog.limit, 130 - req.FileLog.skip)) }, (_, k) => commit((req.FileLog.skip + k) * 7)) };
  if ("Blame" in req) return { Blame: Array.from({ length: 40 }, (_, k) => {
    const c = commit(Math.floor(k / 6) * 9 + 1);
    return { oid: c.oid, author: c.author, time: c.time, text: `<?php // line ${k + 1} of ${req.Blame.path}` };
  }) };
  if ("Status" in req) { w.__mockStatusCalls = (w.__mockStatusCalls ?? 0) + 1; return { Status: { files: structuredClone(work), truncated: false, merge, op, edit } }; }
  if ("WorkDiff" in req) {
    const d = req.WorkDiff;
    wm.__mockDiffCalls.push({ work: true, path: d.path, context: d.context, ignore_ws: d.ignore_ws });
    if (BIG && d.path.startsWith("big/")) return { Diff: { text: bigDiff(d.path), truncated: false } };
    if (d.conflicted) return { Diff: { text: `diff --git a/${d.path} b/${d.path}\nindex 111..222 100644\n--- a/${d.path}\n+++ b/${d.path}\n@@ -1,2 +1,6 @@\n {\n+<<<<<<< HEAD\n   "hash": "aaa"\n+=======\n+  "hash": "bbb"\n+>>>>>>> feature/d11-upgrade-B\n`, truncated: false } };
    if (d.untracked) return { Diff: { text: `diff --git a/${d.path} b/${d.path}\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/${d.path}\n@@ -0,0 +1,2 @@\n+<?php\n+echo 1;\n`, truncated: false } };
    return { Diff: { text: twoHunks(d.path), truncated: false } };
  }
  if ("Stage" in req) { req.Stage.paths.forEach((p) => { const f = work.find((x) => x.path === p); if (f) { f.index = f.kind === "untracked" ? "A" : f.kind === "conflicted" ? "M" : f.worktree; f.worktree = "."; f.kind = "changed"; } }); w.__mockCalls.push(req); return "Done"; }
  if ("Unstage" in req) { req.Unstage.paths.forEach((p) => { const f = work.find((x) => x.path === p); if (f) { f.worktree = f.index === "A" ? "?" : f.index; if (f.index === "A") f.kind = "untracked"; f.index = "."; } }); w.__mockCalls.push(req); return "Done"; }
  if ("Discard" in req) { work = work.filter((f) => !req.Discard.paths.includes(f.path) || f.index !== "."); work.forEach((f) => { if (req.Discard.paths.includes(f.path)) f.worktree = "."; }); w.__mockCalls.push(req); return "Done"; }
  if ("Apply" in req) { w.__mockApplied.push(req.Apply); return "Done"; }
  if ("Commit" in req) {
    if (!req.Commit.amend && !work.some((f) => f.index !== ".")) throw "nothing to commit";
    if (work.some((f) => f.kind === "conflicted")) throw "Committing is not possible because you have unmerged files.";
    w.__mockCommits.push(req.Commit);
    work = work.map((f) => ({ ...f, index: "." })).filter((f) => f.worktree !== ".");
    merge = null;
    return "Done";
  }
  if ("Identity" in req) return { Identity: w.__mockIdentity };
  if ("SetIdentity" in req) { w.__mockCalls.push(req); w.__mockIdentity = `${req.SetIdentity.name} <${req.SetIdentity.email}>`; return "Done"; }
  if ("AbortMerge" in req) { w.__mockCalls.push(req); merge = null; work = work.filter((f) => f.kind !== "conflicted"); return "Done"; }
  if ("Resolve" in req) {
    w.__mockCalls.push(req);
    work.forEach((f) => { if (f.path === req.Resolve.path) Object.assign(f, { index: "M", worktree: ".", kind: "changed" }); });
    return "Done";
  }
  if ("Ignore" in req) { work = work.filter((f) => f.path !== req.Ignore.path); w.__mockCalls.push(req); return "Done"; }
  if ("Stash" in req || "Pull" in req || "Fetch" in req || "Push" in req || "PopStash" in req) { w.__mockCalls.push(req); return "Done"; }
  if ("AddWorktree" in req || "AddSubmodule" in req || "UpdateSubmodules" in req || "SyncSubmodules" in req) { w.__mockCalls.push(req); return "Done"; }
  if ("Checkout" in req) { w.__mockCalls.push(req); branch = req.Checkout.name; return "Done"; }
  // ---- M5a
  const m5 = Object.keys(req)[0];
  if (["CreateBranch", "RenameBranch", "DeleteBranch", "DeleteRemoteBranch", "Merge", "Rebase", "CherryPick", "Revert", "Reset", "CreateTag", "DeleteTag",
    "PushTag", "DeleteRemoteTag", "SetUpstream", "Sequence"].includes(m5)) {
    w.__mockCalls.push(req);
    if (wc.__mockConflict[m5]) conflict(m5);
  }
  if ("CreateBranch" in req) {
    const { name, from, checkout } = req.CreateBranch;
    if (refs.some((r) => r.kind === "branch" && r.name === name)) throw `fatal: a branch named '${name}' already exists`;
    refs.push({ name, kind: "branch", oid: from && /^[0-9a-f]{40}$/.test(from) ? from : oid(0), head: false });
    if (checkout) branch = name;
    return "Done";
  }
  if ("RenameBranch" in req) { const r = refs.find((x) => x.kind === "branch" && x.name === req.RenameBranch.branch); if (r) r.name = req.RenameBranch.name; if (branch === req.RenameBranch.branch) branch = req.RenameBranch.name; return "Done"; }
  if ("DeleteBranch" in req) {
    const { branch: b, force } = req.DeleteBranch;
    if (b === "feature/d11-upgrade-B" && !force) throw `error: the branch '${b}' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D ${b}'`;
    refs = refs.filter((r) => !(r.kind === "branch" && r.name === b));
    return "Done";
  }
  if ("DeleteRemoteBranch" in req) { refs = refs.filter((r) => !(r.kind === "remote" && r.name === short(req.DeleteRemoteBranch.branch))); return "Done"; }
  if ("CreateTag" in req) { refs.push({ name: req.CreateTag.name, kind: "tag", oid: oid(0), head: false }); return "Done"; }
  if ("DeleteTag" in req) { refs = refs.filter((r) => !(r.kind === "tag" && r.name === req.DeleteTag.name)); return "Done"; }
  if ("Sequence" in req) {
    if (!op && merge === null) throw "No rebase, cherry-pick, revert or merge is in progress.";
    op = null; merge = null; edit = null; work = work.filter((f) => f.kind !== "conflicted");
    return "Done";
  }
  if ("CountRange" in req) { w.__mockCalls.push(req); return { Count: 3 }; }
  // ---- M5b
  if ("Undo" in req) {
    const u = req.Undo;
    if (!u.check) w.__mockCalls.push(req);
    if (wu.__mockUndoRefuse) throw wu.__mockUndoRefuse;
    const from = u.redo ? u.moved.head_before : u.moved.head_after;
    if (from.oid !== oid(head)) throw "The repository changed since; it can no longer be undone.";
    if (!u.check) head = index((u.redo ? u.moved.head_after : u.moved.head_before).oid!);
    // undoing a cleanup delete recreates those local branches
    if (!u.check && !u.redo) for (const m of u.moved.refs) {
      const b = CLEANUP.find((x) => x.name === m.name && x.remote === null);
      if (b && m.after === null && !cleanupList.includes(b)) cleanupList.push(b);
    }
    return "Done";
  }
  if ("AddRemote" in req) { w.__mockCalls.push(req); if (remotes.includes(req.AddRemote.name)) throw `error: remote ${req.AddRemote.name} already exists.`; remotes.push(req.AddRemote.name); return "Done"; }
  if ("RenameRemote" in req) { w.__mockCalls.push(req); remotes = remotes.map((r) => (r === req.RenameRemote.name ? req.RenameRemote.new_name : r)); return "Done"; }
  if ("DeleteRemote" in req) { w.__mockCalls.push(req); remotes = remotes.filter((r) => r !== req.DeleteRemote.name); return "Done"; }
  if ("SetRemoteUrl" in req) { w.__mockCalls.push(req); return "Done"; }
  // ---- F8
  if ("StashOp" in req || "ClearStashes" in req) { w.__mockCalls.push(req); return "Done"; }
  if ("RemoteUrl" in req) {
    if (!remotes.includes(req.RemoteUrl.name)) throw `no remote named "${req.RemoteUrl.name}"`;
    return { Text: wf.__mockRemoteUrls[req.RemoteUrl.name] ?? `git@example.com:demo/${req.RemoteUrl.name}.git` };
  }
  // ---- pull/merge requests
  if ("ForgeProbe" in req) {
    const q = req.ForgeProbe;
    w.__mockCalls.push(req);
    const source = q.source ?? branch;
    const up = refs.find((r) => r.kind === "branch" && r.name === source)?.upstream ?? null;
    const cli = q.forge ? { name: q.forge === "github" ? "gh" : "glab", path: wf.__mockForgeCli.installed ? `/opt/homebrew/bin/${q.forge === "github" ? "gh" : "glab"}` : null, ...wf.__mockForgeCli,
      detail: wf.__mockForgeCli.authenticated ? "Logged in" : "You are not logged into any hosts." } : null;
    const commits = source === branch ? [{ subject: "Upgrade core to 11.1", body: "Runs the update hooks.\n\nSee the release notes." }, { subject: "Export config", body: "" }] : [{ subject: "Fix the menu", body: "Closes #12" }];
    return { Forge: { remote_url: wf.__mockRemoteUrls[q.remote] ?? `git@example.com:demo/${q.remote}.git`, default_branch: "main", current_branch: branch, source, upstream: up ? `refs/remotes/${up}` : null,
      ahead: wf.__mockForgeAhead ?? (up ? 2 : null), remote_branches: ["develop", "main", ...(up ? [up.replace(/^[^/]+\//, "")] : [])], commits, cli } };
  }
  if ("ForgeCreate" in req) {
    w.__mockCalls.push(req);
    const r = req.ForgeCreate;
    const url = r.forge === "github" ? `https://${r.host}/${r.project}/pull/42` : `https://${r.host}/${r.project}/-/merge_requests/42`;
    return { Created: { url, output: `${url}\n` } };
  }
  // ---- branch cleanup
  if ("CleanupCandidates" in req) {
    const { stale_days, protected: keep } = req.CleanupCandidates;
    w.__mockCalls.push(req);
    const short = (b: MockCandidate) => b.name.replace(/^refs\/(heads\/|remotes\/origin\/)/, "");
    const branches = cleanupList.map((b) => ({ ...b, stale: stale_days > 0 && b.time < nowS() - stale_days * DAY }))
      .filter((b) => (b.merged || b.stale || b.gone) && !keep.some((p) => globRe(p).test(short(b)))).sort((a, b) => (a.name < b.name ? -1 : 1)); // for-each-ref order
    return { Cleanup: { default_branch: "main", branches, truncated: false } };
  }
  if ("DeleteBranches" in req) {
    w.__mockCalls.push(req);
    const names = [...req.DeleteBranches.merged, ...req.DeleteBranches.unmerged].map((n) => `refs/heads/${n}`);
    cleanupList = cleanupList.filter((b) => !names.includes(b.name));
    return "Done";
  }
  if ("DeleteRemoteBranches" in req) {
    w.__mockCalls.push(req);
    cleanupList = cleanupList.filter((b) => !req.DeleteRemoteBranches.branches.includes(b.name));
    return "Done";
  }
  // ---- M6
  if ("Conflict" in req) {
    const { path } = req.Conflict;
    if (!work.some((f) => f.path === path && f.kind === "conflicted")) throw `${path} has no merge conflict`;
    const bin = /\.(png|woff2)$/.test(path);
    const side = (s: "base" | "ours" | "theirs") => {
      const text = bin ? null : stageText(s);
      return { mode: "100644", blob: { text, size: text?.length ?? 4096, binary: bin, truncated: false } };
    };
    return { Conflict: { base: side("base"), ours: side("ours"), theirs: side("theirs"), merged: { text: bin ? null : LOCK_WORK, size: 10, binary: bin, truncated: false },
      ours_commit: oid(head), theirs_commit: oid(12) } };
  }
  if ("SaveMerge" in req) {
    w.__mockCalls.push(req);
    const { path, stage } = req.SaveMerge;
    if (!work.some((f) => f.path === path && f.kind === "conflicted")) throw `${path} has no merge conflict`;
    if (stage) work.forEach((f) => { if (f.path === path) Object.assign(f, { index: "M", worktree: ".", kind: "changed" }); });
    return "Done";
  }
  if ("Rewrite" in req) {
    w.__mockCalls.push(req);
    const r = req.Rewrite;
    // every listed commit is on origin's branch in the mock (it points at HEAD)
    if (!r.published_ok) throw "PUBLISHED: these commits are on origin/feature/d11-upgrade-C; rewriting them rewrites published history.";
    if (wc.__mockConflict.Rewrite) conflict("Rewrite");
    if (r.action === "edit") { op = "rebase"; edit = r.commits[0]; }
    return "Done";
  }
  if ("InteractiveRebase" in req) {
    w.__mockCalls.push(req);
    const r = req.InteractiveRebase;
    if (!r.published_ok && r.steps.some((st) => index(st.oid) >= wrb.__mockPushedFrom)) throw "PUBLISHED: these commits are on origin/feature/d11-upgrade-C; rewriting them rewrites published history.";
    if (wrb.__mockRebaseRefuse) throw wrb.__mockRebaseRefuse;
    if (wc.__mockConflict.InteractiveRebase) conflict("InteractiveRebase");
    head = 1; // the branch moved (Undo puts it back to row 0)
    return "Done";
  }
  // ---- M7b
  if ("Init" in req) { w.__mockCalls.push(req); return { Text: req.Init.path.replace(/^~/, "/home/user").replace(/\/+$/, "") }; }
  if ("Clone" in req) {
    w.__mockCalls.push(req);
    const { url, parent, name } = req.Clone;
    const n = name || url.replace(/\/+$/, "").replace(/\/\.git$/, "").split(/[/:]/).pop()!.replace(/\.git$/, "");
    return { Text: `${parent.replace(/^~/, "/home/user").replace(/\/+$/, "")}/${n}` };
  }
  if ("GitCustom" in req) { w.__mockCalls.push(req); return "Done"; }
  if (m5 in { Merge: 1, Rebase: 1, CherryPick: 1, Revert: 1, Reset: 1, PushTag: 1, DeleteRemoteTag: 1, SetUpstream: 1 }) return "Done";
  throw "unsupported request";
}

// ---- the optional commit message model, faked for the browser preview and the e2e tests ----
const llmListeners = new Set<(e: DownloadEvent) => void>();
const llmModels: ModelInfo[] = [
  { id: "qwen3.5-2b", name: "Qwen3.5 2B (Q4_K_M)", note: "Recommended: the best messages in the tests, a little slower. Apache-2.0.", bytes: 1_280_835_840, installed: false, downloading: false },
  { id: "qwen2.5-coder-1.5b", name: "Qwen2.5-Coder 1.5B Instruct (Q4_K_M)", note: "Smaller and faster, simpler messages. Apache-2.0.", bytes: 986_048_800, installed: false, downloading: false },
];
let llmTimer: ReturnType<typeof setInterval> | undefined;
let llmId = "";
// every model call, for the e2e tests (`__mockLlmCalls`); `__mockLlmDelay`: ms a search query takes (llmStop cancels it)
const wl = globalThis as unknown as { __mockLlmCalls?: { kind: string; input: unknown }[]; __mockLlmDelay?: number };
let stopRun = () => {};
export const mockLlm = {
  models: async (): Promise<ModelInfo[]> => llmModels.map((m) => ({ ...m })),
  download: async (id: string): Promise<void> => {
    const m = llmModels.find((x) => x.id === id);
    if (!m) throw new Error(`unknown model ${id}`);
    if (llmTimer) throw new Error("another model is still downloading");
    m.downloading = true;
    llmId = id;
    let done = 0;
    const speed = (globalThis as unknown as { __mockLlmSpeed?: number }).__mockLlmSpeed ?? 0.1;
    llmTimer = setInterval(() => {
      done = Math.min(m.bytes, done + m.bytes * speed);
      const finished = done >= m.bytes;
      if (finished) { clearInterval(llmTimer); llmTimer = undefined; m.downloading = false; m.installed = true; }
      llmListeners.forEach((fn) => fn({ id, state: finished ? "done" : "progress", done, total: m.bytes, error: null }));
    }, 100);
  },
  cancel: async (): Promise<void> => {
    if (!llmTimer) return;
    clearInterval(llmTimer); llmTimer = undefined;
    const m = llmModels.find((x) => x.id === llmId)!;
    m.downloading = false;
    llmListeners.forEach((fn) => fn({ id: llmId, state: "cancelled", done: 0, total: m.bytes, error: null }));
  },
  remove: async (id: string): Promise<void> => { const m = llmModels.find((x) => x.id === id); if (m) m.installed = false; },
  generate: async (input: GenInput): Promise<string> => {
    if (!llmModels.some((m) => m.installed)) throw new Error("Download a commit message model first (command palette: Download Commit Message Model).");
    (globalThis as unknown as { __mockLlmInput?: GenInput }).__mockLlmInput = input;
    (wl.__mockLlmCalls ??= []).push({ kind: "generate", input });
    return `feat(mock): change ${input.files.length} file${input.files.length === 1 ? "" : "s"}\n\n- first file: ${input.files[0]?.path ?? "none"}`;
  },
  /** A deterministic stand-in for the model: "by <name>" -> author: (spelled as in recent_authors), the resolved dates
   *  copied, the words after "about"/"touching" as text; "gibberish" answers junk, "explode" fails. */
  searchQuery: async (input: SearchModelInput): Promise<string> => {
    if (!llmModels.some((m) => m.installed)) throw new Error("Download a commit message model first (command palette: Download Commit Message Model).");
    (wl.__mockLlmCalls ??= []).push({ kind: "search", input });
    await new Promise<void>((done, fail) => {
      const t = setTimeout(done, wl.__mockLlmDelay ?? 300);
      stopRun = () => { clearTimeout(t); fail(new Error("cancelled")); };
    });
    const s = input.sentence.toLowerCase();
    if (s.includes("explode")) throw new Error("the model failed: mock failure");
    if (s.includes("gibberish")) return "nope:x after:soon";
    const who = /\bby (\w+)/.exec(s)?.[1];
    const author = who && input.recent_authors.find((a) => a.toLowerCase().includes(who));
    const topic = /\b(?:about|touching) (?:the )?(\w+)/.exec(s)?.[1];
    return [author && `author:"${author}"`, ...input.dates, topic].filter(Boolean).join(" ");
  },
  stop: async (): Promise<void> => { stopRun(); stopRun = () => {}; },
  listen: (fn: (e: DownloadEvent) => void): (() => void) => { llmListeners.add(fn); return () => llmListeners.delete(fn); },
};

// Import from Sublime Merge: `__mockSublimeDir` is the folder found (null: none), `__mockSublimeFiles` its files
// (name -> text). Same rules as config.rs: the macOS keymap first, existing files only replaced with `overwrite`.
const wsm = globalThis as unknown as { __mockSublimeDir?: string | null; __mockSublimeFiles?: Record<string, string> };
const cfgKey = (n: string) => `commitkiwi.cfg.${n}`;
const cfgHas = (n: string | null) => { try { return !!n && localStorage.getItem(cfgKey(n)) !== null; } catch { return false; } };
export const mockSublime = {
  dir: (): string | null => wsm.__mockSublimeDir ?? null,
  run: (dir: string, apply: boolean, overwrite: boolean): ImportItem[] => {
    if (dir !== wsm.__mockSublimeDir) throw new Error(`not a folder: ${dir}`);
    const files = wsm.__mockSublimeFiles ?? {};
    const item = (from: string, to: string): ImportItem => {
      const ours = legacyName(to);
      const exists = cfgHas(to) || cfgHas(ours);
      return { from, to, status: exists ? "replace" : "new", note: !cfgHas(to) && cfgHas(ours) ? `your ${ours} here stops being read` : "" };
    };
    const plan: ImportItem[] = [];
    const keymaps = ["Default (OSX).sublime-keymap", "Default.sublime-keymap"].filter((n) => n in files);
    if (keymaps[0]) plan.push(item(keymaps[0], "keymap.json"));
    for (const k of keymaps.slice(1)) plan.push({ from: k, to: "keymap.json", status: "skipped", note: `${keymaps[0]} was taken; copy entries by hand if you need both` });
    for (const to of ["commands.json", ...Object.keys(MENU_FILES)]) {
      const from = legacyName(to)!;
      if (from in files) plan.push(item(from, to));
    }
    if (!apply) return plan;
    for (const it of plan) {
      if (it.status === "replace" && !overwrite) { it.status = "kept"; continue; }
      if (it.status === "skipped") continue;
      const text = it.to === "keymap.json" ? files[it.from].replaceAll("skyline_text_control", "text_control") : files[it.from];
      localStorage.setItem(cfgKey(it.to), `// Imported from Sublime Merge (${it.from}).\n${text}`);
      it.status = "imported";
    }
    return plan;
  },
};
