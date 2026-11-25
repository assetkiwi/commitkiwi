//! Try the shortening pass on long first lines: `cargo run --release -p commitkiwi-llm --example shorten -- <model.gguf> <style: conv|mimic> <line>...`
use commitkiwi_llm::prompt::{self, Style};
use std::sync::atomic::AtomicBool;
use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let engine = commitkiwi_llm::generate::Engine::load("shorten", std::path::Path::new(&a[1])).expect("load");
    let style = if a[2] == "conv" { Style::Conventional } else { Style::Mimic };
    for line in &a[3..] {
        let t = Instant::now();
        let out = engine.shorten(line, style, &AtomicBool::new(false)).expect("shorten");
        let fits = prompt::overlong(&out, style).is_none();
        let soft = prompt::subject_fits(&out, style);
        println!("{} -> {} chars, {} ms, within target {}, within slack {}\n  in:  {line}\n  out: {out}\n", line.chars().count(), out.chars().count(), t.elapsed().as_millis(), if fits { "yes" } else { "no" }, if soft { "yes" } else { "NO" });
    }
}
