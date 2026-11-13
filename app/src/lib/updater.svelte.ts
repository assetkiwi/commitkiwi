// In-app updates (Tauri updater): the published GitHub release's latest.json, signed with the project's updater key.
// macOS and the Linux AppImage download, install and restart; a .deb/.rpm install only hears that a version exists.
import { invoke } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";
import { api, inTauri } from "./api";
import { app } from "./state.svelte";

export const RELEASES_URL = "https://github.com/assetkiwi/commitkiwi/releases/latest";

/** The update on offer (`version` empty: none); `busy` = what the banner says while it installs. */
export const update = $state({ version: "", installable: false, busy: "" });
let pending: Update | null = null;

/** `manual` (Help > Check for Updates…): say "up to date" or why the check failed; the startup check stays quiet. */
export async function checkForUpdates(manual: boolean): Promise<void> {
  if (!inTauri) { if (manual) app.notice = "Updates are checked in the desktop app only."; return; }
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const u = await check();
    if (!u) { if (manual) app.notice = `commit.kiwi ${await api.appVersion()} is the latest version.`; return; }
    pending = u;
    update.installable = await invoke<boolean>("update_installable");
    update.version = u.version;
  } catch (e) {
    if (manual) app.notice = `Could not check for updates: ${e}`;
  }
}

/** Install and Restart: download (progress in the banner), verify the signature (the plugin does), relaunch. */
export async function installUpdate(): Promise<void> {
  if (!pending || update.busy) return;
  let total = 0, got = 0;
  update.busy = "Downloading…";
  try {
    await pending.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? 0;
      else if (e.event === "Progress") { got += e.data.chunkLength; if (total) update.busy = `Downloading… ${Math.floor((got / total) * 100)}%`; }
      else update.busy = "Installing…";
    });
    await (await import("@tauri-apps/plugin-process")).relaunch();
  } catch (e) {
    update.busy = "";
    app.notice = `The update failed: ${e}`;
  }
}

/** .deb/.rpm: the Releases page in the browser. */
export const openReleases = () => api.openEditor("xdg-open {path}", RELEASES_URL, "");

export const dismissUpdate = () => { update.version = ""; };
