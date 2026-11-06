//! The askpass helper as its own binary, for the tests (the app runs the same code as a mode of its executable).
fn main() {
    std::process::exit(commitkiwi_runner::askpass::helper_main());
}
