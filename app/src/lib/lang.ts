// File name -> highlight.js language id. Pure, import-free.
const BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile", makefile: "makefile", ".htaccess": "apache", "composer.lock": "json", ".env": "ini",
  ".gitignore": "bash", ".gitattributes": "bash", "package-lock.json": "json",
};
const BY_EXT: Record<string, string> = {
  // Drupal's PHP lives in many extensions
  php: "php", module: "php", inc: "php", install: "php", theme: "php", profile: "php", engine: "php", phtml: "php",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
  json: "json", css: "css", scss: "scss", html: "xml", htm: "xml", xml: "xml", svg: "xml", twig: "twig",
  yml: "yaml", yaml: "yaml", md: "markdown", markdown: "markdown", sh: "bash", bash: "bash", zsh: "bash",
  py: "python", rs: "rust", go: "go", sql: "sql", ini: "ini", toml: "ini", conf: "nginx", neon: "yaml", patch: "diff", diff: "diff",
};

export function langFor(path: string): string | null {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? BY_EXT[name.slice(dot + 1)] ?? null : null;
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
export const isImage = (path: string): boolean => IMAGE_EXT.test(path);
