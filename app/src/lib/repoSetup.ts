// New Tab page checks for Clone/New Repository, mirroring core's (which has the final say). Pure and import-free.

/** The folder git would name a clone of `url` (`…/name.git/` -> `name`). */
export function cloneName(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (u.endsWith("/.git")) u = u.slice(0, -5);
  const last = u.split(/[/:]/).pop() ?? "";
  return last.endsWith(".git") ? last.slice(0, -4) : last;
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/** Why `url` cannot be cloned, or "" when it can. */
export function cloneUrlError(url: string): string {
  const u = url.trim();
  if (!u) return "Enter the URL of the repository to clone.";
  if (u.startsWith("-") || CONTROL.test(u) || /^(ext|fd)::/i.test(u)) return "Not a valid repository URL.";
  return "";
}

/** Why `name` is not a usable folder name for the clone, or "". */
export function folderNameError(name: string): string {
  return name === "" || name === "." || name === ".." || name.startsWith("-") || name.includes("/") || CONTROL.test(name)
    ? `Not a valid folder name: ${JSON.stringify(name)}` : "";
}

/** Why `path` is not an absolute folder path (`~` allowed), or "". */
export function folderPathError(path: string): string {
  const p = path.trim();
  return (p === "~" || p.startsWith("/") || p.startsWith("~/")) && !CONTROL.test(p) ? "" : "Enter an absolute folder path (/… or ~/…).";
}
