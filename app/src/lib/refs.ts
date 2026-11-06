// Locations sidebar helpers. Pure and import-free (node-tested).

/** Full ref name as git (and Req.hidden) knows it. */
export function fullRef(kind: "branch" | "remote" | "tag", name: string): string {
  return `${kind === "branch" ? "refs/heads/" : kind === "remote" ? "refs/remotes/" : "refs/tags/"}${name}`;
}

export interface RefNode<T> {
  /** last path segment (folder or ref) */
  label: string;
  /** folder path, or the ref's own name */
  path: string;
  item?: T;
  children: RefNode<T>[];
}

/** `a/b/c` names become folders `a` > `b` > leaf `c`; order is kept (git lists refs sorted). */
export function refTree<T extends { name: string }>(items: T[]): RefNode<T>[] {
  const root: RefNode<T> = { label: "", path: "", children: [] };
  const folders = new Map<string, RefNode<T>>([["", root]]);
  for (const item of items) {
    const parts = item.name.split("/");
    let parent = root;
    for (let k = 0; k < parts.length - 1; k++) {
      const path = parts.slice(0, k + 1).join("/");
      let f = folders.get(path);
      if (!f) { f = { label: parts[k], path, children: [] }; folders.set(path, f); parent.children.push(f); }
      parent = f;
    }
    parent.children.push({ label: parts[parts.length - 1], path: item.name, item, children: [] });
  }
  return root.children;
}

/** Case-insensitive substring filter on the name (the Locations filter box). */
export const filterByName = <T extends { name: string }>(items: T[], q: string): T[] => {
  const s = q.trim().toLowerCase();
  return s ? items.filter((i) => i.name.toLowerCase().includes(s)) : items;
};
