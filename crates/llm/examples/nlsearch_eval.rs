//! Try a model on natural-language search: `COMMITKIWI_EVAL_MODEL=<model.gguf> cargo run --release -p commitkiwi-llm
//! --example nlsearch_eval`. Runs ~25 sample requests (neutral sample data, today fixed at 2024-03-20) through the same
//! prompt and grammar as the app and reports, per request and in total: valid (every term is a known keyword or a
//! plain word, dates are dates) and exact (the same terms as expected, values compared case-insensitively, `message:x`
//! and a plain `x` counted the same). The dates are given as the app's resolver would give them.
use commitkiwi_llm::search::{self, Input, Keyword};
use std::collections::BTreeSet;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

/// The keyword table, read from the UI's own source so this cannot drift from it either.
fn keywords() -> Vec<Keyword> {
    let src = include_str!("../../../app/src/lib/search.ts");
    let field = |line: &str, key: &str| line.split(&format!("{key}: \"")).nth(1).and_then(|r| r.split('"').next()).map(String::from);
    src.lines()
        .filter(|l| l.trim_start().starts_with("{ name: \""))
        .filter_map(|l| Some(Keyword { name: field(l, "name")?, field: field(l, "field")?, desc: field(l, "desc").unwrap_or_default() }))
        .collect()
}

/// `(sentence, resolved date tokens, expected terms)`
const CASES: &[(&str, &str, &str)] = &[
    ("commits by sam last week", "after:2024-03-11 before:2024-03-18", "author:\"Sam Lee\" after:2024-03-11 before:2024-03-18"),
    ("what did ana do yesterday", "after:2024-03-19 before:2024-03-20", "author:\"Ana Ruiz\" after:2024-03-19 before:2024-03-20"),
    ("changes in the docs folder", "", "file:docs"),
    ("commits touching src since monday", "after:2024-03-18", "file:src after:2024-03-18"),
    ("fixes for the login form", "", "fix login form"),
    ("show commit 9f3e2a1", "", "commit:9f3e2a1"),
    ("commits on release/2.0", "", "branch:release/2.0"),
    ("commits that added the text unsafe_block", "", "content:unsafe_block"),
    ("alex's commits about caching this month", "after:2024-03-01", "author:\"Alex Martin\" after:2024-03-01 caching"),
    ("changes to README.md by jordan", "", "file:README.md author:\"Jordan Park\""),
    ("commits from last year about the parser", "after:2023-01-01 before:2024-01-01", "after:2023-01-01 before:2024-01-01 parser"),
    ("everything sam did in february", "after:2024-02-01 before:2024-03-01", "author:\"Sam Lee\" after:2024-02-01 before:2024-03-01"),
    ("commits mentioning timeout", "", "timeout"),
    ("fixes in tests last month", "after:2024-02-01 before:2024-03-01", "file:tests fix after:2024-02-01 before:2024-03-01"),
    ("refactoring by ana in the app folder", "", "author:\"Ana Ruiz\" file:app refactor"),
    ("what changed in Cargo.toml", "", "file:Cargo.toml"),
    ("commits on develop by alex", "", "branch:develop author:\"Alex Martin\""),
    ("merge commits today", "after:2024-03-20 before:2024-03-21", "merge after:2024-03-20 before:2024-03-21"),
    ("commits about the release in the last 3 days", "after:2024-03-17", "release after:2024-03-17"),
    ("jordan's changes to docs this week", "after:2024-03-18", "author:\"Jordan Park\" file:docs after:2024-03-18"),
    ("typo fixes", "", "typo fix"),
    ("commit abc1234 on main", "", "commit:abc1234 branch:main"),
    ("commits that introduced parse_config", "", "content:parse_config"),
    ("performance commits by sam this year", "after:2024-01-01", "author:\"Sam Lee\" performance after:2024-01-01"),
    ("commits that upgrade tokio two weeks ago", "after:2024-03-06", "upgrade tokio after:2024-03-06"),
];

/// Terms split on spaces outside quotes.
fn terms(s: &str) -> Vec<String> {
    let (mut out, mut cur, mut quoted) = (Vec::new(), String::new(), false);
    for c in s.chars() {
        match c {
            '"' => quoted = !quoted,
            ' ' if !quoted => out.extend((!cur.is_empty()).then(|| std::mem::take(&mut cur))),
            _ => cur.push(c),
        }
    }
    out.extend((!cur.is_empty()).then_some(cur));
    out
}

/// Canonical terms (`field:value`, lowercase; message: as plain text), or Err for an invalid term.
fn canonical(s: &str, kws: &[Keyword]) -> Result<BTreeSet<String>, String> {
    terms(s)
        .into_iter()
        .map(|t| {
            let (k, v) = match t.split_once(':') {
                Some((k, v)) => (Some(k), v),
                None => (None, t.as_str()),
            };
            let field = match k {
                None => "text",
                Some(k) => kws.iter().find(|x| x.name == k).map(|x| x.field.as_str()).ok_or_else(|| format!("unknown keyword {k}:"))?,
            };
            let ok_date = |v: &str| v.len() == 10 && v.as_bytes()[4] == b'-' && v.as_bytes()[7] == b'-';
            if (field == "after" || field == "before") && !ok_date(v) {
                return Err(format!("bad date {t}"));
            }
            let field = if field == "message" { "text" } else { field };
            Ok(format!("{field}:{}", v.to_lowercase()))
        })
        .collect()
}

fn main() {
    let Ok(model) = std::env::var("COMMITKIWI_EVAL_MODEL") else {
        eprintln!("set COMMITKIWI_EVAL_MODEL to a .gguf file");
        std::process::exit(2);
    };
    let kws = keywords();
    assert!(kws.len() >= 8, "could not read the keyword table from search.ts");
    let engine = commitkiwi_llm::generate::Engine::load("eval", std::path::Path::new(&model)).expect("load");
    let (mut valid, mut exact, mut total_ms) = (0, 0, 0u128);
    for (sentence, dates, expected) in CASES {
        let input = Input {
            sentence: sentence.to_string(),
            today: "2024-03-20".into(),
            keywords: kws.clone(),
            dates: dates.split_whitespace().map(String::from).collect(),
            recent_authors: ["Sam Lee", "Ana Ruiz", "Alex Martin", "Jordan Park"].map(String::from).to_vec(),
            known_paths: ["src", "docs", "tests", "app", "README.md", "Cargo.toml"].map(String::from).to_vec(),
            branches: ["main", "develop", "release/2.0"].map(String::from).to_vec(),
        };
        let prompt = search::build(&input).expect("prompt");
        let t = Instant::now();
        let out = engine.search_query(&prompt, &AtomicBool::new(false));
        let ms = t.elapsed().as_millis();
        total_ms += ms;
        let (mark, got) = match &out {
            Ok(q) => match canonical(q, &kws) {
                Ok(set) => {
                    valid += 1;
                    let hit = set == canonical(expected, &kws).expect("expected terms are valid");
                    exact += hit as u32;
                    (if hit { "exact" } else { "valid" }, q.clone())
                }
                Err(e) => ("INVALID", format!("{q}  ({e})")),
            },
            Err(e) => ("ERROR", e.clone()),
        };
        println!("{mark:7} {ms:5} ms  {sentence}\n        got:      {got}\n        expected: {expected}");
    }
    let n = CASES.len();
    println!("\n{n} requests: valid {valid}/{n}, exact {exact}/{n}, {} ms per request on average", total_ms / n as u128);
}
