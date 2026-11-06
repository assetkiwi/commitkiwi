// Collecting the facts for the commit message model (crates/llm builds the prompt from them). Pure and import-light
// (node-tested): which staged files, which of them get a patch, line counts.
import type { WorkFile } from "./types";

export interface GenFile { path: string; status: string; adds: number | null; dels: number | null }
export interface GenInput { branch: string | null; recent: string[]; files: GenFile[]; patches: [string, string][] }

/** Patches fetched at most: the model reads a few thousand characters anyway. */
export const MAX_PATCHES = 25;

export const stagedFiles = (files: WorkFile[]): WorkFile[] => files.filter((f) => f.kind === "changed" && f.index !== ".");

/** git's index letter as the model's vocabulary: A added, D deleted, R renamed, everything else modified. */
export const statusLetter = (index: string): string => (index === "A" || index === "C" ? "A" : index === "D" || index === "R" ? index : "M");

/** Files whose patch is not worth a request: lock files, generated and binary-ish assets (the model drops them anyway). */
const NOISE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|go\.sum)$|\.(lock|min\.js|min\.css|map|svg|png|jpe?g|gif|webp|ico|pdf|woff2?|snap)$|(^|\/)(node_modules|vendor|dist|build|target)\//i;

/** Which staged files to ask a patch for: real code first, noise last, at most MAX_PATCHES. */
export function patchPaths(staged: WorkFile[]): string[] {
  const real = staged.filter((f) => !NOISE.test(f.path));
  return real.slice(0, MAX_PATCHES).map((f) => f.path);
}

export function countChanges(patch: string): { adds: number; dels: number } {
  let adds = 0, dels = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) adds++;
    else if (l.startsWith("-") && !l.startsWith("---")) dels++;
  }
  return { adds, dels };
}

/** `patches`: path -> unified diff text, for the paths that could be fetched. */
export function genInput(branch: string | null, recent: string[], staged: WorkFile[], patches: Map<string, string>): GenInput {
  return {
    branch,
    recent,
    files: staged.map((f) => {
      const text = patches.get(f.path);
      const c = text === undefined ? null : countChanges(text);
      return { path: f.path, status: statusLetter(f.index), adds: c?.adds ?? null, dels: c?.dels ?? null };
    }),
    patches: staged.filter((f) => patches.has(f.path)).map((f) => [f.path, patches.get(f.path)!]),
  };
}
