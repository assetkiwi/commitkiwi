import { test } from "node:test";
import assert from "node:assert/strict";
import { filterRecent } from "./recentFilter.ts";
import { fuzzy } from "./fuzzy.ts";

const L = [
  { location: "local", path: "/w/alpha" }, { location: "local", path: "/w/beta-site" },
  { location: "ssh:h", path: "/srv/gamma/" }, { location: "local", path: "/x/other/deep" },
];
const alias = (r: { path: string }) => (r.path === "/w/alpha" ? "Billing" : "");
const f = (q: string, list = L) => filterRecent(list, q, alias, fuzzy).map((r) => r.path);

test("empty query keeps all, in order", () => assert.deepEqual(f("  "), L.map((r) => r.path)));
test("matches name, alias and path", () => {
  assert.deepEqual(f("bsi"), ["/w/beta-site"]);
  assert.deepEqual(f("bill"), ["/w/alpha"]);
  assert.deepEqual(f("other"), ["/x/other/deep"]);
  assert.deepEqual(f("gamma"), ["/srv/gamma/"]);
});
test("name beats path hit, no match is empty", () => {
  assert.deepEqual(f("deep")[0], "/x/other/deep");
  assert.deepEqual(f("zzz"), []);
});
test("filters all 500", () => {
  const big = Array.from({ length: 500 }, (_, i) => ({ location: "local", path: `/r/repo${i}` }));
  assert.deepEqual(f("repo499", big), ["/r/repo499"]);
});
