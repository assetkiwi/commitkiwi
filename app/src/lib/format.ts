// Pure helpers (no imports, so node can test this file directly).
export const initials = (name: string): string =>
  name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";

const PALETTE = ["#3b7cff", "#e0663a", "#16a37a", "#a65cf0", "#d6457f", "#c28a12"];
/** Stable avatar colour per author. */
export const colorFor = (key: string): string => {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

export function ago(unix: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.floor(nowMs / 1000 - unix));
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (s < 60) return "just now";
  if (m < 60) return `${m} min ago`;
  if (h < 24) return `${h} h ago`;
  if (d < 30) return `${d} days ago`;
  if (d < 365) return `${Math.floor(d / 30)} mo ago`;
  return `${Math.floor(d / 365)} y ago`;
}

/** "[25505977]: Fix x" -> ["[25505977]:", "Fix x"] so the ticket id can be dimmed. */
export function splitTicket(subject: string): [string, string] {
  const m = /^(\[[^\]]+\]:?)\s*(.*)$/.exec(subject);
  return m ? [m[1], m[2]] : ["", subject];
}

export const baseName = (p: string): string => p.replace(/\/+$/, "").split("/").pop() || p;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Commit date: "Wed, 4 Nov, 2026, 20:06" (local time). */
export function fullDate(unix: number): string {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}, ${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A merge message without git's `#` comment lines (what `git commit` would strip when editing it). */
export const stripComments = (msg: string): string => msg.split("\n").filter((l) => !l.startsWith("#")).join("\n").trim();
