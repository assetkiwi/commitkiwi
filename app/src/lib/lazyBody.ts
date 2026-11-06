import { anchorShift } from "./lazy";

/** Attachment for a lazy diff body inside the scrolling `.dscroll`: `onNear` as it comes within 1.5 screens of
 *  the view (or leaves), `onHeight` with its rendered height whenever that changes. When a body wholly above the
 *  view changes height (it mounted with a different height than its placeholder), scrollTop moves by the
 *  difference so what the user looks at stays put (also for one reaching into the view while `fresh()`, see
 *  anchorShift) (`.dscroll` has `overflow-anchor: none`, WebKit has none). */
export function lazyBody(onNear: (near: boolean) => void, onHeight: (h: number) => void, fresh: () => boolean) {
  return (el: HTMLElement) => {
    const root = el.closest<HTMLElement>(".dscroll");
    const io = new IntersectionObserver((es) => onNear(es[es.length - 1].isIntersecting), { root, rootMargin: "150% 0px" });
    let last = el.offsetHeight;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (h === last) return;
      if (root) root.scrollTop += anchorShift(el.getBoundingClientRect().top - root.getBoundingClientRect().top, last, h, fresh());
      last = h;
      onHeight(h);
    });
    io.observe(el);
    ro.observe(el);
    return () => { io.disconnect(); ro.disconnect(); };
  };
}
