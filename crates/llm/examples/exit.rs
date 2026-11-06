//! Does the process survive its own exit with the model still in memory? `cargo run -p commitkiwi-llm --example exit`
//! (needs a Mac with Metal; `scripts/check-exit.sh` runs it repeatedly). Like the app, it initialises the backend, keeps
//! Metal memory alive (a loaded model when COMMITKIWI_EXIT_MODEL names a .gguf, else one leaked GPU buffer, which is
//! what a model's weights are) and returns from main, so exit() runs ggml's C++ static destructors. Exit code 134 =
//! ggml aborted in them. `--keep-residency` skips the fix to show the crash.
use llama_cpp_2::llama_backend::LlamaBackend;

fn main() {
    if !std::env::args().any(|a| a == "--keep-residency") {
        // SAFETY: first thing in main, no other thread yet (the same call the app makes)
        unsafe { commitkiwi_llm::generate::disable_metal_residency_sets() };
    }
    if let Some(model) = std::env::var_os("COMMITKIWI_EXIT_MODEL") {
        let engine = commitkiwi_llm::generate::Engine::load("exit", std::path::Path::new(&model)).expect("load");
        std::mem::forget(engine); // the app keeps it in managed state, which is never dropped on quit
        eprintln!("model loaded and kept");
    } else {
        std::mem::forget(LlamaBackend::init().expect("backend"));
        // SAFETY: plain ggml C calls on a device the registry owns; the buffer is leaked on purpose
        unsafe {
            use llama_cpp_sys_2::*;
            let dev = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU);
            assert!(!dev.is_null(), "no GPU device (Metal)");
            let buf = ggml_backend_buft_alloc_buffer(ggml_backend_dev_buffer_type(dev), 1 << 20);
            assert!(!buf.is_null(), "GPU buffer allocation failed");
        }
        eprintln!("GPU buffer allocated and kept");
    }
}
