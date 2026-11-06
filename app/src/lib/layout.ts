// Sidebar columns for the `side_bar_layout` setting. Pure and import-free (node-tested).
export type Side = "locations" | "commits" | "files";

/** Columns left of the details pane, left to right; a column with several entries is tabbed. A closed side bar has none. */
export function sideColumns(layout: string, open: boolean): Side[][] {
  if (!open) return [];
  const loc: Side[] = ["locations"];
  const own = (c: Side[]) => (c.length ? [c] : []);
  switch (layout) {
    case "tabs": return [[...loc, "commits", "files"]];
    case "commit_graph_as_column": return [[...loc, "files"], ["commits"]];
    case "columns": return [...own(loc), ["commits"], ["files"]];
    default: return [...own(loc), ["commits", "files"]]; // locations_as_column
  }
}

/** The tab a tabbed column shows: the wanted one if it has it, else Commits, else its first. */
export const visibleSide = (col: Side[], wanted: Side): Side => (col.includes(wanted) ? wanted : col.includes("commits") ? "commits" : col[0]);
