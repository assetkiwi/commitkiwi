// The existing e2e files test the key assignments the user has used for years: run them on the "sublime-style"
// keymap preset (the default preset has its own checks in config.mjs). Seeds the pref before the app loads,
// unless a test already set one.
export async function sublimeStyle(page) {
  await page.addInitScript(() => {
    let p = {};
    try { p = JSON.parse(localStorage.getItem("commitkiwi.prefs") || "{}") || {}; } catch { /* start fresh */ }
    if (!("keymap_preset" in p)) localStorage.setItem("commitkiwi.prefs", JSON.stringify({ ...p, keymap_preset: "sublime-style" }));
  });
}
