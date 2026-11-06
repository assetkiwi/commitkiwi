//! `cargo run --release -p commitkiwi-llm --example download -- <model-id> <dir>`: the app's download for a catalog model
//! (resume from `<file>.part`, checksum), with a progress line. For trying it against the real server.
use std::sync::{Arc, atomic::AtomicBool};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let a: Vec<String> = std::env::args().collect();
    let model = commitkiwi_llm::catalog::find(&a[1]).expect("unknown model id");
    let t = std::time::Instant::now();
    let path = commitkiwi_llm::download::download(model, std::path::Path::new(&a[2]), Arc::new(AtomicBool::new(false)), |d, total| {
        eprint!("\r{d} / {total} bytes");
    })
    .await
    .expect("download");
    eprintln!("\nok: {} in {:.1}s", path.display(), t.elapsed().as_secs_f32());
}
