// Pull/merge requests: which forge a remote URL belongs to, the prefilled title/description, and the browser
// fallback's "new request" URL. Pure and import-free (node-tested).

export type Provider = "github" | "gitlab";
/** `host`: the host name (no port); `path`: `owner/repo` or `group/sub/project`; `webBase`: `https://host[:port]` */
export interface RemoteInfo { host: string; path: string; webBase: string }

/**
 * Parse a git remote URL: https/http (port kept for the web), ssh:// (its port is ssh's, not the web's), git://,
 * scp-like `user@host:group/sub/repo(.git)`. Trailing `.git` and slashes go. Local paths and file:// are null.
 */
export function parseRemote(url: string): RemoteInfo | null {
  const u = url.trim();
  let host = "", port = "", path = "";
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:]+)(?::(\d+))?(\/.*)?$/i.exec(u);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (!["https", "http", "ssh", "git", "git+ssh", "ssh+git"].includes(scheme)) return null;
    [host, path] = [m[2], m[4] ?? ""];
    if (scheme === "https" || scheme === "http") port = m[3] ?? "";
  } else {
    // scp-like: [user@]host:path (no slash before the colon; not a Windows drive letter)
    const s = /^(?:[^@/:]+@)?([^/:]{2,}):(?!\/\/)(.+)$/.exec(u);
    if (!s) return null;
    [host, path] = [s[1], s[2]];
  }
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (!host || !path.includes("/") || path.split("/").some((p) => !p)) return null;
  host = host.toLowerCase();
  return { host, path, webBase: `https://${host}${port ? `:${port}` : ""}` };
}

/** github.com / gitlab.com, a host whose name says it, else the user's answer (`forge_hosts`), else unknown (ask). */
export function providerFor(host: string, forgeHosts: Record<string, string>): Provider | null {
  const h = host.toLowerCase();
  if (h === "github.com" || h.endsWith(".github.com")) return "github";
  if (h === "gitlab.com" || h.endsWith(".gitlab.com")) return "gitlab";
  const saved = forgeHosts[h];
  if (saved === "github" || saved === "gitlab") return saved;
  if (h.includes("gitlab")) return "gitlab";
  if (h.includes("github")) return "github";
  return null;
}

export const requestNoun = (p: Provider | null): string => (p === "github" ? "Pull Request" : p === "gitlab" ? "Merge Request" : "Pull/Merge Request");

/** `feature/PROJ-4-add-login_form` -> `PROJ-4 add login form`: the last path part, separators as spaces, first letter up. */
export function humanise(branch: string): string {
  const last = branch.split("/").filter(Boolean).pop() ?? branch;
  const words = last.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim()
    // keep a ticket id like PROJ-4 together
    .replace(/^([A-Z][A-Z0-9]+) (\d+)\b/, "$1-$2");
  return words ? words[0].toUpperCase() + words.slice(1) : branch;
}

export interface CommitText { subject: string; body: string }
/** One commit: its subject; several: the branch name humanised. `commits` newest first. */
export const suggestTitle = (branch: string, commits: CommitText[]): string => (commits.length === 1 ? commits[0].subject : humanise(branch));
/** One commit: its body; several: a list of subjects (oldest first), each with its body indented under it. */
export function suggestBody(commits: CommitText[]): string {
  if (commits.length === 1) return commits[0].body;
  return [...commits].reverse().map((c) => `- ${c.subject}${c.body ? `\n${c.body.split("\n").map((l) => (l ? `  ${l}` : "")).join("\n")}` : ""}`).join("\n");
}

/** Browsers and servers choke on very long URLs: the body is cut to keep the whole URL under this. */
export const MAX_URL = 6000;
const enc = encodeURIComponent;

/** The provider's prefilled "new request" page; `truncated` when the body was cut to fit `MAX_URL`. */
export function newRequestUrl(provider: Provider, remote: RemoteInfo, source: string, target: string, title: string, body: string): { url: string; truncated: boolean } {
  const base = `${remote.webBase}/${remote.path.split("/").map(enc).join("/")}`;
  const build = (b: string) => (provider === "github"
    ? `${base}/compare/${target.split("/").map(enc).join("/")}...${source.split("/").map(enc).join("/")}?expand=1&title=${enc(title)}&body=${enc(b)}`
    : `${base}/-/merge_requests/new?${[["source_branch", source], ["target_branch", target], ["title", title], ["description", b]]
      .map(([k, v]) => `${enc(`merge_request[${k}]`)}=${enc(v)}`).join("&")}`);
  let url = build(body);
  if (url.length <= MAX_URL) return { url, truncated: false };
  // drop characters from the end until it fits (encoded lengths vary per character)
  const room = MAX_URL - build("").length;
  let used = 0, end = 0;
  for (const ch of body) {
    const n = enc(ch).length;
    if (used + n > room) break;
    used += n;
    end += ch.length;
  }
  url = build(body.slice(0, end));
  return { url, truncated: true };
}

/** Only plain https URLs are opened or copied as links (what a CLI printed is not trusted further than that). */
export function isHttpsUrl(u: string): boolean {
  if (!/^https:\/\/[^\s"'<>\\]+$/.test(u)) return false;
  try { return new URL(u).protocol === "https:"; } catch { return false; }
}

/** `a, b ,,c` -> ["a", "b", "c"] */
export const splitList = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);
/** Reviewer/label/assignee names the backend accepts (it checks again). */
export const badListItem = (list: string[]): string | undefined => list.find((x) => !/^[A-Za-z0-9_.@/][A-Za-z0-9_.@/-]*$/.test(x) || x.length > 100);
