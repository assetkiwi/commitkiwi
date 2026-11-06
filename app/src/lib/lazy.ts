// Lazy diff bodies (import-free, node-tested): how tall a body that never rendered probably is, and a request
// limiter so expanding hundreds of files never fires hundreds of git calls at once.

/** The diff widget renders this many rows at first, then this many more per "Show more lines". */
export const DIFF_FIRST = 600, DIFF_MORE = 2000;

/** Rows a file's diff probably has before it is fetched: changed lines (split pairs them) plus one hunk's context. */
export function estimateRows(adds: number | null, dels: number | null, context: number, split: boolean): number {
  if (adds === null || dels === null) return 3; // binary: one line of text
  return (split ? Math.max(adds, dels) : adds + dels) + 2 * context + 1;
}

/** Placeholder height (px) for `rows` diff rows, at most `limit` of them shown (then a "Show more" button). */
export function estimateHeight(rows: number, limit: number, lineH: number, wrap: boolean): number {
  const shown = Math.min(rows, limit);
  return Math.round(shown * lineH * (wrap ? 1.15 : 1) + (rows > limit ? 48 : 0) + 12);
}

/** Thrown (rejected) for a queued task that was no longer wanted when its turn came. */
export const SKIPPED = Symbol("skipped");

/** At most `max` tasks run at once; the rest wait in order. A waiting task whose `wanted()` turns false is
 *  dropped when its turn comes (rejects with SKIPPED) instead of running. */
export function limiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    while (active < max && queue.length) queue.shift()!();
  };
  return function run<T>(task: () => Promise<T>, wanted: () => boolean = () => true): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        if (!wanted()) { reject(SKIPPED); return; }
        active++;
        // a task that throws synchronously still frees its slot
        new Promise<T>((r) => r(task())).then(resolve, reject).finally(() => { active--; next(); });
      });
      next();
    });
  };
}

/** Diff and file-content requests from lazy bodies share this: 3 at a time, app-wide. */
export const diffQueue = limiter(3);

/** How far scrollTop must move so the content in view stays put when a body changes height from `oldH` to
 *  `newH` (`top`: the body's top relative to the viewport top). Bodies wholly above the view always count; one
 *  that starts above the view and reaches into it counts only while `fresh` (its placeholder or "Loading" turning
 *  into the real diff), so a click inside a visible body (Show more lines) still grows it downwards. */
export function anchorShift(top: number, oldH: number, newH: number, fresh = false): number {
  return top < 0 && (top + oldH <= 0 || fresh) ? newH - oldH : 0;
}
