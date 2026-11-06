//! The models that can be downloaded. The files are pinned by size and SHA-256 (taken from Hugging Face's own listing of
//! the LFS files on 2026-11-06), so a changed or damaged download is refused instead of loaded.
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Model {
    pub id: &'static str,
    pub name: &'static str,
    pub note: &'static str,
    pub file: &'static str,
    pub url: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

pub const MODELS: &[Model] = &[
    Model {
        id: "qwen3.5-2b",
        name: "Qwen3.5 2B (Q4_K_M)",
        note: "Recommended: the best messages in the tests, a little slower. Apache-2.0.",
        file: "Qwen3.5-2B-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf",
        bytes: 1_280_835_840,
        sha256: "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
    },
    Model {
        id: "qwen2.5-coder-1.5b",
        name: "Qwen2.5-Coder 1.5B Instruct (Q4_K_M)",
        note: "Smaller and faster, simpler messages. Apache-2.0.",
        file: "Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf",
        url: "https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf",
        bytes: 986_048_800,
        sha256: "f530705d447660a4336c329981af164b471b60b974b1d808d57e8ec9fe23b239",
    },
];

pub fn find(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|m| m.id == id)
}

pub fn path(dir: &Path, m: &Model) -> PathBuf {
    dir.join(m.file)
}

/// Downloaded completely (a `.part` file never counts).
pub fn installed(dir: &Path, m: &Model) -> bool {
    std::fs::metadata(path(dir, m)).is_ok_and(|f| f.is_file() && f.len() == m.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_is_well_formed() {
        for m in MODELS {
            assert!(m.url.starts_with("https://huggingface.co/") && m.url.ends_with(m.file), "{}", m.id);
            assert!(m.sha256.len() == 64 && m.sha256.chars().all(|c| c.is_ascii_hexdigit()), "{}", m.id);
            assert!(m.bytes > 100_000_000 && !m.file.contains('/'), "{}", m.id);
            assert_eq!(find(m.id), Some(m));
        }
        assert!(find("nope").is_none());
        let ids: std::collections::HashSet<_> = MODELS.iter().map(|m| m.id).collect();
        assert_eq!(ids.len(), MODELS.len());
    }

    #[test]
    fn installed_means_the_whole_file() {
        let dir = tempfile::tempdir().unwrap();
        let m = &MODELS[0];
        assert!(!installed(dir.path(), m));
        std::fs::write(path(dir.path(), m), b"short").unwrap();
        assert!(!installed(dir.path(), m));
    }
}
