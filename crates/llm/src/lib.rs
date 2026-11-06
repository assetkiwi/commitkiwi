//! The optional local language model that writes commit messages: what the model gets (`prompt`), the models that can
//! be downloaded (`catalog`, `download`) and running one (`generate`). The UI side only passes plain facts in
//! (changed files, per-file patches, recent subjects); everything about the model stays in this crate.
pub mod catalog;
pub mod download;
pub mod generate;
pub mod prompt;
pub mod search;
