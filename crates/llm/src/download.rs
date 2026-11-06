//! Fetching a model file: resumable (`<file>.part` stays after a cancel or a dropped connection), cancellable, and
//! only moved into place when the size and the SHA-256 are the pinned ones.
use crate::catalog::{self, Model};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const CANCELLED: &str = "cancelled";

/// Download `m` into `dir` unless it is already there. `progress(done, total)` is called per received chunk.
pub async fn download(m: &Model, dir: &Path, cancel: Arc<AtomicBool>, progress: impl FnMut(u64, u64)) -> Result<PathBuf, String> {
    if catalog::installed(dir, m) {
        return Ok(catalog::path(dir, m));
    }
    fetch(m.url, m.bytes, m.sha256, &catalog::path(dir, m), cancel, progress).await
}

/// The same for any url (tests use a local server).
pub async fn fetch(url: &str, bytes: u64, sha256: &str, dest: &Path, cancel: Arc<AtomicBool>, mut progress: impl FnMut(u64, u64)) -> Result<PathBuf, String> {
    let io = |e: std::io::Error| e.to_string();
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(io)?;
    }
    let part = dest.with_extension("gguf.part");
    let mut have = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
    if have > bytes {
        tokio::fs::remove_file(&part).await.map_err(io)?;
        have = 0;
    }
    if have < bytes {
        let client = reqwest::Client::builder().user_agent("commit.kiwi").build().map_err(|e| e.to_string())?;
        let mut req = client.get(url);
        if have > 0 {
            req = req.header("Range", format!("bytes={have}-"));
        }
        let resp = req.send().await.map_err(|e| format!("download failed: {e}"))?;
        let status = resp.status();
        // 206: the server continues where we stopped. 200: it ignored the range, start over.
        let mut file = if status.as_u16() == 206 && have > 0 {
            tokio::fs::OpenOptions::new().append(true).open(&part).await.map_err(io)?
        } else if status.is_success() {
            have = 0;
            tokio::fs::File::create(&part).await.map_err(io)?
        } else {
            return Err(format!("download failed: HTTP {status}"));
        };
        let mut stream = resp.bytes_stream();
        let mut done = have;
        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::Relaxed) {
                let _ = file.flush().await;
                return Err(CANCELLED.into());
            }
            let chunk = chunk.map_err(|e| format!("download interrupted: {e}"))?;
            file.write_all(&chunk).await.map_err(io)?;
            done += chunk.len() as u64;
            progress(done, bytes);
        }
        file.flush().await.map_err(io)?;
    }
    verify(&part, bytes, sha256).await?;
    tokio::fs::rename(&part, dest).await.map_err(io)?;
    Ok(dest.to_path_buf())
}

/// Size and SHA-256 as pinned; a file that does not match is deleted.
async fn verify(part: &Path, bytes: u64, sha256: &str) -> Result<(), String> {
    let io = |e: std::io::Error| e.to_string();
    let len = tokio::fs::metadata(part).await.map_err(io)?.len();
    let mut hash = Sha256::new();
    let mut f = tokio::fs::File::open(part).await.map_err(io)?;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).await.map_err(io)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if len != bytes || !got.eq_ignore_ascii_case(sha256) {
        let _ = tokio::fs::remove_file(part).await;
        return Err("the downloaded file does not match the expected checksum and was removed".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    /// A tiny http server that serves `body`, honouring `Range: bytes=N-` when `ranges` is true.
    async fn serve(body: Vec<u8>, ranges: bool) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = listener.accept().await else { return };
                let body = body.clone();
                tokio::spawn(async move {
                    let mut req = vec![0u8; 4096];
                    let n = s.read(&mut req).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&req[..n]).to_ascii_lowercase();
                    let from = req.lines().find_map(|l| l.strip_prefix("range: bytes=")).and_then(|r| r.trim_end_matches('-').parse::<usize>().ok());
                    let (status, slice) = match from {
                        Some(f) if ranges => ("206 Partial Content", &body[f..]),
                        _ => ("200 OK", &body[..]),
                    };
                    let head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", slice.len());
                    let _ = s.write_all(head.as_bytes()).await;
                    let _ = s.write_all(slice).await;
                });
            }
        });
        format!("http://{addr}/m.gguf")
    }

    fn sha(b: &[u8]) -> String {
        Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
    }

    #[tokio::test]
    async fn downloads_verifies_and_reports_progress() {
        let body: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let url = serve(body.clone(), true).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.gguf");
        let mut last = (0, 0);
        let out = fetch(&url, body.len() as u64, &sha(&body), &dest, Arc::default(), |d, t| last = (d, t)).await.unwrap();
        assert_eq!(std::fs::read(out).unwrap(), body);
        assert_eq!(last, (body.len() as u64, body.len() as u64));
        assert!(!dir.path().join("m.gguf.part").exists());
    }

    #[tokio::test]
    async fn resumes_a_part_file_and_survives_a_server_without_ranges() {
        let body: Vec<u8> = (0..120_000u32).map(|i| (i % 241) as u8).collect();
        for ranges in [true, false] {
            let url = serve(body.clone(), ranges).await;
            let dir = tempfile::tempdir().unwrap();
            let dest = dir.path().join("m.gguf");
            std::fs::write(dir.path().join("m.gguf.part"), &body[..50_000]).unwrap();
            fetch(&url, body.len() as u64, &sha(&body), &dest, Arc::default(), |_, _| {}).await.unwrap();
            assert_eq!(std::fs::read(&dest).unwrap(), body, "ranges={ranges}");
        }
    }

    #[tokio::test]
    async fn a_wrong_checksum_is_refused_and_removed() {
        let body = vec![7u8; 10_000];
        let url = serve(body.clone(), true).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.gguf");
        let err = fetch(&url, body.len() as u64, &"0".repeat(64), &dest, Arc::default(), |_, _| {}).await.unwrap_err();
        assert!(err.contains("checksum"), "{err}");
        assert!(!dest.exists() && !dir.path().join("m.gguf.part").exists());
    }

    #[tokio::test]
    async fn cancel_keeps_the_part_file_for_later() {
        let body = vec![1u8; 300_000];
        let url = serve(body.clone(), true).await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.gguf");
        let cancel = Arc::new(AtomicBool::new(false));
        let c2 = cancel.clone();
        let err = fetch(&url, body.len() as u64, &sha(&body), &dest, cancel, move |_, _| c2.store(true, Ordering::Relaxed)).await.unwrap_err();
        assert_eq!(err, CANCELLED);
        assert!(!dest.exists() && dir.path().join("m.gguf.part").exists());
    }
}
