//! The optional commit-message model (crates/llm): which models exist and are downloaded, downloading one with progress
//! events, deleting one, and asking one for a commit message or a search query. The model runs here, in the app, never
//! in a remote agent: the UI collects the facts (staged files, patches, recent subjects, authors) through the normal
//! requests and passes them in.
use serde::Serialize;
use commitkiwi_llm::{catalog, download, generate::Engine, prompt, search};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct Llm {
    engine: Mutex<Option<Arc<Engine>>>,
    /// The model being downloaded.
    downloading: Mutex<Option<String>>,
    cancel_download: Arc<AtomicBool>,
    generating: Mutex<bool>,
    cancel_generate: Arc<AtomicBool>,
}

#[derive(Serialize)]
pub struct ModelInfo {
    id: &'static str,
    name: &'static str,
    note: &'static str,
    bytes: u64,
    installed: bool,
    downloading: bool,
}

/// Event `llm-download`: `state` is `progress`, `done`, `cancelled` or `error`.
#[derive(Serialize, Clone)]
struct DownloadEvent {
    id: String,
    state: &'static str,
    done: u64,
    total: u64,
    error: Option<String>,
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(pick_models_dir(&app.path().app_local_data_dir().map_err(|e| e.to_string())?))
}

/// `<data>/models`, unless it does not exist yet and a pre-rename build's `models` folder next to `data` does (newest
/// identifier first): then that one, so models already downloaded (GBs) are found, not fetched again, moved or deleted.
fn pick_models_dir(data: &std::path::Path) -> PathBuf {
    let new = data.join("models");
    if new.is_dir() {
        return new;
    }
    let legacy = data.parent().into_iter().flat_map(|p| crate::LEGACY_IDENTIFIERS.map(|id| p.join(id).join("models")));
    legacy.into_iter().find(|d| d.is_dir()).unwrap_or(new)
}

#[tauri::command]
pub fn llm_models(app: AppHandle, llm: State<'_, Llm>) -> Result<Vec<ModelInfo>, String> {
    let dir = models_dir(&app)?;
    let busy = llm.downloading.lock().unwrap().clone();
    Ok(catalog::MODELS
        .iter()
        .map(|m| ModelInfo { id: m.id, name: m.name, note: m.note, bytes: m.bytes, installed: catalog::installed(&dir, m), downloading: busy.as_deref() == Some(m.id) })
        .collect())
}

#[tauri::command]
pub fn llm_download(app: AppHandle, llm: State<'_, Llm>, id: String) -> Result<(), String> {
    let model = *catalog::find(&id).ok_or_else(|| format!("unknown model {id:?}"))?;
    let dir = models_dir(&app)?;
    {
        let mut busy = llm.downloading.lock().unwrap();
        if let Some(other) = busy.as_deref() {
            return Err(format!("{other} is still downloading"));
        }
        *busy = Some(id.clone());
    }
    llm.cancel_download.store(false, Ordering::Relaxed);
    let cancel = llm.cancel_download.clone();
    tauri::async_runtime::spawn(async move {
        let emit = |state, done, total, error| {
            let _ = app.emit("llm-download", DownloadEvent { id: model.id.to_string(), state, done, total, error });
        };
        let mut last = (std::time::Instant::now(), 0u64);
        let res = download::download(&model, &dir, cancel, |done, total| {
            // about four updates a second is plenty for a progress bar
            if last.0.elapsed().as_millis() >= 250 {
                last = (std::time::Instant::now(), done);
                emit("progress", done, total, None);
            }
        })
        .await;
        match res {
            Ok(_) => emit("done", model.bytes, model.bytes, None),
            Err(e) if e == download::CANCELLED => emit("cancelled", last.1, model.bytes, None),
            Err(e) => emit("error", last.1, model.bytes, Some(e)),
        }
        *app.state::<Llm>().downloading.lock().unwrap() = None;
    });
    Ok(())
}

#[tauri::command]
pub fn llm_cancel(llm: State<'_, Llm>) {
    llm.cancel_download.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub fn llm_stop(llm: State<'_, Llm>) {
    llm.cancel_generate.store(true, Ordering::Relaxed);
}

/// Remove the downloaded file (and a half-finished one); a model that is loaded is let go first.
#[tauri::command]
pub fn llm_delete(app: AppHandle, llm: State<'_, Llm>, id: String) -> Result<(), String> {
    let model = catalog::find(&id).ok_or_else(|| format!("unknown model {id:?}"))?;
    if llm.downloading.lock().unwrap().as_deref() == Some(model.id) {
        return Err("cancel the download first".into());
    }
    {
        let mut engine = llm.engine.lock().unwrap();
        if engine.as_ref().is_some_and(|e| e.id == model.id) {
            *engine = None;
        }
    }
    let file = catalog::path(&models_dir(&app)?, model);
    for p in [file.clone(), file.with_extension("gguf.part")] {
        match std::fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("cannot remove {}: {e}", p.display())),
        }
    }
    Ok(())
}

/// Take the one "writing a message" slot. A run in progress is told to stop and waited for: a newer request (the staged
/// files changed again) always wins over an older one, so a suggestion is never lost to "already busy".
async fn take_slot(busy: &Mutex<bool>, cancel: &AtomicBool) -> Result<(), String> {
    for _ in 0..300 {
        {
            let mut b = busy.lock().unwrap();
            if !*b {
                *b = true;
                cancel.store(false, Ordering::Relaxed);
                return Ok(());
            }
        }
        cancel.store(true, Ordering::Relaxed);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Err("The previous commit message is still being written.".into())
}

/// The commit message for the staged changes in `input`. `model`: the id the user prefers; else the first one downloaded.
#[tauri::command]
pub async fn llm_generate(app: AppHandle, llm: State<'_, Llm>, input: prompt::Input, model: Option<String>) -> Result<String, String> {
    with_engine(&app, &llm, model, move |engine, cancel| engine.run(&prompt::build(&input), cancel)).await
}

/// Natural-language search: the search bar's keyword query for `input.sentence`. The UI validates the answer with its
/// own search parser before anything runs; this only writes text.
#[tauri::command]
pub async fn llm_search_query(app: AppHandle, llm: State<'_, Llm>, input: search::Input, model: Option<String>) -> Result<String, String> {
    let prompt = search::build(&input)?;
    with_engine(&app, &llm, model, move |engine, cancel| engine.search_query(&prompt, cancel)).await
}

/// Run `f` on the chosen model (`model`: the id the user prefers; else the first one downloaded) off the UI thread, in
/// the one generation slot. The engine stays loaded afterwards, so the next answer starts at once.
async fn with_engine<F>(app: &AppHandle, llm: &Llm, model: Option<String>, f: F) -> Result<String, String>
where
    F: FnOnce(&Engine, &AtomicBool) -> Result<String, String> + Send + 'static,
{
    let dir = models_dir(app)?;
    let chosen = model
        .and_then(|id| catalog::find(&id))
        .filter(|m| catalog::installed(&dir, m))
        .or_else(|| catalog::MODELS.iter().find(|m| catalog::installed(&dir, m)))
        .ok_or("Download a commit message model first (command palette: Download Commit Message Model).")?;
    take_slot(&llm.generating, &llm.cancel_generate).await?;
    let cancel = llm.cancel_generate.clone();
    let cached = llm.engine.lock().unwrap().clone().filter(|e| e.id == chosen.id);
    let path = catalog::path(&dir, chosen);
    let id = chosen.id;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let engine = match cached {
            Some(e) => e,
            None => Arc::new(Engine::load(id, &path)?),
        };
        let msg = f(&engine, &cancel)?;
        Ok::<_, String>((engine, msg))
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    *llm.generating.lock().unwrap() = false;
    let (engine, msg) = result?;
    *llm.engine.lock().unwrap() = Some(engine); // kept loaded: the next message starts at once
    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_are_found_in_the_pre_rename_folder() {
        let base = tempfile::tempdir().unwrap();
        let data = base.path().join("kiwi.commit.desktop");
        let [sourcery, merge, _] = crate::LEGACY_IDENTIFIERS.map(|id| base.path().join(id).join("models"));
        // nothing anywhere: the new folder (not created here; the download creates it)
        assert_eq!(pick_models_dir(&data), data.join("models"));
        assert!(!data.exists());
        std::fs::create_dir_all(&merge).unwrap();
        assert_eq!(pick_models_dir(&data), merge);
        std::fs::create_dir_all(&sourcery).unwrap();
        std::fs::write(sourcery.join("m.gguf"), "x").unwrap();
        assert_eq!(pick_models_dir(&data), sourcery, "newest old name first");
        // once the new folder exists it wins; the old one is left as it is
        std::fs::create_dir_all(data.join("models")).unwrap();
        assert_eq!(pick_models_dir(&data), data.join("models"));
        assert!(sourcery.join("m.gguf").exists());
    }

    #[tokio::test]
    async fn a_newer_request_supersedes_a_running_one() {
        let busy = Arc::new(Mutex::new(false));
        let cancel = Arc::new(AtomicBool::new(false));
        take_slot(&busy, &cancel).await.unwrap(); // the first request holds the slot
        // the "run" watches the cancel flag like Engine::run does, then lets go
        let (b2, c2) = (busy.clone(), cancel.clone());
        let run = tokio::spawn(async move {
            while !c2.load(Ordering::Relaxed) {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            *b2.lock().unwrap() = false;
        });
        take_slot(&busy, &cancel).await.unwrap(); // the second one stops it and takes over
        run.await.unwrap();
        assert!(*busy.lock().unwrap(), "the newer request holds the slot");
        assert!(!cancel.load(Ordering::Relaxed), "and starts with a clear cancel flag");
    }
}
