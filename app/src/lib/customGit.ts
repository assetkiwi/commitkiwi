// Sublime Merge's custom `git` command (`{ "command": "git", "args": { "argv": [...] } }`): `$variables` filled
// from the menu/repository, `$select_*`/`$text` selectors asked for in the palette first. Pure and import-free.

/** The selectors of the custom `git` command format: each asks for one value before the command runs. */
export const SELECTORS = ["select_ref", "select_branch", "select_local_branch", "select_remote_branch", "select_commit", "select_tag", "select_stash", "text"] as const;
export type Selector = (typeof SELECTORS)[number];

const VAR = /\$(\w+)/g;
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * `argv` with every `$name` that `vars` has filled in (anywhere in an argument). Throws when argv is not a non-empty
 * list of strings, when a value is not text or holds control characters, or when a filled-in value would turn an
 * argument into an option (a branch or file called `--upload-pack=…`). Unknown `$x` (selectors) stay as they are.
 */
export function fillArgv(argv: unknown, vars: Record<string, unknown>): string[] {
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== "string")) throw new Error('The git command needs "argv": a list of strings.');
  return (argv as string[]).map((a) => {
    const out = a.replace(VAR, (m, k: string) => {
      const v = vars[k];
      if (v === undefined || v === null) return m;
      if (typeof v !== "string" && typeof v !== "number") throw new Error(`$${k} is not text here.`);
      const s = String(v);
      if (CONTROL.test(s)) throw new Error(`$${k} holds control characters.`);
      return s;
    });
    if (out.startsWith("-") && !a.startsWith("-")) throw new Error(`Refused: "${a}" would become the option "${out}".`);
    return out;
  });
}

/** The first selector argv still holds, or null when it is ready to run. */
export function nextSelector(argv: string[]): Selector | null {
  for (const a of argv) for (const m of a.matchAll(VAR)) if ((SELECTORS as readonly string[]).includes(m[1])) return m[1] as Selector;
  return null;
}

/** Every `$sel` replaced by the picked/typed `value`. */
export const fillSelector = (argv: string[], sel: Selector, value: string): string[] =>
  argv.map((a) => a.replace(VAR, (m, k: string) => (k === sel ? value : m)));
