import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_URL, badListItem, humanise, isHttpsUrl, newRequestUrl, parseRemote, providerFor, requestNoun, splitList, suggestBody, suggestTitle } from "./forge.ts";

test("parseRemote: https, ssh, scp-like, ports, nested groups, trailing .git and slashes", () => {
  assert.deepEqual(parseRemote("https://github.com/o/r.git"), { host: "github.com", path: "o/r", webBase: "https://github.com" });
  assert.deepEqual(parseRemote("https://user:pw@GitLab.Example.com:8443/g/sub/p.git/"), { host: "gitlab.example.com", path: "g/sub/p", webBase: "https://gitlab.example.com:8443" });
  assert.deepEqual(parseRemote("ssh://git@github.com:22/o/r.git"), { host: "github.com", path: "o/r", webBase: "https://github.com" });
  assert.deepEqual(parseRemote("git@gitlab.com:group/sub/repo.git"), { host: "gitlab.com", path: "group/sub/repo", webBase: "https://gitlab.com" });
  assert.deepEqual(parseRemote("github.com:o/r"), { host: "github.com", path: "o/r", webBase: "https://github.com" });
  assert.deepEqual(parseRemote("git://example.org/a/b/"), { host: "example.org", path: "a/b", webBase: "https://example.org" });
  assert.deepEqual(parseRemote("http://h:8080/a/b"), { host: "h", path: "a/b", webBase: "https://h:8080" });
  for (const bad of ["/srv/git/r.git", "file:///srv/r.git", "../r", "C:/x/y", "https://github.com/onlyone", "ext::sh -c x", ""]) assert.equal(parseRemote(bad), null, bad);
});

test("providerFor: known hosts, names, then the user's answer", () => {
  assert.equal(providerFor("github.com", {}), "github");
  assert.equal(providerFor("gitlab.com", {}), "gitlab");
  assert.equal(providerFor("gitlab.corp.example", {}), "gitlab");
  assert.equal(providerFor("github.corp.example", {}), "github");
  assert.equal(providerFor("git.example.com", {}), null);
  assert.equal(providerFor("git.example.com", { "git.example.com": "gitlab" }), "gitlab");
  assert.equal(providerFor("git.example.com", { "git.example.com": "bogus" }), null);
  assert.equal(requestNoun("github"), "Pull Request");
  assert.equal(requestNoun("gitlab"), "Merge Request");
  assert.equal(requestNoun(null), "Pull/Merge Request");
});

test("title and description prefill", () => {
  assert.equal(humanise("feature/d11-upgrade-C"), "D11 upgrade C");
  assert.equal(humanise("PROJ-4-add_login-form"), "PROJ-4 add login form");
  assert.equal(humanise("fix"), "Fix");
  const one = [{ subject: "Add login", body: "Because.\n\nMore." }];
  assert.equal(suggestTitle("feature/x", one), "Add login");
  assert.equal(suggestBody(one), "Because.\n\nMore.");
  const two = [{ subject: "Second", body: "" }, { subject: "First", body: "Why\n\nmore" }];
  assert.equal(suggestTitle("feature/login-page", two), "Login page");
  assert.equal(suggestBody(two), "- First\n  Why\n\n  more\n- Second");
  assert.equal(suggestTitle("topic", []), "Topic");
});

test("newRequestUrl: GitHub compare and GitLab new MR pages, percent-encoded", () => {
  const gh = parseRemote("git@github.com:o/r.git")!;
  assert.deepEqual(newRequestUrl("github", gh, "feature/x", "main", "Fix & test", "a b\n#1"),
    { url: "https://github.com/o/r/compare/main...feature/x?expand=1&title=Fix%20%26%20test&body=a%20b%0A%231", truncated: false });
  const gl = parseRemote("https://gitlab.example.com:8443/g/sub/p.git")!;
  assert.deepEqual(newRequestUrl("gitlab", gl, "feat", "main", "T", "B"), {
    url: "https://gitlab.example.com:8443/g/sub/p/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat&merge_request%5Btarget_branch%5D=main&merge_request%5Btitle%5D=T&merge_request%5Bdescription%5D=B",
    truncated: false,
  });
});

test("newRequestUrl caps the body so the URL stays under MAX_URL", () => {
  const gh = parseRemote("https://github.com/o/r")!;
  const r = newRequestUrl("github", gh, "x", "main", "T", "é".repeat(5000));
  assert.equal(r.truncated, true);
  assert.ok(r.url.length <= MAX_URL && r.url.length > MAX_URL - 10, String(r.url.length));
  assert.ok(decodeURIComponent(r.url.split("body=")[1]).startsWith("éé")); // never a broken escape
});

test("isHttpsUrl and the list helpers", () => {
  assert.ok(isHttpsUrl("https://github.com/o/r/pull/7"));
  for (const bad of ["http://x/y", "javascript:alert(1)", "https://x/ y", "file:///etc/passwd", "https://x/\"onclick", ""]) assert.ok(!isHttpsUrl(bad), bad);
  assert.deepEqual(splitList(" a, b ,,c "), ["a", "b", "c"]);
  assert.equal(badListItem(["@me", "org/team", "a.b-c"]), undefined);
  assert.equal(badListItem(["ok", "-x"]), "-x");
  assert.equal(badListItem(["a b"]), "a b");
});
