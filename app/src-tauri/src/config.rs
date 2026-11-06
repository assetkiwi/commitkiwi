//! The user's config folder: a fixed list of JSON-with-comments files (key bindings, palette commands, menu
//! additions, settings), theme files in `themes/`, older file names still read, and the Sublime Merge importer.
//! Everything here takes the folder as a path, so tests run on temp dirs.
use std::path::{Path, PathBuf};

/// The menus a user file can add to: `<name>.menu.json` (lib/contextMenus.ts `MENU_FILES`).
const MENUS: [&str; 25] = [
    "Main", "Action", "Branch", "Branch Folder", "Branch Section", "Commit", "Commit File", "File", "Hunk",
    "Image Context", "Index File", "Modified File", "Untracked File", "Unmerged File", "Remote", "Remote Section",
    "Remote Branch", "Remote Branch Folder", "Stash", "Stash Section", "Submodule", "Submodule Section", "Tag",
    "Tag Section", "Tab Context",
];

/// Every file the UI may read or write, by name. A fixed list: the UI can never name an arbitrary path.
pub fn config_files() -> Vec<String> {
    ["keymap.json", "commands.json", "settings.json"].into_iter().map(String::from)
        .chain(MENUS.iter().map(|m| format!("{m}.menu.json")))
        .collect()
}

/// The name an older build used for this file (read while the new one does not exist).
pub fn legacy_name(name: &str) -> Option<String> {
    match name {
        "keymap.json" => Some("Default.sublime-keymap".into()),
        "commands.json" => Some("Default.sublime-commands".into()),
        _ => name.strip_suffix(".menu.json").filter(|m| MENUS.contains(m)).map(|m| format!("{m}.sublime-menu")),
    }
}

/// Every file name migration copies from an older config folder: current names and the older ones.
pub fn all_names() -> Vec<String> {
    let files = config_files();
    let legacy: Vec<String> = files.iter().filter_map(|n| legacy_name(n)).collect();
    files.into_iter().chain(legacy).collect()
}

pub fn config_file(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if config_files().iter().any(|n| n == name) { Ok(dir.join(name)) } else { Err(format!("unknown config file {name:?}")) }
}

/// The file's text, else its older name's, else "".
pub fn read(dir: &Path, name: &str) -> Result<String, String> {
    let path = config_file(dir, name)?;
    for p in std::iter::once(path).chain(legacy_name(name).map(|l| dir.join(l))) {
        match std::fs::read_to_string(&p) {
            Ok(s) => return Ok(s),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("{}: {e}", p.display())),
        }
    }
    Ok(String::new())
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, path)).map_err(|e| e.to_string())
}

pub fn write(dir: &Path, name: &str, text: &str) -> Result<(), String> {
    let path = config_file(dir, name)?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    write_atomic(&path, text)
}

/// Create the file when missing and return its path. An older file of the same purpose is copied (so its entries
/// stay in effect), else `example` (the UI's, for settings.json) or our commented template. Also creates the
/// themes folder with an example theme when that folder is missing. Never overwrites.
pub fn ensure(dir: &Path, name: &str, example: Option<&str>) -> Result<PathBuf, String> {
    let path = config_file(dir, name)?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    if !path.exists() {
        let old = legacy_name(name).and_then(|l| std::fs::read_to_string(dir.join(&l)).ok().map(|t| (l, t)));
        let text = match old {
            Some((l, t)) => format!("// Copied from {l} (still on disk, no longer read once this file exists).\n{t}"),
            None => example.map(String::from).unwrap_or_else(|| template(name).into()),
        };
        write_atomic(&path, &text)?;
    }
    let themes = dir.join("themes");
    if !themes.exists() {
        std::fs::create_dir_all(&themes).map_err(|e| e.to_string())?;
        std::fs::write(themes.join("example.theme.json"), EXAMPLE_THEME).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

pub const EXAMPLE_THEME: &str = r##"// An example theme. Copy this file to another `<name>.theme.json` in this folder and change it; it then shows up
// in Select Theme (edits apply when the window gets focus). A broken file is reported and ignored.
// "kind": "light" or "dark" (the base look), "extends": a theme to start from ("Light", "Dark", "Kiwi Light",
// "Kiwi Dark" or one of yours), "variables": the CSS values to change. Every variable is listed in
// docs/CONFIGURATION.md.
{
	"name": "Example (Kiwi Dark, warmer)",
	"kind": "dark",
	"extends": "Kiwi Dark",
	"variables": {
		"--accent": "#fbbf24",
		"--accent-text": "#fcd34d",
		"--lane0": "#fbbf24",
	},
}
"##;

pub fn template(name: &str) -> &'static str {
    match name {
        "keymap.json" => "[\n\t// Your key bindings, on top of the preset chosen in Preferences > Key Bindings (later entries win).\n\t// \"keys\": one chord or two (\"super+k\", \"super+b\"); \"context\" limits where a binding works.\n\t// { \"keys\": [\"super+shift+x\"], \"command\": \"toggle_theme\" },\n\t// { \"keys\": [\"super+alt+g\"], \"command\": \"git\", \"args\": { \"argv\": [\"gc\"] } },\n\t// Remove a default binding by binding its keys to \"noop\":\n\t// { \"keys\": [\"f5\"], \"command\": \"noop\" },\n]\n",
        "commands.json" => "[\n\t// Extra command palette entries. `git` runs a git command (no shell) in the open repository; $working_dir,\n\t// $git_dir, $commit, $short_commit, $head, $head_ref are filled in, and $select_branch, $select_local_branch,\n\t// $select_remote_branch, $select_ref, $select_tag, $select_commit, $select_stash, $text ask for a value first.\n\t// Text after a tab in the caption is shown on the right. For example:\n\t// { \"caption\": \"Repository: Clean Up\\tgit gc\", \"command\": \"git\", \"args\": { \"argv\": [\"gc\"] } },\n\t// { \"caption\": \"Branch: Interactive Rebase…\", \"command\": \"git\", \"args\": { \"argv\": [\"rebase\", \"-i\", \"$select_branch\"] } },\n]\n",
        "settings.json" => "{\n\t// Preferences set here win over the Preferences window (which then shows them read-only).\n\t// Use the names from preferences.json, e.g. \"theme\": \"kiwi-dark\".\n}\n",
        _ => "[\n\t// Items added to this menu. An item with the \"id\" of an existing submenu adds its \"children\" there; others are\n\t// appended. The menu's $variables ($branch, $path, $commit, ...) work in captions and args. For example:\n\t// { \"caption\": \"Show in Log\", \"command\": \"git\", \"args\": { \"argv\": [\"log\", \"-1\", \"$commit\"] } },\n\t// In Main.menu.json, add to the View menu:\n\t// { \"id\": \"view\", \"children\": [{ \"caption\": \"Garbage Collect\", \"command\": \"git\", \"args\": { \"argv\": [\"gc\"] } }] },\n]\n",
    }
}

const MAX_THEME_BYTES: u64 = 256 * 1024;

/// `<dir>/themes/*.theme.json`: (file name, text) for each regular file (no symlinks), sorted, at most 100.
pub fn list_themes(dir: &Path) -> Vec<(String, String)> {
    let Ok(rd) = std::fs::read_dir(dir.join("themes")) else { return Vec::new() };
    let mut out: Vec<(String, String)> = rd.flatten().filter_map(|e| {
        let name = e.file_name().into_string().ok()?;
        let meta = std::fs::symlink_metadata(e.path()).ok()?;
        if !name.ends_with(".theme.json") || name.starts_with('.') || !meta.is_file() || meta.len() > MAX_THEME_BYTES { return None; }
        Some((name, std::fs::read_to_string(e.path()).ok()?))
    }).collect();
    out.sort();
    out.truncate(100);
    out
}

/// Sublime Merge's user folder on this computer, if there is one (only ever read, never written).
pub fn sublime_user_dir(home: &Path) -> Option<PathBuf> {
    let dir = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Sublime Merge/Packages/User")
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".config")).join("sublime-merge/Packages/User")
    };
    dir.is_dir().then_some(dir)
}

/// One file of an import: where from, where to, and what happens (`new`, `replace`, `keep`; after applying
/// `imported`, `kept`; `skipped` with a note when another file of the same purpose was taken).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ImportItem {
    pub from: String,
    pub to: String,
    pub status: String,
    pub note: String,
}

const IMPORT_MAX_BYTES: u64 = 1024 * 1024;
const PLATFORM_KEYMAP: &str = if cfg!(target_os = "macos") {
    "Default (OSX).sublime-keymap"
} else if cfg!(windows) {
    "Default (Windows).sublime-keymap"
} else {
    "Default (Linux).sublime-keymap"
};

/// A regular file (not a symlink, so nothing outside `src` is read), small enough.
fn importable(src: &Path, name: &str) -> bool {
    std::fs::symlink_metadata(src.join(name)).is_ok_and(|m| m.is_file() && m.len() <= IMPORT_MAX_BYTES)
}

/// What importing from `src` (Sublime Merge's user folder) into `dst` (ours) would do; nothing is written. Only the
/// known file names directly in `src` are looked at. An existing target, or an older file of ours with the same
/// purpose, makes the item `replace` (asked first).
pub fn import_plan(src: &Path, dst: &Path) -> Vec<ImportItem> {
    let item = |from: &str, to: &str| {
        let ours = legacy_name(to).filter(|l| dst.join(l).exists());
        let exists = dst.join(to).exists() || ours.is_some();
        let note = if dst.join(to).exists() { String::new() } else { ours.map(|l| format!("your {l} here stops being read")).unwrap_or_default() };
        ImportItem { from: from.into(), to: to.into(), status: if exists { "replace" } else { "new" }.into(), note }
    };
    let mut out = Vec::new();
    let keymaps: Vec<&str> = [PLATFORM_KEYMAP, "Default.sublime-keymap"].into_iter().filter(|n| importable(src, n)).collect();
    if let Some(first) = keymaps.first() {
        out.push(item(first, "keymap.json"));
        for other in &keymaps[1..] {
            out.push(ImportItem { from: (*other).into(), to: "keymap.json".into(), status: "skipped".into(), note: format!("{first} was taken; copy entries by hand if you need both") });
        }
    }
    for to in config_files().iter().filter(|n| n.as_str() != "keymap.json" && n.as_str() != "settings.json") {
        if let Some(from) = legacy_name(to).filter(|f| importable(src, f)) {
            out.push(item(&from, to));
        }
    }
    out
}

/// Run the plan: `new` items are written; `replace` items only with `overwrite` (else `kept`). The text is copied
/// as is (same schema) after a comment naming its source; key bindings get our name for the text-field context.
pub fn import_apply(src: &Path, dst: &Path, overwrite: bool) -> Result<Vec<ImportItem>, String> {
    let mut plan = import_plan(src, dst);
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for it in plan.iter_mut() {
        let go = it.status == "new" || (it.status == "replace" && overwrite);
        if it.status == "replace" && !overwrite { it.status = "kept".into(); }
        if !go { continue; }
        let mut text = std::fs::read_to_string(src.join(&it.from)).map_err(|e| format!("{}: {e}", it.from))?;
        if it.to == "keymap.json" { text = text.replace("skyline_text_control", "text_control"); }
        write_atomic(&dst.join(&it.to), &format!("// Imported from Sublime Merge ({}).\n{text}", it.from))?;
        it.status = "imported".into();
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_legacy_fallback() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        assert_eq!(config_files().len(), 28);
        assert_eq!(legacy_name("Branch Folder.menu.json").as_deref(), Some("Branch Folder.sublime-menu"));
        assert_eq!(legacy_name("settings.json"), None);
        assert_eq!(legacy_name("Nope.menu.json"), None);
        for bad in ["../etc/passwd", "/etc/passwd", "Default.sublime-keymap", "keymap.json/../x", "themes/x.theme.json", ""] {
            assert!(config_file(dir, bad).is_err(), "{bad:?}");
        }
        assert_eq!(read(dir, "keymap.json").unwrap(), "");
        std::fs::write(dir.join("Default.sublime-keymap"), "[old]").unwrap();
        assert_eq!(read(dir, "keymap.json").unwrap(), "[old]", "older name read while the new one is missing");
        std::fs::write(dir.join("keymap.json"), "[new]").unwrap();
        assert_eq!(read(dir, "keymap.json").unwrap(), "[new]", "the new name wins");
        // every template is JSON with comments of the right shape
        for name in config_files() {
            let t = template(&name);
            let shape = if name == "settings.json" { ('{', '}') } else { ('[', ']') };
            assert!(t.starts_with(shape.0) && t.trim_end().ends_with(shape.1) && t.contains("//"), "{name}");
        }
    }

    #[test]
    fn ensure_copies_older_files_writes_examples_and_never_overwrites() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("cfg");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Default.sublime-commands"), "[{\"caption\":\"X\",\"command\":\"x\"}]").unwrap();
        let p = ensure(&dir, "commands.json", None).unwrap();
        let t = std::fs::read_to_string(&p).unwrap();
        assert!(t.starts_with("// Copied from Default.sublime-commands") && t.ends_with("[{\"caption\":\"X\",\"command\":\"x\"}]"));
        assert!(dir.join("Default.sublime-commands").exists(), "the older file stays");
        ensure(&dir, "settings.json", Some("{ // all options\n}")).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("settings.json")).unwrap(), "{ // all options\n}");
        ensure(&dir, "keymap.json", None).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("keymap.json")).unwrap(), template("keymap.json"));
        // themes: an example once, only when the folder is missing
        assert_eq!(std::fs::read_to_string(dir.join("themes/example.theme.json")).unwrap(), EXAMPLE_THEME);
        std::fs::remove_file(dir.join("themes/example.theme.json")).unwrap();
        std::fs::write(dir.join("settings.json"), "{\"theme\":\"dark\"}").unwrap();
        ensure(&dir, "settings.json", Some("{}")).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("settings.json")).unwrap(), "{\"theme\":\"dark\"}", "never overwritten");
        assert!(!dir.join("themes/example.theme.json").exists(), "a deleted example is not recreated");
        assert!(ensure(&dir, "../x.json", None).is_err());
    }

    #[test]
    fn themes_are_listed_from_regular_files_only() {
        let d = tempfile::tempdir().unwrap();
        assert!(list_themes(d.path()).is_empty(), "no folder");
        let t = d.path().join("themes");
        std::fs::create_dir_all(&t).unwrap();
        std::fs::write(t.join("b.theme.json"), "{b}").unwrap();
        std::fs::write(t.join("a.theme.json"), "{a}").unwrap();
        std::fs::write(t.join("notes.txt"), "x").unwrap();
        std::fs::create_dir_all(t.join("dir.theme.json")).unwrap();
        let outside = d.path().join("secret");
        std::fs::write(&outside, "secret").unwrap();
        std::os::unix::fs::symlink(&outside, t.join("link.theme.json")).unwrap();
        assert_eq!(list_themes(d.path()), [("a.theme.json".to_string(), "{a}".to_string()), ("b.theme.json".into(), "{b}".into())]);
    }

    #[test]
    fn import_from_a_sublime_user_folder() {
        let d = tempfile::tempdir().unwrap();
        let (src, dst) = (d.path().join("User"), d.path().join("ours"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join(PLATFORM_KEYMAP), r#"[{ "keys": ["escape"], "command": "x", "context": [{ "key": "control", "operand": "skyline_text_control filter_input files_filter" }] }]"#).unwrap();
        std::fs::write(src.join("Default.sublime-keymap"), "[]").unwrap();
        std::fs::write(src.join("Default.sublime-commands"), "[cmds]").unwrap();
        std::fs::write(src.join("Branch.sublime-menu"), "[menu]").unwrap();
        std::fs::write(src.join("Preferences.sublime-settings"), "{}").unwrap();
        std::fs::write(src.join("Unknown.sublime-menu"), "[]").unwrap();
        let outside = d.path().join("outside.sublime-menu");
        std::fs::write(&outside, "[secret]").unwrap();
        std::os::unix::fs::symlink(&outside, src.join("Commit.sublime-menu")).unwrap();
        // ours already has commands.json, and an older keymap of our own
        std::fs::write(dst.join("commands.json"), "[mine]").unwrap();
        std::fs::write(dst.join("Default.sublime-keymap"), "[my old keys]").unwrap();

        let plan = import_plan(&src, &dst);
        let row = |p: &[ImportItem], from: &str| p.iter().find(|i| i.from == from).cloned().unwrap();
        assert_eq!(plan.len(), 4, "{plan:?}");
        assert_eq!(row(&plan, PLATFORM_KEYMAP).status, "replace");
        assert!(row(&plan, PLATFORM_KEYMAP).note.contains("Default.sublime-keymap"));
        assert_eq!(row(&plan, "Default.sublime-keymap").status, "skipped");
        assert_eq!(row(&plan, "Default.sublime-commands").status, "replace");
        assert_eq!((row(&plan, "Branch.sublime-menu").to.as_str(), row(&plan, "Branch.sublime-menu").status.as_str()), ("Branch.menu.json", "new"));
        assert!(!dst.join("Branch.menu.json").exists(), "a plan writes nothing");

        // without overwrite: new files only; existing ones kept
        let done = import_apply(&src, &dst, false).unwrap();
        assert_eq!(row(&done, "Branch.sublime-menu").status, "imported");
        assert_eq!(row(&done, "Default.sublime-commands").status, "kept");
        assert_eq!(std::fs::read_to_string(dst.join("commands.json")).unwrap(), "[mine]");
        assert!(!dst.join("keymap.json").exists());
        assert_eq!(std::fs::read_to_string(dst.join("Branch.menu.json")).unwrap(), "// Imported from Sublime Merge (Branch.sublime-menu).\n[menu]");
        assert!(!dst.join("Commit.menu.json").exists(), "a symlink is never followed");
        // with overwrite: replaced, and the keymap's context renamed
        import_apply(&src, &dst, true).unwrap();
        assert_eq!(std::fs::read_to_string(dst.join("commands.json")).unwrap(), "// Imported from Sublime Merge (Default.sublime-commands).\n[cmds]");
        let km = std::fs::read_to_string(dst.join("keymap.json")).unwrap();
        assert!(km.contains("\"text_control filter_input files_filter\"") && !km.contains("skyline"));
        assert_eq!(std::fs::read_to_string(dst.join("Default.sublime-keymap")).unwrap(), "[my old keys]", "our older file is left on disk");
        assert_eq!(std::fs::read_to_string(src.join("Default.sublime-commands")).unwrap(), "[cmds]", "the source is never changed");
        assert!(import_plan(&d.path().join("missing"), &dst).is_empty());
    }
}
