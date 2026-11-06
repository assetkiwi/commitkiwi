// The recent/quick-switch repository list. Pure and import-free.
export interface Recent { location: string; path: string }
/** Big enough that a bulk add of a projects folder isn't cut off; the switcher ranks it in well under a frame. */
export const RECENT_MAX = 500;

const key = (r: Recent) => `${r.location}|${r.path}`;

/** `r` first (it was just opened), then the rest without it. */
export function touchRecent(list: Recent[], r: Recent): Recent[] {
  return [r, ...list.filter((x) => key(x) !== key(r))].slice(0, RECENT_MAX);
}

/** Append repos that aren't listed yet (bulk add: they were never opened, so they go after the opened ones). */
export function addRecents(list: Recent[], location: string, paths: string[]): Recent[] {
  const seen = new Set(list.map(key));
  const out = [...list];
  for (const path of paths) {
    const r = { location, path };
    if (!seen.has(key(r))) { seen.add(key(r)); out.push(r); }
  }
  return out.slice(0, RECENT_MAX);
}

/** The folder is gone or no longer a repo (git's own wording); an unreachable host or other failure is not. */
export const isGoneError = (e: unknown): boolean => /No such file or directory|not a git repository/i.test(String(e));
