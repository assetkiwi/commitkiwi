import { test } from "node:test";
import assert from "node:assert/strict";
import { fillMenu, resolveMenu, type MenuDef, type MenuNode } from "./menu.ts";
import { BRANCH, BRANCH_ON_COMMIT, COMMIT, REMOTE, REMOTE_BRANCH_ON_COMMIT, STASH, TAG, commitFileMenu, joinMenus, remoteTags, workFileMenu } from "./contextMenus.ts";

const captions = (defs: MenuDef[]) => defs.map((d) => d.caption);
const resolved = (defs: MenuDef[], has: (c: string) => boolean = () => true) => resolveMenu(defs, has, () => undefined, false);

test("fillMenu: $vars in captions and args, raw values kept, hidden items and stray separators dropped", () => {
  const defs: MenuDef[] = [
    { caption: "Checkout $branch", command: "checkout_branch", args: { branch: "$ref", label: "on $branch" } },
    { caption: "-" },
    { caption: "Only when hidden", command: "x", visible: "hidden" },
    { caption: "-" },
    { caption: "Revert all", command: "revert_commits", args: { commits: "$commits", n: 3 }, visible: "multi !head" },
    { caption: "Rename…", command: "show_command_palette", args: { command: "rename_branch", args: { branch: "$branch" } } },
    { caption: "-" },
  ];
  const out = fillMenu(defs, { branch: "main", ref: "refs/heads/main", commits: ["a", "b"], multi: true, head: false });
  assert.deepEqual(captions(out), ["Checkout main", "-", "Revert all", "Rename…"]);
  assert.deepEqual(out[0].args, { branch: "refs/heads/main", label: "on main" });
  assert.deepEqual(out[2].args, { commits: ["a", "b"], n: 3 }, "an exact $var keeps its type");
  assert.deepEqual(out[3].args, { command: "rename_branch", args: { branch: "main" } });
  // a value containing `$x` is not filled again, and unknown vars stay as written
  assert.equal(fillMenu([{ caption: "Copy '$branch' $nope", command: "c" }], { branch: "a$ref", ref: "X" })[0].caption, "Copy 'a$ref' $nope");
});

test("branch menu: our order (act, manage, find, visibility); unregistered commands disabled", () => {
  const vars = { branch: "feature/a", ref: "refs/heads/feature/a", head_ref: "hotfix/release", head: false, hidden: false, any_hidden: false, request: "Pull Request" };
  const { nodes, actions } = resolved(fillMenu(BRANCH, vars), (c) => c !== "unset_upstream");
  assert.deepEqual(nodes.map((n) => n.caption), [
    "Check Out feature/a", "Merge feature/a into hotfix/release…", "Rebase hotfix/release onto feature/a", "Create Pull Request from feature/a…", "-",
    "Rename feature/a…", "Set Upstream…", "Unset Upstream", "Delete feature/a", "-",
    "Find Commits on feature/a…", "Copy Branch Name", "-", "Hide feature/a in the Graph", "Show Only feature/a",
  ]);
  assert.equal(nodes.find((n) => n.caption === "Unset Upstream")!.enabled, false);
  const rename = actions[Number(nodes.find((n) => n.caption === "Rename feature/a…")!.id)];
  assert.deepEqual(rename, { command: "show_command_palette", args: { command: "rename_branch", args: { branch: "feature/a" } }, keys: undefined });
  assert.deepEqual(actions[Number(nodes[0].id)].args, { branch: "refs/heads/feature/a" });
  // the request is for this branch (args), never the selection
  assert.deepEqual(actions[Number(nodes[3].id)], { command: "create_pull_request", args: { branch: "feature/a" }, keys: undefined });
  // a hidden branch offers Show instead of Hide, and Show All once anything is hidden
  const hidden = captions(fillMenu(BRANCH, { ...vars, hidden: true, any_hidden: true }));
  assert.ok(hidden.includes("Show feature/a in the Graph") && hidden.includes("Show All Branches") && !hidden.includes("Hide feature/a in the Graph"));
});

test("remote, tag and stash menus", () => {
  assert.deepEqual(captions(fillMenu(REMOTE, { remote: "origin" })), ["Fetch origin", "Copy URL", "Change URL…", "Rename origin…", "-", "Remove origin"]);
  assert.deepEqual(captions(fillMenu(joinMenus(TAG, remoteTags(["origin"])), { tag_name: "1.0.0", ref: "refs/tags/1.0.0" })), [
    "Check Out 1.0.0", "New Branch from 1.0.0…", "Push 1.0.0…", "Copy Tag Name", "-", "Delete 1.0.0", "-", "Delete 1.0.0 on origin",
  ]);
  const del = fillMenu(remoteTags(["origin"]), { tag_name: "1.0.0", ref: "refs/tags/1.0.0" })[0];
  assert.deepEqual(del.args, { ref: "refs/tags/1.0.0", remote: "origin" });
  const s = fillMenu(STASH, { stash: "stash@{2}", oid: "abc" });
  assert.deepEqual(captions(s), ["Apply Stash", "Apply and Drop (Pop)", "-", "Drop Stash"]);
  assert.deepEqual(s[3].args, { stash: "stash@{2}", oid: "abc" });
});

test("commit menu: one commit with its branches; several selected", () => {
  const base = { commit: "8612d99b" + "0".repeat(32), short_commit: "8612d99b", head_ref: "hotfix/release", is_head: true, refs: true, commits: ["x"], multi: false };
  const menu = joinMenus(
    fillMenu(BRANCH_ON_COMMIT, { ...base, branch: "hotfix/release", ref: "refs/heads/hotfix/release", head: true, request: "Pull/Merge Request" }),
    fillMenu(REMOTE_BRANCH_ON_COMMIT, { ...base, branch: "origin/hotfix/release", ref: "refs/remotes/origin/hotfix/release", tracked: true }),
    fillMenu(COMMIT, base),
  );
  const { nodes } = resolved(menu, (c) => !c.startsWith("edit"));
  assert.deepEqual(nodes.map((n) => n.caption), [
    "Check Out hotfix/release", "Create Pull/Merge Request from hotfix/release…", "Rename hotfix/release…", "Set Upstream…", "Unset Upstream", "Delete hotfix/release",
    "Find Commits on hotfix/release…", "Copy Branch Name", "-",
    "Delete origin/hotfix/release", "Copy Branch Name", "-",
    "Check Out This Commit", "New", "-", "Cherry-pick 8612d99b…", "Revert 8612d99b", "Rebase Interactively from Here…", "Rewrite History", "Reset hotfix/release to Here", "-",
    "Copy Commit Hash", "-", "Hide Branches on This Commit", "Show Only Branches on This Commit", "Show All Branches",
  ]);
  const sub = (n: MenuNode[], c: string) => n.find((x) => x.caption === c)!.children!;
  assert.deepEqual(sub(nodes, "New").map((n) => [n.caption, n.enabled]), [["Branch Here…", true], ["Tag Here…", true]]);
  assert.deepEqual(sub(nodes, "Reset hotfix/release to Here").map((n) => n.caption.split(":")[0]), ["Soft", "Mixed (default)", "Keep", "Hard"]);
  assert.equal(sub(nodes, "Rewrite History")[0].enabled, false);
  const rebase = resolved(fillMenu(COMMIT, base));
  assert.deepEqual(rebase.actions[Number(rebase.nodes.find((n) => n.caption === "Rebase Interactively from Here…")!.id)].args, { commit: base.commit });

  const multi = resolved(fillMenu(COMMIT, { ...base, multi: true, is_head: false, refs: false, short_commit: "1f6b60ce", commits: ["a", "b"] }));
  assert.deepEqual(multi.nodes.map((n) => n.caption), [
    "Check Out This Commit", "New", "-", "Cherry-pick Selected Commits", "Revert Selected Commits", "Rewrite History", "Reset hotfix/release to Here", "-",
    "Copy Commit Hash", "-", "Show All Branches",
  ]);
  const revert = multi.actions[Number(multi.nodes[4].id)];
  assert.deepEqual(revert.args, { commits: ["a", "b"] });
});

test("file menus: a commit's file and working directory files by status", () => {
  const [defs, vars] = commitFileMenu({ path: ".ddev/config.yaml", old_path: null, status: "M" }, "c1", null, false);
  assert.deepEqual(captions(fillMenu(defs, { reveal: "Reveal in Finder", ...vars })), [
    "Revert Changes to This File", "Cherry-pick This File", "-", "Open in Editor…", "Reveal in Finder", "Copy File Path", "-", "File History", "Blame",
  ]);
  const history = fillMenu(defs, vars).find((d) => d.caption === "File History")!;
  assert.deepEqual(history.args, { query: 'file:".ddev/config.yaml"' });
  const deleted = captions(fillMenu(...commitFileMenu({ path: "gone", old_path: null, status: "D" }, "c1", null, false)));
  assert.ok(!deleted.includes("Blame") && !deleted.includes("Open in Editor…"));
  const work = (kind: string, index: string, worktree: string, staged = false) => {
    const c = captions(fillMenu(...workFileMenu({ path: "p", kind, index, worktree }, staged)));
    return c.slice(0, c.indexOf("-"));
  };
  assert.deepEqual(work("changed", ".", "M"), ["Stage File", "Discard Changes…"]);
  assert.deepEqual(work("changed", "M", ".", true), ["Unstage File"]);
  assert.deepEqual(work("conflicted", "U", "U"), ["Resolve Conflict", "Take Ours", "Take Theirs", "Stage File (Mark Resolved)"]);
  const untracked = captions(fillMenu(...workFileMenu({ path: "p", kind: "untracked", index: ".", worktree: "?" }, false)));
  assert.ok(!untracked.includes("Blame"), "nothing to blame before it is committed");
  assert.deepEqual(untracked.slice(0, 3), ["Stage File", "Ignore p", "Delete File…"]);
});

test("user menu files: id (or an earlier id) merges into a submenu, others append, junk skipped, reapplying starts over", async () => {
  const { MENU_FILES, applyUserMenus } = await import("./contextMenus.ts");
  const { MAIN_MENU, mergeMenu } = await import("./menu.ts");
  const before = BRANCH.length;
  applyUserMenus({
    "Branch.menu.json": [{ caption: "Prune $branch", command: "git", args: { argv: ["branch", "-d", "$branch"] } }, 5, { caption: "no command" }],
    // "tools" is the View menu's earlier id
    "Main.menu.json": [{ id: "tools", children: [{ caption: "Gc", command: "git", args: { argv: ["gc"] } }] }, { caption: "Extra", children: [{ caption: "Y", command: "y" }] }],
  });
  assert.equal(BRANCH.length, before + 1);
  assert.equal(BRANCH_ON_COMMIT.at(-1)!.caption, "Prune $branch");
  const view = MAIN_MENU.find((m) => m.id === "view")!;
  assert.equal(view.children!.at(-1)!.caption, "Gc");
  assert.equal(MAIN_MENU.at(-1)!.caption, "Extra");
  const filled = fillMenu(BRANCH, { branch: "dev", ref: "refs/heads/dev" }).at(-1)!;
  assert.deepEqual([filled.caption, filled.args], ["Prune dev", { argv: ["branch", "-d", "dev"] }]);
  // a hostile name never becomes an option: the item reports it instead
  assert.match(String(fillMenu(BRANCH, { branch: "--force", ref: "x" }).at(-1)!.args!.refused), /option/);
  applyUserMenus({});
  assert.equal(BRANCH.length, before);
  assert.ok(!MAIN_MENU.find((m) => m.id === "view")!.children!.some((c) => c.caption === "Gc"));
  assert.equal(Object.keys(MENU_FILES).length, 25);
  assert.ok(Object.keys(MENU_FILES).every((n) => n.endsWith(".menu.json")));
  // every earlier id still finds its menu
  for (const [old, now] of [["repository", "branch"], ["navigate", "go"], ["tools", "view"]]) {
    assert.equal(mergeMenu(MAIN_MENU, [{ id: old, children: [{ caption: "Z", command: "z" }] }]).find((m) => m.id === now)!.children!.at(-1)!.caption, "Z", old);
  }
  const commitSub = mergeMenu(COMMIT, [{ id: "create", children: [{ caption: "Z", command: "z" }] }, { id: "edit", children: [{ caption: "E", command: "e" }] }]);
  assert.equal(commitSub.find((m) => m.id === "new")!.children!.at(-1)!.caption, "Z");
  assert.equal(commitSub.find((m) => m.id === "rewrite")!.children!.at(-1)!.caption, "E");
  // replacing fields by id, nested ids
  const m = mergeMenu([{ caption: "A", id: "a", children: [{ caption: "B", id: "b", children: [] }] }], [{ id: "a", caption: "A2", children: [{ id: "b", children: [{ caption: "C", command: "c" }] }] }]);
  assert.deepEqual(m, [{ caption: "A2", id: "a", children: [{ caption: "B", id: "b", children: [{ caption: "C", command: "c" }] }] }]);
});

test("a palette-wrapped git command in a menu gets its argv filled too", () => {
  const [d] = fillMenu([{ caption: "R", command: "show_command_palette", args: { command: "git", args: { argv: ["rebase", "$branch", "$select_commit"] } } }], { branch: "dev" });
  assert.deepEqual(d.args, { command: "git", args: { argv: ["rebase", "dev", "$select_commit"] } });
});
