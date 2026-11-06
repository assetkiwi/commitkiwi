//! Try a model on real commits: `cargo run --release -p commitkiwi-llm --example eval -- <model.gguf> <repo> <count> [out.md]`.
//! For each of the last `count` non-merge commits the staged-diff prompt is built from that commit (as if it were being
//! written now), once with the repository's recent subjects as style hints and once without (Conventional Commits), and
//! the model's message is printed next to the real one. Nothing is judged automatically except shape and time.
use commitkiwi_llm::prompt::{self, FileChange, Input, Style};
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

fn git(repo: &str, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(repo).args(args).output().expect("git");
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (model, repo, count) = (&a[1], &a[2], a[3].parse::<usize>().unwrap());
    let out_path = a.get(4);
    let t = Instant::now();
    let engine = commitkiwi_llm::generate::Engine::load("eval", std::path::Path::new(model)).expect("load");
    eprintln!("model loaded in {:.1}s", t.elapsed().as_secs_f32());
    let shas: Vec<String> = git(repo, &["log", "--no-merges", "-n", &count.to_string(), "--format=%H"]).lines().map(String::from).collect();
    let mut md = format!("# {model}\n\n");
    let (mut ok_conv, mut ok_mimic, mut total_ms, mut runs) = (0, 0, 0u128, 0);
    for sha in &shas {
        let subject = git(repo, &["show", "-s", "--format=%s", sha]).trim().to_string();
        let numstat = git(repo, &["show", "--numstat", "--format=", sha]);
        let status = git(repo, &["show", "--name-status", "--format=", sha]);
        let mut files = Vec::new();
        for line in status.lines() {
            let mut p = line.split('\t');
            let (st, path) = (p.next().unwrap_or("M"), p.next_back().unwrap_or(""));
            let counts = numstat.lines().find(|l| l.ends_with(path)).map(|l| l.split('\t').take(2).map(|n| n.parse::<u32>().ok()).collect::<Vec<_>>());
            let (adds, dels) = counts.map(|c| (c[0], c[1])).unwrap_or((None, None));
            files.push(FileChange { path: path.to_string(), status: st.chars().next().unwrap_or('M'), adds, dels });
        }
        if files.is_empty() || files.len() > 60 {
            continue;
        }
        let patches: Vec<(String, String)> = files.iter().map(|f| (f.path.clone(), git(repo, &["diff", &format!("{sha}^"), sha, "--unified=2", "--", &f.path]))).collect();
        let recent: Vec<String> = git(repo, &["log", "--no-merges", "-n", "5", "--format=%s", &format!("{sha}^")]).lines().map(String::from).collect();
        md.push_str(&format!("## {}\n\n{} files; real: `{subject}`\n\n", &sha[..8], files.len()));
        for (label, recent) in [("style from history", recent), ("conventional (no history)", vec![])] {
            let input = Input { branch: None, recent, files: files.clone(), patches: patches.clone() };
            let prompt = prompt::build(&input);
            let t = Instant::now();
            let res = engine.run(&prompt, &AtomicBool::new(false));
            let ms = t.elapsed().as_millis();
            total_ms += ms;
            runs += 1;
            match res {
                Ok(msg) => {
                    let first = msg.lines().next().unwrap_or("");
                    let shape = first.len() <= 90 && !first.is_empty();
                    if prompt.style == Style::Conventional { ok_conv += shape as u32 } else { ok_mimic += shape as u32 }
                    md.push_str(&format!("- **{label}** ({ms} ms, prompt {} chars):\n\n```\n{msg}\n```\n\n", prompt.messages[1].1.len()));
                }
                Err(e) => md.push_str(&format!("- **{label}**: ERROR {e}\n\n")),
            }
        }
    }
    md.push_str(&format!("\n{runs} runs, {} ms per run on average; well-shaped: conventional {ok_conv}, history style {ok_mimic}\n", total_ms / runs.max(1) as u128));
    match out_path {
        Some(p) => std::fs::write(p, &md).unwrap(),
        None => println!("{md}"),
    }
}
