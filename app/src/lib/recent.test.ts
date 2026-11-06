import { test } from "node:test";
import assert from "node:assert/strict";
import { RECENT_MAX, addRecents, touchRecent, isGoneError } from "./recent.ts";

test("bulk add appends new repos once, keeps order and the cap", () => {
  const list = [{ location: "local", path: "/a" }, { location: "ssh:example-host", path: "/b" }];
  assert.deepEqual(addRecents(list, "local", ["/b", "/a", "/c", "/c"]), [...list, { location: "local", path: "/b" }, { location: "local", path: "/c" }]);
  const many = addRecents([], "local", Array.from({ length: 600 }, (_, i) => `/r${i}`));
  assert.equal(many.length, RECENT_MAX);
  assert.equal(many[0].path, "/r0");
});

test("opening moves a repo to the front", () => {
  const list = [{ location: "local", path: "/a" }, { location: "local", path: "/b" }];
  assert.deepEqual(touchRecent(list, { location: "local", path: "/b" }).map((r) => r.path), ["/b", "/a"]);
});

test("isGoneError matches a missing folder, not a network failure", () => {
  assert.ok(isGoneError("fatal: cannot change to '/x': No such file or directory"));
  assert.ok(isGoneError("fatal: not a git repository (or any of the parent directories): .git"));
  assert.ok(!isGoneError("ssh: connect to host example-host port 22: Connection timed out"));
});
