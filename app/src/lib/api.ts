import { invoke } from "@tauri-apps/api/core";
import type { GenInput } from "./commitModel";
import type { MenuNode } from "./menu";
import type { SearchQuery } from "./search";
import type { SearchModelInput } from "./nlSearch";
import type { Moved, UndoMode } from "./journal";
import type { Cleanup } from "./cleanup";
import type { BlameLine, Blob, Commit, ConflictFile, Detail, ForgeInfo, GraphData, ImageData, Overview, Patch, Refs, RepoChange, RepoInfo, Req, Scan, SearchResult, Status, TreeEntry, DownloadEvent, ModelInfo, RebasePlan } from "./types";

// Outside Tauri (plain browser: UI dev, screenshots, tests) a mock backend answers instead.
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function rpc(location: string, req: Req): Promise<any> {
  if (inTauri) return invoke("rpc", { location, req });
  if (!mockTrace.on) return (await import("./mock")).mockRpc(location, req);
  // the browser preview's stand-in for the backend's request timing trace (total time only)
  const t = performance.now();
  const kind = typeof req === "string" ? req : Object.keys(req)[0];
  const body = typeof req === "string" ? {} : (Object.values(req)[0] as { repo?: string });
  let ok = true;
  try { return await (await import("./mock")).mockRpc(location, req); } catch (e) { ok = false; throw e; } finally {
    const ms = Math.round((performance.now() - t) * 10) / 10;
    mockTrace.last.unshift({ kind, location, repo: body.repo ?? "", wait_ms: 0, call_ms: ms, there_ms: null, total_ms: ms, ok });
    mockTrace.last.length = Math.min(mockTrace.last.length, 100);
  }
}
/** One request in the timing trace (see `request_trace` in main.rs): ms waiting for the connection, for the call
 *  (ssh round trip for a remote), handling where the repo is (the agent's own time), and in total. */
export interface Timing { kind: string; location: string; repo: string; wait_ms: number; call_ms: number; there_ms: number | null; total_ms: number; ok: boolean }
const mockTrace = { on: false, last: [] as Timing[] };

/** One file of an import from Sublime Merge (see config.rs `ImportItem`). */
export interface ImportItem { from: string; to: string; status: "new" | "replace" | "skipped" | "imported" | "kept"; note: string }

/** The older name of a config file (`keymap.json` -> `Default.sublime-keymap`), read while the new one is missing. */
export const legacyName = (name: string): string | null =>
  name === "keymap.json" ? "Default.sublime-keymap" : name === "commands.json" ? "Default.sublime-commands"
    : name.endsWith(".menu.json") ? name.replace(/\.menu\.json$/, ".sublime-menu") : null;

export interface AgentInfo { proto: number; agents: { platform: string; remote_path: string }[] }

/** Browser-preview storage. Keys were `sourcerykiwi.*`, `mergekiwi.*` and `gitmerge.*` before the renames: a missing key is
 *  copied from the old one (which is left in place). shortcut: a key deleted later revives from the old one; drop the fallback after a while. */
const lsGet = (key: string): string | null => {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return v;
    const old = ["sourcerykiwi.", "mergekiwi.", "gitmerge."].map(p => localStorage.getItem(key.replace(/^commitkiwi\./, p))).find(v => v !== null) ?? null;
    if (old !== null) localStorage.setItem(key, old);
    return old;
  } catch { return null; }
};

const PREFS_KEY = "commitkiwi.prefs";
const store = {
  get: (): string | null => lsGet(PREFS_KEY),
  set: (v: string): void => { try { localStorage.setItem(PREFS_KEY, v); } catch { /* private mode */ } },
};

export const api = {
  open: async (loc: string, path: string): Promise<RepoInfo> => (await rpc(loc, { Open: { path } })).Repo,
  refs: async (loc: string, repo: string): Promise<Refs> => (await rpc(loc, { Refs: { repo } })).Refs,
  /** `hidden`: full ref names left out of the commit list (Tab.hidden) */
  count: async (loc: string, repo: string, hidden: string[]): Promise<number> => (await rpc(loc, { Count: { repo, hidden } })).Count,
  log: async (loc: string, repo: string, skip: number, limit: number, hidden: string[]): Promise<Commit[]> =>
    (await rpc(loc, { Log: { repo, skip, limit, hidden } })).Log,
  search: async (loc: string, repo: string, query: SearchQuery, hidden: string[], limit = 1000): Promise<SearchResult> =>
    (await rpc(loc, { Search: { repo, query, hidden, limit } })).Search,
  stats: async (loc: string, repo: string, oids: string[]): Promise<[string, number][]> =>
    (await rpc(loc, { Stats: { repo, oids } })).Stats,

  graph: async (loc: string, repo: string, hidden: string[]): Promise<GraphData> => (await rpc(loc, { Graph: { repo, hidden } })).Graph,
  locate: async (loc: string, repo: string, oid: string, hidden: string[]): Promise<number | null> =>
    (await rpc(loc, { Locate: { repo, oid, hidden } })).Locate,
  /** `from`: diff from that commit's first parent instead (a multi-selection's combined change) */
  show: async (loc: string, repo: string, oid: string, from: string | null = null): Promise<Detail> => (await rpc(loc, { Show: { repo, oid, from } })).Show,
  diff: async (loc: string, repo: string, oid: string, path: string, old_path: string | null, context = 3, ignore_ws = false, from: string | null = null): Promise<Patch> =>
    (await rpc(loc, { Diff: { repo, oid, path, old_path, context, ignore_ws, from } })).Diff,
  lineLog: async (loc: string, repo: string, oid: string, path: string, start: number, end: number, limit = 50): Promise<Commit[]> =>
    (await rpc(loc, { LineLog: { repo, oid, path, start, end, limit } })).Log,
  /** `rev`: a commit id, "HEAD", "index" or "worktree" */
  image: async (loc: string, repo: string, rev: string, path: string): Promise<ImageData> =>
    (await rpc(loc, { Image: { repo, rev, path } })).Image,
  readFile: async (loc: string, repo: string, rev: string, path: string): Promise<Blob> =>
    (await rpc(loc, { ReadFile: { repo, rev, path } })).Blob,
  openEditor: async (template: string, path: string, host: string): Promise<void> => {
    if (inTauri) await invoke("open_editor", { template, path, host });
    else (globalThis as unknown as { __mockEditor?: unknown[] }).__mockEditor?.push({ template, path, host });
  },
  /** The app's version (the browser preview reports the package's). */
  appVersion: async (): Promise<string> => (inTauri ? (await import("@tauri-apps/api/app")).getVersion() : "0.1.0 (browser preview)"),
  /** Open the bundled THIRD-PARTY-LICENSES.md with the system's opener. */
  openLicenses: async (): Promise<void> => {
    if (inTauri) await invoke("open_licenses");
    else (globalThis as unknown as { __mockLicensesOpened?: number }).__mockLicensesOpened = ((globalThis as unknown as { __mockLicensesOpened?: number }).__mockLicensesOpened ?? 0) + 1;
  },
  tree: async (loc: string, repo: string, oid: string, path: string): Promise<TreeEntry[]> =>
    (await rpc(loc, { Tree: { repo, oid, path } })).Tree,
  blob: async (loc: string, repo: string, oid: string, path: string): Promise<Blob> =>
    (await rpc(loc, { Blob: { repo, oid, path } })).Blob,
  files: async (loc: string, repo: string, oid: string): Promise<string[]> => (await rpc(loc, { Files: { repo, oid } })).Files,
  fileLog: async (loc: string, repo: string, oid: string, path: string, skip: number, limit: number): Promise<Commit[]> =>
    (await rpc(loc, { FileLog: { repo, oid, path, skip, limit } })).Log,
  blame: async (loc: string, repo: string, oid: string, path: string): Promise<BlameLine[]> =>
    (await rpc(loc, { Blame: { repo, oid, path } })).Blame,

  status: async (loc: string, repo: string): Promise<Status> => (await rpc(loc, { Status: { repo } })).Status,
  workDiff: async (loc: string, repo: string, path: string, old_path: string | null, staged: boolean, untracked: boolean, conflicted = false, context = 3, ignore_ws = false): Promise<Patch> =>
    (await rpc(loc, { WorkDiff: { repo, path, old_path, staged, untracked, conflicted, context, ignore_ws } })).Diff,
  /** commits on `tip` that are not on `base` (what a hard reset to `base` drops) */
  countRange: async (loc: string, repo: string, base: string, tip: string): Promise<number> =>
    (await rpc(loc, { CountRange: { repo, base, tip } })).Count,
  /** Would Undo (`redo`: Redo) of this entry be allowed now? Resolves, or rejects with the reason. Changes nothing. */
  undoCheck: async (loc: string, repo: string, moved: Moved, redo: boolean, mode: UndoMode): Promise<void> =>
    void (await rpc(loc, { Undo: { repo, moved, redo, mode, check: true } })),
  identity: async (loc: string, repo: string): Promise<string> => (await rpc(loc, { Identity: { repo } })).Identity,
  /** an unmerged file's stages and working-tree file (the merge tool) */
  conflict: async (loc: string, repo: string, path: string): Promise<ConflictFile> => (await rpc(loc, { Conflict: { repo, path } })).Conflict,
  remoteUrl: async (loc: string, repo: string, name: string): Promise<string> => (await rpc(loc, { RemoteUrl: { repo, name } })).Text,
  /** The Create Pull/Merge Request dialog's facts; with `forge` + `host` also the CLI and whether it is logged in. */
  forgeProbe: async (loc: string, repo: string, remote: string, source: string | null, target: string | null, forge: "github" | "gitlab" | null, host: string | null, cli_path: string | null): Promise<ForgeInfo> =>
    (await rpc(loc, { ForgeProbe: { repo, remote, source, target, forge, host, cli_path } })).Forge,
  /** Branches the cleanup assistant offers (merged, stale, upstream gone), with the default branch it compared against. */
  cleanupCandidates: async (loc: string, repo: string, stale_days: number, protectedNames: string[]): Promise<Cleanup> =>
    (await rpc(loc, { CleanupCandidates: { repo, stale_days, protected: protectedNames } })).Cleanup,
  /** The dashboard's look at one repository (branch, ahead/behind, changed files, last commit); never queued. */
  overview: async (loc: string, repo: string): Promise<Overview> => (await rpc(loc, { Overview: { repo } })).Overview,
  /** The interactive rebase editor's commits: `from` and everything after it (null: the unpublished ones). */
  rebasePlan: async (loc: string, repo: string, from: string | null): Promise<RebasePlan> => (await rpc(loc, { RebasePlan: { repo, from } })).RebasePlan,
  scanRepos: async (loc: string, root: string, depth: number): Promise<Scan> => (await rpc(loc, { ScanRepos: { root, depth } })).Scan,
  /** Run a write as console job `id` (only `jobs.svelte.ts` calls this: writes go through its queue). */
  job: (loc: string, id: number, req: Req): Promise<any> => rpc(loc, { Job: { job: id, req } }),
  /** Kill job `id`'s git process (or keep it from starting). */
  cancel: async (loc: string, id: number): Promise<void> => void (await rpc(loc, { Cancel: { job: id } })),
  /** A running job printed something. Returns the unlisten function. */
  onJobOutput: async (fn: (job: number, text: string) => void): Promise<() => void> => {
    if (!inTauri) return (await import("./mock")).onMockOutput(fn);
    return (await import("@tauri-apps/api/event")).listen<{ job: number; text: string }>("job-output", (e) => fn(e.payload.job, e.payload.text));
  },

  /** Watch a repo for changes (file events). Resolves null when events flow, or why it polls instead. */
  watchRepo: async (location: string, repo: string): Promise<string | null> =>
    (inTauri ? invoke<string | null>("watch_repo", { location, repo }) : (await import("./mock")).mockWatch(location, repo)),
  unwatchRepo: async (location: string, repo: string): Promise<void> => {
    if (inTauri) await invoke("unwatch_repo", { location, repo });
  },
  /** A watched repo changed. Returns the unlisten function. */
  onRepoChanged: async (fn: (c: RepoChange) => void): Promise<() => void> => {
    if (!inTauri) return (await import("./mock")).onMockChange(fn);
    return (await import("@tauri-apps/api/event")).listen<RepoChange>("repo-changed", (e) => fn(e.payload));
  },
  /** A remote link dropped (`lost` = why; reconnecting) or came back (`lost` = null). Returns the unlisten function. */
  onConnection: async (fn: (location: string, lost: string | null) => void): Promise<() => void> => {
    if (!inTauri) return (await import("./mock")).onMockConnection(fn);
    return (await import("@tauri-apps/api/event")).listen<{ location: string; lost: string | null }>("connection", (e) => fn(e.payload.location, e.payload.lost));
  },
  /** The request timing trace: turn it on/off (undefined: just ask); resolves with whether it is on. */
  requestTrace: async (on?: boolean): Promise<boolean> => {
    if (inTauri) return invoke<boolean>("request_trace", { on: on ?? null });
    if (on !== undefined) { mockTrace.on = on; if (!on) mockTrace.last = []; }
    return mockTrace.on;
  },
  /** The last 100 traced requests, newest first. */
  requestTimings: async (): Promise<Timing[]> => (inTauri ? invoke<Timing[]>("request_timings") : [...mockTrace.last]),
  /** Upload the agent to `host` again (Preferences > Remote). Resolves with its path there. */
  reinstallAgent: async (host: string): Promise<string> => {
    if (inTauri) return invoke<string>("reinstall_agent", { host });
    (globalThis as unknown as { __mockReinstalled?: string[] }).__mockReinstalled?.push(host);
    return "~/.cache/commitkiwi/agent-0123456789abcdef";
  },
  /** Delete agent builds on `host` unused for `days` days (0: all but the current). Resolves with [files, bytes] removed. */
  cleanupAgents: async (host: string, days: number): Promise<[number, number]> => {
    if (inTauri) return invoke<[number, number]>("cleanup_agents", { host, days });
    (globalThis as unknown as { __mockCleaned?: [string, number][] }).__mockCleaned?.push([host, days]);
    return [days === 0 ? 3 : 2, 4_194_304];
  },

  /** git/ssh need a password, passphrase or confirmation (local repos). Returns the unlisten function. */
  onAskpass: async (fn: (id: number, prompt: string) => void): Promise<() => void> => {
    if (!inTauri) return (await import("./mock")).onMockAskpass(fn);
    return (await import("@tauri-apps/api/event")).listen<{ id: number; prompt: string }>("askpass", (e) => fn(e.payload.id, e.payload.prompt));
  },
  /** Answer prompt `id` (null = Cancel). The answer goes straight to git; it is never stored. */
  askpassAnswer: async (id: number, answer: string | null): Promise<void> => {
    if (inTauri) await invoke("askpass_answer", { id, answer });
    else (await import("./mock")).answerMockAskpass(id, answer);
  },

  /** Contents of a user config file (`keymap.json`); its older name's (`Default.sublime-keymap`) while it does not
   *  exist; "" when neither does. */
  readConfig: async (name: string): Promise<string> => {
    if (inTauri) return invoke<string>("read_config", { name });
    return lsGet(`commitkiwi.cfg.${name}`) ?? lsGet(`commitkiwi.cfg.${legacyName(name)}`) ?? "";
  },
  /** Create the file with commented example content (`example`, else the backend's) if missing; returns its path
   *  (null in the browser). */
  ensureConfig: async (name: string, example?: string): Promise<string | null> => (inTauri ? invoke<string>("ensure_config", { name, example: example ?? null }) : null),
  /** The user's theme files: [file name, text]. */
  listThemes: async (): Promise<[string, string][]> => {
    if (inTauri) return invoke<[string, string][]>("list_themes");
    const out: [string, string][] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!, m = /^commitkiwi\.cfg\.themes\/(.+\.theme\.json)$/.exec(k);
        if (m) out.push([m[1], localStorage.getItem(k) ?? ""]);
      }
    } catch { /* private mode */ }
    return out.sort();
  },
  /** Sublime Merge's user folder on this computer, null when there is none. */
  sublimeUserDir: async (): Promise<string | null> => (inTauri ? invoke<string | null>("sublime_user_dir") : (await import("./mock")).mockSublime.dir()),
  /** Import that folder's key bindings, commands and menus: `apply` false only plans. */
  importSublime: async (dir: string, apply: boolean, overwrite: boolean): Promise<ImportItem[]> =>
    inTauri ? invoke<ImportItem[]>("import_sublime", { dir, apply, overwrite }) : (await import("./mock")).mockSublime.run(dir, apply, overwrite),

  sshHosts: (): Promise<string[]> => (inTauri ? invoke("ssh_hosts") : Promise.resolve(["example-host", "staging"])),
  pickDir: async (): Promise<string | null> => {
    if (!inTauri) return null;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const d = await open({ directory: true });
    return typeof d === "string" ? d : null;
  },
  loadPrefs: async (): Promise<Record<string, any>> => {
    try {
      return JSON.parse((inTauri ? await invoke<string>("load_prefs") : store.get()) ?? "{}") ?? {};
    } catch {
      return {}; // corrupt file: start fresh rather than refuse to launch
    }
  },
  savePrefs: async (json: string): Promise<void> => {
    if (inTauri) await invoke("save_prefs", { json });
    else store.set(json);
  },
  /** Scale the whole interface (UI font size): the webview's page zoom in the app, CSS zoom in a browser. */
  setZoom: async (scale: number): Promise<void> => {
    if (inTauri) await (await import("@tauri-apps/api/webview")).getCurrentWebview().setZoom(scale);
    else document.documentElement.style.zoom = scale === 1 ? "" : String(scale);
  },
  /** Write a user config file (the key bindings editor); same fixed list of names as readConfig. */
  writeConfig: async (name: string, text: string): Promise<void> => {
    if (inTauri) await invoke("write_config", { name, text });
    else try { localStorage.setItem(`commitkiwi.cfg.${name}`, text); } catch { /* private mode */ }
  },
  /** Protocol version and the agent each remote platform gets (desktop app only). */
  agentInfo: async (): Promise<AgentInfo> => (inTauri ? invoke<AgentInfo>("agent_info")
    : { proto: 0, agents: [{ platform: "linux-x86_64", remote_path: "~/.cache/commitkiwi/agent-0123456789abcdef" }] }),
  /** Repositories from the command line (`commitkiwi a b`, this launch or a later one) not taken yet, and problems. */
  cliTake: async (): Promise<{ open: string[]; errors: string[] }> => (inTauri ? invoke("cli_take") : { open: [], errors: [] }),
  /** A later `commitkiwi …` forwarded paths: call cliTake. Returns the unlisten function. */
  // The optional commit message model (runs in the desktop app only; the browser preview fakes it)
  llmModels: async (): Promise<ModelInfo[]> => (inTauri ? invoke<ModelInfo[]>("llm_models") : (await import("./mock")).mockLlm.models()),
  llmDownload: async (id: string): Promise<void> => (inTauri ? invoke("llm_download", { id }) : (await import("./mock")).mockLlm.download(id)),
  llmCancel: async (): Promise<void> => (inTauri ? invoke("llm_cancel") : (await import("./mock")).mockLlm.cancel()),
  llmStop: async (): Promise<void> => (inTauri ? invoke("llm_stop") : (await import("./mock")).mockLlm.stop()),
  llmDelete: async (id: string): Promise<void> => (inTauri ? invoke("llm_delete", { id }) : (await import("./mock")).mockLlm.remove(id)),
  llmGenerate: async (input: GenInput, model: string | null): Promise<string> =>
    inTauri ? invoke<string>("llm_generate", { input, model }) : (await import("./mock")).mockLlm.generate(input),
  /** Natural-language search: the model's keyword query for `input.sentence` (unchecked: see nlSearch.checkAnswer). */
  llmSearchQuery: async (input: SearchModelInput, model: string | null): Promise<string> =>
    inTauri ? invoke<string>("llm_search_query", { input, model }) : (await import("./mock")).mockLlm.searchQuery(input),
  onLlmDownload: async (fn: (e: DownloadEvent) => void): Promise<() => void> =>
    inTauri ? (await import("@tauri-apps/api/event")).listen<DownloadEvent>("llm-download", (e) => fn(e.payload)) : (await import("./mock")).mockLlm.listen(fn),
  onCliOpen: async (fn: () => void): Promise<() => void> => (inTauri ? (await import("@tauri-apps/api/event")).listen("cli-open", () => fn()) : () => {}),
  /** Install Command Line Tool: link `commitkiwi` to this app. `replace` set: the path holds something else (where it points). */
  installCli: async (replace: boolean): Promise<{ path: string; replace: string | null; note: string }> => {
    if (inTauri) return invoke("install_cli", { replace });
    const g = globalThis as unknown as { __mockCliExisting?: string; __mockCliInstalls?: boolean[] };
    if (g.__mockCliExisting && !replace) return { path: "/usr/local/bin/commitkiwi", replace: g.__mockCliExisting, note: "" };
    g.__mockCliInstalls?.push(replace);
    return { path: "/usr/local/bin/commitkiwi", replace: null, note: "" };
  },
  /** Remove the `commitkiwi` link if it points at this app; resolves with what happened. */
  uninstallCli: async (): Promise<string> => (inTauri ? invoke<string>("uninstall_cli") : "Removed /usr/local/bin/commitkiwi."),
  /** Replace the native menu bar (desktop app only). */
  setMenu: (menus: MenuNode[]): Promise<void> => invoke("set_menu", { menus }),
  /** A native menu item was chosen: its id. Returns the unlisten function. */
  onMenu: async (fn: (id: string) => void): Promise<() => void> =>
    (await import("@tauri-apps/api/event")).listen<string>("menu", (e) => fn(e.payload)),
};
