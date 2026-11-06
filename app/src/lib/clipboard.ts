/** Copy text; falls back to a hidden textarea when the async clipboard API is refused by the webview. */
export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = document.createElement("textarea");
    t.value = text;
    t.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand("copy");
    t.remove();
    return ok;
  }
}

/** Copy text that is still being fetched (a remote's URL): the write starts inside the click, which WebKit requires. */
export async function copyLater(text: Promise<string>): Promise<boolean> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
    return true;
  } catch {
    return copy(await text);
  }
}
