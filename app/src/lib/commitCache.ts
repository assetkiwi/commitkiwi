import { api } from "./api";
import type { GraphLayout } from "./graph";
import type { Commit, Detail, GraphData } from "./types";

/** Per-tab data that must survive switching tabs (the list component is destroyed when hidden). */
export interface Cache {
  pages: Map<number, Commit[]>;
  loading: Set<number>;
  files: Map<string, number>; // oid -> changed files
  asked: Set<string>; // oids with a stats request in flight or done
  graph: GraphData | null;
  layout: GraphLayout | null;
  /** real rows of the merges collapsed with Left (their merged-in commits are hidden) */
  collapsed: Set<number>;
  details: Map<string, Detail>;
  scrollTop: number;
  /** cursor row and the selected rows (real indices); more than one = a range diff ("Diffing From") */
  sel: number;
  multi: number[];
}
const caches = new Map<string, Cache>();
const DETAIL_CACHE = 200;

export function cacheFor(tabId: string): Cache {
  let c = caches.get(tabId);
  if (!c) {
    c = { pages: new Map(), loading: new Set(), files: new Map(), asked: new Set(), graph: null, layout: null, collapsed: new Set(), details: new Map(), scrollTop: 0, sel: 0, multi: [0] };
    caches.set(tabId, c);
  }
  return c;
}
export const dropCache = (tabId: string): void => void caches.delete(tabId);

const inflight = new Map<string, Promise<Detail>>();
/** A commit's detail (`from`: range from that commit's parent), cached per tab; concurrent callers share one request. */
export function loadDetail(tab: { id: string; location: string; path: string }, oid: string, from: string | null): Promise<Detail> {
  const key = from ? `${from}..${oid}` : oid;
  const cache = cacheFor(tab.id);
  const hit = cache.details.get(key);
  if (hit) return Promise.resolve(hit);
  const k = `${tab.id}|${key}`;
  let p = inflight.get(k);
  if (!p) {
    p = api.show(tab.location, tab.path, oid, from).then((d) => {
      if (cache.details.size >= DETAIL_CACHE) cache.details.delete(cache.details.keys().next().value!);
      cache.details.set(key, d);
      return d;
    }).finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}
