#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! Thin shell: one generic `rpc` command forwards protocol requests to the runner for a location
//! (`local` or `ssh:<host>`); the rest is preferences, the ssh host list and the command line launcher (`cli`).
mod cli;
mod config;
mod llm;

use commitkiwi_protocol::{Change, Req, Resp};
use commitkiwi_runner::Runner;
use commitkiwi_runner::link::{Link, LinkEvent};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use tauri::{AppHandle, Manager, State};

/// A watched repo changed (`repo-changed` event).
#[derive(Clone, serde::Serialize)]
struct RepoChanged {
    location: String,
    #[serde(flatten)]
    change: Change,
}

/// A remote link dropped (`lost` = why; it is reconnecting) or came back (`lost` = null): the `connection` event.
#[derive(Clone, serde::Serialize)]
struct Connection {
    location: String,
    lost: Option<String>,
}

struct Locations {
    local: Arc<Runner>,
    /// One link per host, so a slow connect to one host never blocks calls to another.
    remote: StdMutex<HashMap<String, Arc<Link>>>,
    /// where events go (None in unit tests)
    app: Option<AppHandle>,
}

impl Locations {
    fn new(app: Option<AppHandle>) -> Self {
        Self { local: Arc::new(Runner::Local), remote: StdMutex::default(), app }
    }

    fn emit<T: serde::Serialize + Clone>(app: &Option<AppHandle>, event: &str, payload: T) {
        use tauri::Emitter;
        if let Some(a) = app {
            let _ = a.emit(event, payload);
        }
    }

    fn on_change(&self, location: &str) -> commitkiwi_runner::ChangeFn {
        let (app, location) = (self.app.clone(), location.to_string());
        Arc::new(move |change| Self::emit(&app, "repo-changed", RepoChanged { location: location.clone(), change }))
    }

    fn link(&self, location: &str) -> Result<Arc<Link>, String> {
        let host = location.strip_prefix("ssh:").ok_or_else(|| format!("unknown location {location:?}"))?;
        if !commitkiwi_runner::valid_host(host) {
            return Err(format!("invalid host name: {host:?}"));
        }
        let mut map = self.remote.lock().unwrap_or_else(|e| e.into_inner());
        Ok(map
            .entry(location.into())
            .or_insert_with(|| {
                let h = host.to_string();
                let (app, loc) = (self.app.clone(), location.to_string());
                Link::new(
                    Arc::new(move || {
                        let h = h.clone();
                        Box::pin(async move { Runner::connect_ssh(&h).await })
                    }),
                    self.on_change(location),
                    Arc::new(move |e| {
                        let lost = match e { LinkEvent::Lost(why) => Some(why), LinkEvent::Up => None };
                        Self::emit(&app, "connection", Connection { location: loc.clone(), lost });
                    }),
                )
            })
            .clone())
    }

    async fn runner(&self, location: &str) -> Result<Arc<Runner>, String> {
        if location == "local" {
            return Ok(self.local.clone());
        }
        self.link(location)?.runner().await
    }

    /// Ok(Some(reason)): no file events for this repo, the UI polls.
    async fn watch(&self, location: &str, repo: &str) -> Result<Option<String>, String> {
        if location == "local" {
            return self.local.watch(repo, self.on_change(location)).await;
        }
        self.link(location)?.watch(repo).await
    }

    async fn unwatch(&self, location: &str, repo: &str) -> Result<(), String> {
        if location == "local" {
            return self.local.unwatch(repo).await;
        }
        self.link(location)?.unwatch(repo).await
    }

    async fn rpc(&self, location: &str, req: Req, sink: Option<commitkiwi_runner::Sink>) -> Result<Resp, String> {
        if !trace::on() {
            return match self.runner(location).await?.call_with(req, sink).await? {
                Resp::Err(e) => Err(e),
                ok => Ok(ok),
            };
        }
        let (kind, repo) = trace::describe(&req);
        let t0 = std::time::Instant::now();
        let runner = self.runner(location).await;
        let wait = t0.elapsed();
        let (r, call, there) = match runner {
            Ok(r) => {
                let t1 = std::time::Instant::now();
                match r.call_timed(req, sink).await {
                    Ok((Resp::Err(e), ms)) => (Err(e), t1.elapsed(), ms),
                    Ok((ok, ms)) => (Ok(ok), t1.elapsed(), ms),
                    Err(e) => (Err(e), t1.elapsed(), None),
                }
            }
            Err(e) => (Err(e), std::time::Duration::ZERO, None),
        };
        trace::record(trace::Timing { kind, location: location.into(), repo, wait_ms: ms(wait), call_ms: ms(call), there_ms: there, total_ms: ms(t0.elapsed()), ok: r.is_ok() });
        r
    }
}

fn ms(d: std::time::Duration) -> f64 {
    (d.as_secs_f64() * 10_000.0).round() / 10.0
}

/// The request timing trace (COMMITKIWI_TRACE=1 or a pre-rename SOURCERYKIWI_/MERGEKIWI_/GITMERGE_TRACE=1, or the palette / Preferences
/// toggle): the last 100 requests with where their time went. Off by default; off, the only cost is one atomic load per request.
mod trace {
    use commitkiwi_protocol::Req;
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering::Relaxed};

    static ON: AtomicBool = AtomicBool::new(false);
    static LAST: Mutex<VecDeque<Timing>> = Mutex::new(VecDeque::new());
    const KEEP: usize = 100;

    #[derive(Clone, serde::Serialize)]
    pub struct Timing {
        pub kind: String,
        pub location: String,
        pub repo: String,
        /// waiting for the connection (first connect, a reconnect in progress)
        pub wait_ms: f64,
        /// sending, handling and the reply coming back (the ssh round trip, for a remote)
        pub call_ms: f64,
        /// handling where the repo is (in the agent for a remote; git's share of `call_ms`)
        pub there_ms: Option<u32>,
        pub total_ms: f64,
        pub ok: bool,
    }

    pub fn init_from_env() {
        if std::env::var("COMMITKIWI_TRACE").or_else(|_| std::env::var("SOURCERYKIWI_TRACE")).or_else(|_| std::env::var("MERGEKIWI_TRACE")).or_else(|_| std::env::var("GITMERGE_TRACE")).is_ok_and(|v| v == "1") {
            ON.store(true, Relaxed);
        }
    }
    pub fn on() -> bool {
        ON.load(Relaxed)
    }
    pub fn set(on: bool) {
        ON.store(on, Relaxed);
        if !on {
            LAST.lock().unwrap_or_else(|e| e.into_inner()).clear();
        }
    }
    pub fn record(t: Timing) {
        let mut l = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if l.len() == KEEP {
            l.pop_front();
        }
        l.push_back(t);
    }
    /// newest first
    pub fn last() -> Vec<Timing> {
        LAST.lock().unwrap_or_else(|e| e.into_inner()).iter().rev().cloned().collect()
    }
    /// The request's variant name and its repo (a job: "Job:<kind>"), read through serde (only while tracing).
    pub fn describe(req: &Req) -> (String, String) {
        let v = serde_json::to_value(req).unwrap_or_default();
        let (mut kind, mut body) = match &v {
            serde_json::Value::String(s) => (s.clone(), &serde_json::Value::Null),
            serde_json::Value::Object(m) => m.iter().next().map(|(k, b)| (k.clone(), b)).unwrap_or_default(),
            _ => (String::new(), &serde_json::Value::Null),
        };
        if kind == "Job" && let Some((k, b)) = body.get("req").and_then(|r| r.as_object()).and_then(|m| m.iter().next()) {
            kind = format!("Job:{k}");
            body = b;
        }
        (kind, body.get("repo").and_then(|r| r.as_str()).unwrap_or("").into())
    }
}

#[tauri::command]
fn request_trace(on: Option<bool>) -> bool {
    if let Some(on) = on {
        trace::set(on);
    }
    trace::on()
}

#[tauri::command]
fn request_timings() -> Vec<trace::Timing> {
    trace::last()
}

/// A console job's output chunk, as the `job-output` event.
#[derive(Clone, serde::Serialize)]
struct JobOutput {
    job: u64,
    text: String,
}

#[tauri::command]
async fn rpc(app: AppHandle, loc: State<'_, Locations>, location: String, req: Req) -> Result<Resp, String> {
    use tauri::Emitter;
    let sink: Option<commitkiwi_runner::Sink> = match &req {
        &Req::Job { job, .. } => Some(std::sync::Arc::new(move |text: &str| {
            let _ = app.emit("job-output", JobOutput { job, text: text.into() });
        })),
        _ => None,
    };
    loc.rpc(&location, req, sink).await
}

#[tauri::command]
async fn watch_repo(loc: State<'_, Locations>, location: String, repo: String) -> Result<Option<String>, String> {
    loc.watch(&location, &repo).await
}

#[tauri::command]
async fn unwatch_repo(loc: State<'_, Locations>, location: String, repo: String) -> Result<(), String> {
    loc.unwatch(&location, &repo).await
}

/// Preferences > Remote > Reinstall agent: upload this app's agent to `host` again (used from the next connection).
#[tauri::command]
async fn reinstall_agent(host: String) -> Result<String, String> {
    commitkiwi_runner::install_agent(&host, true).await
}

/// Preferences > Remote > Clean up old agents (and the daily sweep after a connection): files and bytes removed.
#[tauri::command]
async fn cleanup_agents(host: String, days: u32) -> Result<(u64, u64), String> {
    commitkiwi_runner::cleanup_agents(&host, days).await
}

#[tauri::command]
fn ssh_hosts() -> Vec<String> {
    commitkiwi_runner::ssh_hosts()
}

fn prefs_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("preferences.json"))
}

#[tauri::command]
fn load_prefs(app: AppHandle) -> Result<String, String> {
    match std::fs::read_to_string(prefs_path(&app)?) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".into()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn save_prefs(app: AppHandle, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("invalid preferences: {e}"))?;
    let path = prefs_path(&app)?;
    std::fs::create_dir_all(path.parent().ok_or("no config dir")?).map_err(|e| e.to_string())?;
    // write + rename so a crash never leaves half a file
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| e.to_string())
}

/// Split a command template into arguments: whitespace separates, single or double quotes group.
/// No shell is involved anywhere, so file names substituted later can never inject syntax.
fn split_args(template: &str) -> Result<Vec<String>, String> {
    let (mut args, mut cur, mut quote, mut started) = (Vec::new(), String::new(), None::<char>, false);
    for c in template.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '\'' | '"') => { quote = Some(c); started = true; }
            (None, c) if c.is_whitespace() => {
                if started { args.push(std::mem::take(&mut cur)); started = false; }
            }
            (None, c) => { cur.push(c); started = true; }
        }
    }
    if quote.is_some() { return Err("unbalanced quote in editor command".into()); }
    if started { args.push(cur); }
    if args.is_empty() { return Err("editor command is empty".into()); }
    Ok(args)
}

/// Open a file in the user's editor. `template` comes from preferences, e.g. `code --remote ssh-remote+{host} {path}`.
#[tauri::command]
fn open_editor(template: String, path: String, host: String) -> Result<(), String> {
    let args: Vec<String> = split_args(&template)?.into_iter().map(|a| a.replace("{path}", &path).replace("{host}", &host)).collect();
    let mut child = std::process::Command::new(&args[0])
        .args(&args[1..])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("cannot run `{}`: {e}", args[0]))?;
    std::thread::spawn(move || { let _ = child.wait(); }); // reap it; the editor outlives this call
    Ok(())
}

/// Help > About commit.kiwi & Licenses…: open the bundled THIRD-PARTY-LICENSES.md (only that file) with the OS
/// opener; `tauri dev` builds without the bundle fall back to the repository's copy.
#[tauri::command]
fn open_licenses(app: AppHandle) -> Result<(), String> {
    const NAME: &str = "THIRD-PARTY-LICENSES.md";
    let bundled = app.path().resource_dir().ok().map(|d| d.join(NAME)).filter(|p| p.is_file());
    let dev = || cfg!(debug_assertions).then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(NAME)).filter(|p| p.is_file());
    let path = bundled.or_else(dev).ok_or_else(|| format!("{NAME} is missing from this build"))?;
    let opener = if cfg!(target_os = "macos") { "open -t {path}" } else { "xdg-open {path}" };
    open_editor(opener.into(), path.to_string_lossy().into_owned(), String::new())
}

/// tauri.conf.json `identifier`: the config folder's name, needed before Tauri starts (the launcher's socket lives there).
const IDENTIFIER: &str = "kiwi.commit.desktop";
/// The bundle identifiers before the renames (sourcery.kiwi, merge.kiwi, gitmerge), newest first; their config folders
/// are where existing users' files are.
const LEGACY_IDENTIFIERS: [&str; 3] = ["kiwi.sourcery.desktop", "kiwi.merge.desktop", "app.gitmerge.desktop"];

/// First launch after the rename: copy the user's files (preferences + the config files, old and new names) from the
/// pre-rename config folder `old` to `new`. Only when `new` has none of them yet; `old` is never changed. Returns the
/// names copied.
fn migrate_config(old: &std::path::Path, new: &std::path::Path) -> Vec<String> {
    let names = || config::all_names().into_iter().chain(["preferences.json".to_string()]);
    if !old.is_dir() || names().any(|n| new.join(n).exists()) {
        return Vec::new();
    }
    let mut copied = Vec::new();
    for n in names().filter(|n| old.join(n).is_file()) {
        // keep going on an error: a later launch would not retry, since the files already copied exist
        match std::fs::create_dir_all(new).and_then(|_| std::fs::copy(old.join(&n), new.join(&n))) {
            Ok(_) => copied.push(n),
            Err(e) => eprintln!("config migration: cannot copy {n}: {e}"),
        }
    }
    copied
}

/// `migrate_config` from the newest legacy folder next to `new` that has files to copy; the older ones are not read.
fn migrate_legacy(new: &std::path::Path) -> Option<(std::path::PathBuf, Vec<String>)> {
    let parent = new.parent()?;
    LEGACY_IDENTIFIERS.iter().map(|id| parent.join(id)).find_map(|old| {
        let copied = migrate_config(&old, new);
        (!copied.is_empty()).then_some((old, copied))
    })
}

fn config_dir_of(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

/// A user config file's text ("" when missing; an older name of the same file is read while the new one is missing).
#[tauri::command]
fn read_config(app: AppHandle, name: String) -> Result<String, String> {
    config::read(&config_dir_of(&app)?, &name)
}

/// Create the file with commented example content when missing, and return its path ("Edit Key Bindings…").
/// `example`: the UI's own (settings.json lists every preference with its default).
#[tauri::command]
fn ensure_config(app: AppHandle, name: String, example: Option<String>) -> Result<String, String> {
    Ok(config::ensure(&config_dir_of(&app)?, &name, example.as_deref())?.to_string_lossy().into_owned())
}

/// Save a config file the UI edits (the key bindings editor). Written via temp file + rename: a crash never leaves
/// half a keymap.
#[tauri::command]
fn write_config(app: AppHandle, name: String, text: String) -> Result<(), String> {
    config::write(&config_dir_of(&app)?, &name, &text)
}

/// The user's theme files: (file name, text).
#[tauri::command]
fn list_themes(app: AppHandle) -> Result<Vec<(String, String)>, String> {
    Ok(config::list_themes(&config_dir_of(&app)?))
}

/// Sublime Merge's user folder, when it exists on this computer.
#[tauri::command]
fn sublime_user_dir() -> Option<String> {
    let home = std::env::var_os("HOME").map(PathBuf::from).filter(|h| h.is_absolute())?;
    config::sublime_user_dir(&home).map(|p| p.to_string_lossy().into_owned())
}

/// Import a Sublime Merge user folder: `apply` false only plans (nothing written); `overwrite` replaces files that
/// exist here (asked first in the UI).
#[tauri::command]
fn import_sublime(app: AppHandle, dir: String, apply: bool, overwrite: bool) -> Result<Vec<config::ImportItem>, String> {
    let src = PathBuf::from(&dir);
    if !src.is_absolute() || !src.is_dir() { return Err(format!("not a folder: {dir}")); }
    let dst = config_dir_of(&app)?;
    if apply { config::import_apply(&src, &dst, overwrite) } else { Ok(config::import_plan(&src, &dst)) }
}

#[derive(serde::Serialize)]
struct AgentBuild {
    platform: String,
    remote_path: String,
}
#[derive(serde::Serialize)]
struct AgentInfo {
    proto: u32,
    agents: Vec<AgentBuild>,
}

#[tauri::command]
fn agent_info() -> AgentInfo {
    let agents = commitkiwi_runner::bundled_agents().into_iter().map(|(platform, remote_path)| AgentBuild { platform, remote_path }).collect();
    AgentInfo { proto: commitkiwi_protocol::PROTO_VERSION, agents }
}

/// macOS menu bar. The stock one binds Cmd+W to "Close Window", which would close the app before the UI could
/// close the current repository tab; Edit stays so copy/paste work in the webview. The UI replaces this with the
/// full menu (`set_menu`) once it has loaded its commands and keymap.
#[cfg(target_os = "macos")]
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let nodes: Vec<MenuNode> = serde_json::from_str(
        r#"[{"caption":"Edit","children":[{"caption":"Undo","id":"native:undo"},{"caption":"Redo","id":"native:redo"},{"caption":"-"},
            {"caption":"Cut","id":"native:cut"},{"caption":"Copy","id":"native:copy"},{"caption":"Paste","id":"native:paste"},
            {"caption":"Select All","id":"native:select_all"}]},
           {"caption":"Window","children":[{"caption":"Minimize","id":"native:minimize"},{"caption":"Zoom","id":"native:maximize"}]}]"#,
    )
    .expect("static menu");
    build_menu(app, &nodes)
}

/// One menu entry as the UI sends it: `-` is a separator, `children` makes a submenu, ids `native:*` are OS items,
/// any other id is reported back to the UI as a `menu` event.
#[derive(serde::Deserialize)]
struct MenuNode {
    caption: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    enabled: bool,
    /// shown and active; the UI ignores the event when its own keymap already handled that key press
    accel: Option<String>,
    children: Option<Vec<MenuNode>>,
}

fn fill_submenu<R: tauri::Runtime>(app: &AppHandle<R>, sub: &tauri::menu::Submenu<R>, nodes: &[MenuNode]) -> tauri::Result<()> {
    use tauri::menu::{MenuItem, PredefinedMenuItem as P, Submenu};
    for n in nodes {
        if n.caption == "-" {
            sub.append(&P::separator(app)?)?;
        } else if let Some(children) = &n.children {
            let s = Submenu::new(app, &n.caption, true)?;
            fill_submenu(app, &s, children)?;
            sub.append(&s)?;
        } else {
            let t = Some(n.caption.as_str());
            match n.id.as_str() {
                "native:undo" => sub.append(&P::undo(app, t)?)?,
                "native:redo" => sub.append(&P::redo(app, t)?)?,
                "native:cut" => sub.append(&P::cut(app, t)?)?,
                "native:copy" => sub.append(&P::copy(app, t)?)?,
                "native:paste" => sub.append(&P::paste(app, t)?)?,
                "native:select_all" => sub.append(&P::select_all(app, t)?)?,
                "native:minimize" => sub.append(&P::minimize(app, t)?)?,
                "native:maximize" => sub.append(&P::maximize(app, t)?)?,
                "native:fullscreen" => sub.append(&P::fullscreen(app, t)?)?,
                // the predefined Close Window takes Cmd+W, which closes the repository tab here
                "native:close_window" => sub.append(&MenuItem::with_id(app, "native:close_window", &n.caption, true, Some("Shift+Cmd+W"))?)?,
                id => sub.append(&MenuItem::with_id(app, id, &n.caption, n.enabled, n.accel.as_deref())?)?,
            }
        }
    }
    Ok(())
}

/// Top-level menus after the application menu; on macOS "Preferences" goes inside the application menu.
fn build_menu<R: tauri::Runtime>(app: &AppHandle<R>, nodes: &[MenuNode]) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, Submenu};
    let menu = Menu::new(app)?;
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::PredefinedMenuItem as P;
        let app_sub = Submenu::new(app, "commit.kiwi", true)?;
        app_sub.append(&P::about(app, None, None)?)?;
        app_sub.append(&P::separator(app)?)?;
        if let Some(prefs) = nodes.iter().find(|n| n.caption == "Preferences") {
            let s = Submenu::new(app, "Preferences", true)?;
            fill_submenu(app, &s, prefs.children.as_deref().unwrap_or_default())?;
            app_sub.append(&s)?;
            app_sub.append(&P::separator(app)?)?;
        }
        for item in [P::services(app, None)?, P::separator(app)?, P::hide(app, None)?, P::hide_others(app, None)?, P::show_all(app, None)?, P::separator(app)?, P::quit(app, None)?] {
            app_sub.append(&item)?;
        }
        menu.append(&app_sub)?;
    }
    for n in nodes.iter().filter(|n| !(cfg!(target_os = "macos") && n.caption == "Preferences")) {
        let s = Submenu::new(app, &n.caption, true)?;
        fill_submenu(app, &s, n.children.as_deref().unwrap_or_default())?;
        menu.append(&s)?;
    }
    Ok(menu)
}

/// Sync on purpose: menus are built on the main thread.
#[tauri::command]
fn set_menu(app: AppHandle, menus: Vec<MenuNode>) -> Result<(), String> {
    let menu = build_menu(&app, &menus).map_err(|e| e.to_string())?;
    app.set_menu(menu).map(|_| ()).map_err(|e| e.to_string())
}

/// git/ssh want a password, passphrase or yes/no (local repos only): the `askpass` event shows it in the window.
#[derive(Clone, serde::Serialize)]
struct AskpassPrompt {
    id: u64,
    prompt: String,
}

/// The user's answer to an askpass prompt; None = Cancel. Never logged or kept.
#[tauri::command]
fn askpass_answer(askpass: State<'_, Arc<commitkiwi_runner::askpass::Askpass>>, id: u64, answer: Option<String>) {
    askpass.answer(id, answer);
}

fn on_menu_event(app: &AppHandle, e: tauri::menu::MenuEvent) {
    use tauri::Emitter;
    match e.id().as_ref() {
        "native:close_window" => { if let Some(w) = app.get_webview_window("main") { let _ = w.close(); } }
        id => { let _ = app.emit("menu", id); }
    }
}

/// Paths from the command line (this launch's and forwarded ones) until the UI takes them (`cli_take`).
#[derive(Default)]
struct CliInbox {
    pending: StdMutex<cli::Opened>,
    app: OnceLock<AppHandle>,
}

impl CliInbox {
    fn deliver(&self, m: cli::Opened) {
        {
            let mut p = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            p.open.extend(m.open);
            p.errors.extend(m.errors);
        }
        if let Some(app) = self.app.get() {
            use tauri::Emitter;
            let _ = app.emit("cli-open", ());
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
    }
}

#[tauri::command]
fn cli_take(inbox: State<'_, Arc<CliInbox>>) -> cli::Opened {
    std::mem::take(&mut *inbox.pending.lock().unwrap_or_else(|e| e.into_inner()))
}

/// The app config dir as Tauri computes it, without Tauri (the launcher runs before it).
fn config_dir(home: &std::path::Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        return home.join("Library/Application Support").join(IDENTIFIER);
    }
    let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute());
    xdg.unwrap_or_else(|| home.join(".config")).join(IDENTIFIER)
}

/// The command line, before any window: Some(exit code) when this process is done (help, forwarded, detached).
fn launcher(inbox: &Arc<CliInbox>) -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().unwrap_or_else(|_| "/".into());
    let home = std::env::var_os("HOME").map(PathBuf::from).filter(|h| h.is_absolute());
    let paths = match cli::parse(&args, &cwd, home.as_deref()) {
        Ok(cli::Cmd::Help) => { print!("{}", cli::USAGE); return Some(0); }
        Ok(cli::Cmd::Version) => { println!("commit.kiwi {}", env!("CARGO_PKG_VERSION")); return Some(0); }
        Ok(cli::Cmd::Open(p)) => p,
        Err(e) => { eprintln!("commitkiwi: {e}\n\n{}", cli::USAGE); return Some(2); }
    };
    let msg = cli::resolve(&paths);
    for e in &msg.errors {
        eprintln!("commitkiwi: {e}");
    }
    let Some(home) = home else { inbox.deliver(msg); return None }; // no config dir: one more instance, no forwarding
    let dir = cli::sock_dir(&config_dir(&home));
    // From a terminal, give the prompt back: forward, or start the app detached. Not in debug builds: `tauri dev`
    // runs the binary from a terminal and wants it to stay.
    use std::io::IsTerminal;
    if !cfg!(debug_assertions) && (std::io::stdin().is_terminal() || std::io::stdout().is_terminal()) {
        if cli::send(&dir, &msg).is_ok() {
            return Some(0);
        }
        match std::env::current_exe().and_then(|e| e.canonicalize()).and_then(|exe| cli::detach(&exe, &paths)) {
            Ok(()) => return Some(0),
            Err(e) => eprintln!("commitkiwi: cannot start in the background ({e}); running here"),
        }
    }
    let sink = inbox.clone();
    match cli::claim(&dir, &msg, move |m| sink.deliver(m)) {
        Ok(cli::Role::Forwarded) => return Some(0),
        Ok(cli::Role::Primary) => {}
        Err(e) => eprintln!("commitkiwi: cannot reach a running commit.kiwi ({e}); starting another"),
    }
    inbox.deliver(msg);
    None
}

#[derive(serde::Serialize)]
struct CliInstall {
    path: String,
    /// Some: `path` is something else (where it points); install again with `replace` to overwrite it
    replace: Option<String>,
    /// PATH hint and dev-build warning, "" when none
    note: String,
}

fn tool_target_and_dirs() -> Result<(PathBuf, Vec<PathBuf>), String> {
    let exe = std::env::current_exe().and_then(|e| e.canonicalize()).map_err(|e| format!("cannot find this program: {e}"))?;
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("HOME is not set")?;
    Ok((exe, cli::tool_dirs(&home)))
}

/// Install Command Line Tool…: a `commitkiwi` symlink to this executable (see `cli::install`).
#[tauri::command]
fn install_cli(replace: bool) -> Result<CliInstall, String> {
    let (exe, dirs) = tool_target_and_dirs()?;
    let path = match cli::install(&exe, &dirs, replace)? {
        cli::Install::Ask { path, current } => return Ok(CliInstall { path: path.display().to_string(), replace: Some(current), note: String::new() }),
        cli::Install::Done(path) => path,
    };
    let dir = path.parent().unwrap_or(&path);
    // the app's own PATH is not the shell's (Finder starts apps with a short one): also count /etc/paths
    let listed = std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d == dir))
        || std::fs::read_to_string("/etc/paths").is_ok_and(|s| s.lines().any(|l| std::path::Path::new(l.trim()) == dir));
    let mut note = Vec::new();
    if !listed {
        note.push(format!("If your shell does not find `commitkiwi`, add this line to your shell profile: export PATH=\"{}:$PATH\"", dir.display()));
    }
    if exe.components().any(|c| c.as_os_str() == "target") {
        note.push(format!("This is a development build: the link points at {}. Install again from the packaged app.", exe.display()));
    }
    Ok(CliInstall { path: path.display().to_string(), replace: None, note: note.join(" ") })
}

/// Uninstall Command Line Tool: removes `commitkiwi` links that point at this executable, nothing else.
#[tauri::command]
fn uninstall_cli() -> Result<String, String> {
    let (exe, dirs) = tool_target_and_dirs()?;
    let removed = cli::uninstall(&exe, &dirs);
    Ok(if removed.is_empty() {
        format!("No `commitkiwi` link to this app found in {}.", dirs.iter().map(|d| d.display().to_string()).collect::<Vec<_>>().join(", "))
    } else {
        format!("Removed {}.", removed.iter().map(|d| d.display().to_string()).collect::<Vec<_>>().join(", "))
    })
}

fn main() {
    // SAFETY: first statement of main, before any thread; without it every quit with the model loaded aborts in ggml
    #[cfg(target_os = "macos")]
    unsafe { commitkiwi_llm::generate::disable_metal_residency_sets() };
    // git and ssh run this executable as their askpass program (see runner::askpass)
    if std::env::var_os(commitkiwi_runner::askpass::SOCK_ENV).is_some() {
        std::process::exit(commitkiwi_runner::askpass::helper_main());
    }
    let inbox = Arc::new(CliInbox::default());
    if let Some(code) = launcher(&inbox) {
        std::process::exit(code);
    }
    trace::init_from_env();
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);
    builder
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(on_menu_event)
        .setup(move |app| {
            use tauri::Emitter;
            let _ = inbox.app.set(app.handle().clone());
            app.manage(inbox);
            app.manage(llm::Llm::default());
            // before any command runs: load_prefs/read_config are sync commands, i.e. on this (main) thread
            if let Ok(new) = app.path().app_config_dir()
                && let Some((old, copied)) = migrate_legacy(&new)
            {
                eprintln!("config migration: copied {copied:?} from {} to {}", old.display(), new.display());
            }
            app.manage(Locations::new(Some(app.handle().clone())));
            let handle = app.handle().clone();
            // without the prompt channel git still works; it just reports that it could not ask
            match commitkiwi_runner::askpass::Askpass::start(move |id, prompt| { let _ = handle.emit("askpass", AskpassPrompt { id, prompt }); }) {
                Ok(askpass) => {
                    if let Ok(exe) = std::env::current_exe() {
                        commitkiwi_runner::set_local_write_env(askpass.env(&exe));
                    }
                    app.manage(Arc::new(askpass));
                }
                Err(e) => eprintln!("askpass channel unavailable: {e}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![llm::llm_models, llm::llm_download, llm::llm_cancel, llm::llm_stop, llm::llm_delete, llm::llm_generate, llm::llm_search_query, rpc, request_trace, request_timings, watch_repo, unwatch_repo, reinstall_agent, cleanup_agents, ssh_hosts, load_prefs, save_prefs, open_editor, read_config, ensure_config, write_config, list_themes, sublime_user_dir, import_sublime, agent_info, set_menu, askpass_answer, cli_take, install_cli, uninstall_cli, open_licenses])
        .run(tauri::generate_context!())
        .expect("error while running commit.kiwi");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn request_trace_records_only_when_on() {
        let loc = Locations::new(None);
        let d = tempfile::tempdir().unwrap();
        let open = || Req::Open { path: d.path().to_str().unwrap().into() };
        let _ = loc.rpc("local", open(), None).await;
        assert!(request_timings().is_empty(), "off: nothing recorded");
        assert!(request_trace(Some(true)));
        let _ = loc.rpc("local", open(), None).await;
        let _ = loc.rpc("local", Req::Hello, None).await;
        // other tests may run calls meanwhile: look for ours, newest first
        let t = request_timings();
        let at = |k: &str| t.iter().position(|t| t.kind == k).unwrap();
        assert!(at("Hello") < at("Open"), "newest first");
        let o = &t[at("Open")];
        assert!(!o.ok && o.there_ms.is_some() && o.total_ms >= o.call_ms);
        let job = Req::Job { job: 1, req: Box::new(Req::Fetch { repo: "/r".into(), flags: vec![], remote: None }) };
        assert_eq!(trace::describe(&job), ("Job:Fetch".to_string(), "/r".to_string()));
        assert!(!request_trace(Some(false)));
        assert!(request_timings().is_empty(), "turning it off drops the log");
    }

    #[tokio::test]
    async fn local_rpc_and_error_mapping() {
        let loc = Locations::new(None);
        let d = tempfile::tempdir().unwrap();
        // not a repo: git's error surfaces as Err, not as Ok(Resp::Err)
        let err = loc.rpc("local", Req::Open { path: d.path().to_str().unwrap().into() }, None).await.unwrap_err();
        assert!(err.to_lowercase().contains("not a git repository"), "{err}");
        assert!(matches!(loc.rpc("local", Req::Hello, None).await, Ok(Resp::Hello { .. })));
    }

    #[test]
    fn editor_templates() {
        assert_eq!(split_args("code --remote ssh-remote+{host} {path}").unwrap(), ["code", "--remote", "ssh-remote+{host}", "{path}"]);
        assert_eq!(split_args(r#"open -a "Sublime Text" {path}"#).unwrap(), ["open", "-a", "Sublime Text", "{path}"]);
        assert_eq!(split_args("  a   'b c'  ").unwrap(), ["a", "b c"]);
        assert_eq!(split_args("x ''").unwrap(), ["x", ""]); // an explicitly empty argument is kept
        assert!(split_args("   ").is_err() && split_args("a 'b").is_err());
    }

    #[test]
    fn config_migrates_from_the_pre_rename_folder_once() {
        let base = tempfile::tempdir().unwrap();
        let (old, new) = (base.path().join(LEGACY_IDENTIFIERS[0]), base.path().join("kiwi.commit.desktop"));
        std::fs::create_dir_all(&old).unwrap();
        for (n, t) in [("preferences.json", "{\"a\":1}"), ("Default.sublime-keymap", "[k]"), ("Main.sublime-menu", "[m]"), ("other.txt", "x")] {
            std::fs::write(old.join(n), t).unwrap();
        }
        // no old folder: nothing happens, the new one is not created
        assert!(migrate_config(&base.path().join("missing"), &new).is_empty() && !new.exists());
        let mut copied = migrate_config(&old, &new);
        copied.sort();
        assert_eq!(copied, ["Default.sublime-keymap", "Main.sublime-menu", "preferences.json"]);
        assert_eq!(std::fs::read_to_string(new.join("Default.sublime-keymap")).unwrap(), "[k]");
        assert!(!new.join("other.txt").exists(), "only known files");
        assert_eq!(std::fs::read_to_string(old.join("preferences.json")).unwrap(), "{\"a\":1}", "old left alone");
        // second launch, or the user already has new files: nothing is overwritten
        std::fs::write(new.join("preferences.json"), "{\"new\":true}").unwrap();
        std::fs::remove_file(new.join("Main.sublime-menu")).unwrap();
        assert!(migrate_config(&old, &new).is_empty());
        assert_eq!(std::fs::read_to_string(new.join("preferences.json")).unwrap(), "{\"new\":true}");
        assert!(!new.join("Main.sublime-menu").exists());
        // a new folder holding only unrelated files still migrates
        let fresh = base.path().join("fresh");
        std::fs::create_dir_all(&fresh).unwrap();
        std::fs::write(fresh.join("preferences.json.tmp"), "x").unwrap();
        assert_eq!(migrate_config(&old, &fresh).len(), 3);
    }

    #[test]
    fn config_migrates_from_the_newest_legacy_folder_only() {
        let base = tempfile::tempdir().unwrap();
        let new = base.path().join(IDENTIFIER);
        let [sourcery, merge, gitmerge] = LEGACY_IDENTIFIERS.map(|id| base.path().join(id));
        // none present: nothing, no new folder
        assert!(migrate_legacy(&new).is_none() && !new.exists());
        std::fs::create_dir_all(&gitmerge).unwrap();
        std::fs::write(gitmerge.join("preferences.json"), "g").unwrap();
        std::fs::create_dir_all(&merge).unwrap();
        std::fs::write(merge.join("preferences.json"), "m").unwrap();
        std::fs::write(merge.join("Default.sublime-keymap"), "[m]").unwrap();
        // the newest folder exists but holds only other things (models, launcher socket): the next one is used
        std::fs::create_dir_all(sourcery.join("models")).unwrap();
        let (old, copied) = migrate_legacy(&new).unwrap();
        assert_eq!((old, copied.len()), (merge.clone(), 2));
        assert_eq!(std::fs::read_to_string(new.join("preferences.json")).unwrap(), "m");
        // with files in all three, only the newest is copied
        std::fs::remove_dir_all(&new).unwrap();
        std::fs::write(sourcery.join("preferences.json"), "s").unwrap();
        assert_eq!(migrate_legacy(&new).unwrap(), (sourcery.clone(), vec!["preferences.json".to_string()]));
        assert_eq!(std::fs::read_to_string(new.join("preferences.json")).unwrap(), "s");
        assert!(!new.join("Default.sublime-keymap").exists(), "older folders not merged in");
        // a later launch copies nothing; the legacy folders are untouched
        assert!(migrate_legacy(&new).is_none());
        assert_eq!(std::fs::read_to_string(merge.join("preferences.json")).unwrap(), "m");
        assert_eq!(std::fs::read_to_string(gitmerge.join("preferences.json")).unwrap(), "g");
    }

    #[test]
    fn editor_runs_without_a_shell() {
        let d = tempfile::tempdir().unwrap();
        let marker = d.path().join("evil; touch pwned");
        std::fs::write(&marker, "x").unwrap();
        // a hostile file name stays one argument; `test -f` finds it, nothing is interpreted
        assert!(open_editor("test -f {path}".into(), marker.to_str().unwrap().into(), String::new()).is_ok());
        assert!(!d.path().join("pwned").exists());
        assert!(open_editor("definitely-not-a-program {path}".into(), "x".into(), String::new()).is_err());
    }

    #[test]
    fn menu_spec_from_the_ui() {
        // the shape menu.ts sends, extra fields (`keys`) ignored
        let n: Vec<MenuNode> = serde_json::from_str(r#"[{"caption":"File","children":[{"caption":"Close Tab","id":"3","enabled":true,"keys":["super+w"],"accel":"Cmd+W"},{"caption":"-"}]}]"#).unwrap();
        let c = n[0].children.as_ref().unwrap();
        assert!(c[0].enabled && c[0].accel.as_deref() == Some("Cmd+W") && c[1].caption == "-" && c[1].children.is_none());
    }

    #[tokio::test]
    async fn rejects_bad_locations() {
        let loc = Locations::new(None);
        assert!(loc.rpc("nonsense", Req::Hello, None).await.is_err());
        // option-injection attempt must fail validation before any ssh process starts
        let e = loc.rpc("ssh:-oProxyCommand=touch /tmp/pwn", Req::Hello, None).await.unwrap_err();
        assert!(e.contains("invalid host"), "{e}");
    }
}
