// The optional commit message model: its download (progress, cancel), asking it for a message about the staged
// changes, and turning a sentence into a search query (natural-language search). The model itself lives in the desktop app (crates/llm); here only the facts are collected.
import { api } from "./api";
import { genInput, patchPaths, stagedFiles } from "./commitModel";
import { checkAnswer, resolveDates, searchRequest, topAuthors } from "./nlSearch";
import { app, getPreference, setPreference, type Tab } from "./state.svelte";
import type { DownloadEvent, ModelInfo } from "./types";

export const llm = $state({
  models: [] as ModelInfo[],
  /** the running download */
  progress: null as { id: string; name: string; done: number; total: number } | null,
  /** a message is being written */
  writing: false,
});

export const sizeLabel = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`);

export async function refreshModels(): Promise<void> {
  try { llm.models = await api.llmModels(); } catch (e) { app.notice = String(e); }
}

let started = false;
/** Once, at startup: follow the download events. */
export function startLlm(): void {
  if (started) return;
  started = true;
  void refreshModels();
  void api.onLlmDownload((e: DownloadEvent) => {
    const name = llm.models.find((m) => m.id === e.id)?.name ?? e.id;
    if (e.state === "progress") { llm.progress = { id: e.id, name, done: e.done, total: e.total }; return; }
    llm.progress = null;
    if (e.state === "done") {
      if (!getPreference("commit_model")) setPreference("commit_model", e.id);
      app.notice = `${name} is ready. Use Generate Commit Message in the commit box.`;
    } else if (e.state === "error") app.notice = `Download of ${name} failed: ${e.error}`;
    else app.notice = `Download of ${name} cancelled; starting it again continues where it stopped.`;
    void refreshModels();
  });
}

export async function downloadModel(m: ModelInfo): Promise<void> {
  try {
    await api.llmDownload(m.id);
    llm.progress = { id: m.id, name: m.name, done: 0, total: m.bytes };
    await refreshModels();
  } catch (e) { app.notice = String(e); }
}

export async function deleteModel(m: ModelInfo): Promise<void> {
  try {
    await api.llmDelete(m.id);
    if (getPreference("commit_model") === m.id) setPreference("commit_model", "");
    app.notice = `${m.name} deleted.`;
  } catch (e) { app.notice = String(e); }
  await refreshModels();
}

/** The model's commit message for what is staged in `tab`. Throws a readable error. */
export async function writeCommitMessage(tab: Tab): Promise<string> {
  const status = await api.status(tab.location, tab.path);
  const staged = stagedFiles(status.files);
  if (!staged.length) throw new Error("Stage some changes first; the message describes what is staged.");
  const patches = new Map<string, string>();
  // sequential: a remote agent answers one request at a time anyway
  for (const path of patchPaths(staged)) {
    const f = staged.find((s) => s.path === path)!;
    try { patches.set(path, (await api.workDiff(tab.location, tab.path, path, f.old_path, true, false, false, 2)).text); } catch { /* a file without a patch is still listed */ }
  }
  const recent = (await api.log(tab.location, tab.path, 0, 8, [])).map((c) => c.subject);
  llm.writing = true;
  try {
    const chosen = (getPreference("commit_model") as string) || null;
    return await api.llmGenerate(genInput(tab.info.branch, recent, staged, patches), chosen);
  } finally {
    llm.writing = false;
  }
}

/** Natural-language search: the keyword query for `sentence`, checked by the search parser (`warnings`: what was
 *  left out). The hints are cheap reads: the authors of the latest commits, the top-level paths, local branches. */
export async function interpretSearch(tab: Tab, sentence: string): Promise<{ query: string; warnings: string[] }> {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; // local day
  const [commits, tree] = await Promise.all([
    api.log(tab.location, tab.path, 0, 300, tab.hidden).catch(() => []),
    tab.info.oid ? api.tree(tab.location, tab.path, tab.info.oid, "").catch(() => []) : Promise.resolve([]),
  ]);
  const hints = {
    recent_authors: topAuthors(commits),
    known_paths: tree.slice(0, 20).map((e) => e.name),
    branches: tab.refs.refs.filter((r) => r.kind === "branch").slice(0, 10).map((r) => r.name),
  };
  const answer = await api.llmSearchQuery(searchRequest(sentence, today, hints), (getPreference("commit_model") as string) || null);
  return checkAnswer(answer, sentence, resolveDates(sentence, today));
}
