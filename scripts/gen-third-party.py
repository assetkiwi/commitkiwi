#!/usr/bin/env python3
"""Write THIRD-PARTY-LICENSES.md: every third-party crate and npm package that ships in commit.kiwi, with its
licence texts (each distinct text once).

Rust: crates reachable over normal (not dev/build) dependency edges from the shipped binaries, per target
(`cargo metadata --filter-platform`): commitkiwi-app on aarch64-apple-darwin, commitkiwi-agent on
{x86_64,aarch64}-unknown-linux-musl. Texts come from the crate sources in the cargo registry.
npm: `pnpm licenses list --prod --json` in app/, plus the Svelte runtime (a dev dependency compiled into the bundle).

Stdlib only, offline, deterministic (run it twice: identical output). Usage: scripts/gen-third-party.py [--check]
--check exits 1 when the file on disk differs from what would be written.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "THIRD-PARTY-LICENSES.md"
TARGETS = [
    ("aarch64-apple-darwin", "commitkiwi-app"),
    ("x86_64-unknown-linux-musl", "commitkiwi-agent"),
    ("aarch64-unknown-linux-musl", "commitkiwi-agent"),
]
# compiled into the UI bundle although they are dev dependencies (the Svelte compiler emits imports of its runtime)
BUNDLED_DEV = ["svelte", "clsx", "esm-env", "devalue"]
LICENSE_FILE = re.compile(r"^(licen[cs]e|copying|unlicense|notice)([-._].*)?$", re.I)

MPL_NOTE = "MPL-2.0: used unmodified; its source code is available from crates.io (https://crates.io/crates/{})."
NOTES = {
    "option-ext": MPL_NOTE.format("option-ext"),
    "selectors": MPL_NOTE.format("selectors"),
    "llama-cpp-sys-2": "Bundles the llama.cpp/ggml sources (MIT, the ggml authors), compiled into the app, and the "
                       "vendored libraries llama.cpp's `common` library uses; their licence texts are included.",
    "webpki-roots": "CDLA-Permissive-2.0: the Mozilla root certificate data.",
    "webpki-root-certs": "CDLA-Permissive-2.0: the Mozilla root certificate data.",
}


def run(cmd, cwd=ROOT):
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True).stdout


def clean(text):
    lines = [l.rstrip() for l in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return "\n".join(lines).strip("\n")


def license_files(folder):
    folder = Path(folder)
    return sorted(p for p in folder.iterdir() if p.is_file() and LICENSE_FILE.match(p.name))


def rel(path, base):
    return str(Path(path).relative_to(base))


# ---------------------------------------------------------------- Rust
def rust_packages():
    found = {}
    for triple, root in TARGETS:
        meta = json.loads(run(["cargo", "metadata", "--format-version", "1", "--offline", "--filter-platform", triple]))
        pkgs = {p["id"]: p for p in meta["packages"]}
        members = set(meta["workspace_members"])
        nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
        start = next(i for i in members if pkgs[i]["name"] == root)
        seen, todo = set(), [start]
        while todo:
            cur = todo.pop()
            if cur in seen:
                continue
            seen.add(cur)
            for d in nodes[cur]["deps"]:
                if any(k["kind"] is None for k in d["dep_kinds"]):
                    todo.append(d["pkg"])
        for i in sorted(seen - members):
            p = pkgs[i]
            found[(p["name"], p["version"])] = p
    return found


def rust_texts(p):
    folder = Path(p["manifest_path"]).parent
    files = license_files(folder)
    if p.get("license_file"):
        lf = folder / p["license_file"]
        if lf.is_file() and lf not in files:
            files.append(lf)
    out = [(rel(f, folder), f.read_text(errors="replace")) for f in files]
    if p["name"] == "llama-cpp-sys-2":
        lc = folder / "llama.cpp"
        out.append(("llama.cpp/LICENSE", (lc / "LICENSE").read_text()))
        for f in sorted((lc / "vendor").rglob("*")):
            if f.is_file() and LICENSE_FILE.match(f.name):
                out.append((rel(f, folder), f.read_text(errors="replace")))
        hdr = lc / "vendor" / "nlohmann" / "json.hpp"
        if hdr.is_file():
            m = re.search(r"SPDX-FileCopyrightText: (.+)", hdr.read_text(errors="replace"))
            holder = m.group(1).strip() if m else "Niels Lohmann"
            out.append(("llama.cpp/vendor/nlohmann/json.hpp (SPDX: MIT)", mit_text(f"Copyright (c) {holder}")))
    return out


def rust_source(p):
    return p.get("repository") or p.get("homepage") or f"https://crates.io/crates/{p['name']}/{p['version']}"


# ---------------------------------------------------------------- npm
def npm_packages():
    app = ROOT / "app"
    data = json.loads(run(["pnpm", "licenses", "list", "--prod", "--json"], cwd=app))
    found = {}
    for spdx, entries in data.items():
        for e in entries:
            for ver, path in zip(e["versions"], e["paths"]):
                found[(e["name"], ver)] = (e.get("license") or spdx, Path(path))
    svelte = (app / "node_modules" / "svelte").resolve()
    for name in BUNDLED_DEV:
        path = svelte if name == "svelte" else (svelte.parent / name).resolve()
        pj = json.loads((path / "package.json").read_text())
        found[(pj["name"], pj["version"])] = (pj.get("license", "UNKNOWN"), path)
    return found


def npm_source(path):
    pj = json.loads((path / "package.json").read_text())
    repo = pj.get("repository")
    if isinstance(repo, dict):
        repo = repo.get("url")
    url = repo or pj.get("homepage") or f"https://www.npmjs.com/package/{pj['name']}/v/{pj['version']}"
    url = re.sub(r"^git\+", "", url)
    url = re.sub(r"^git://", "https://", url)
    if re.match(r"^[\w.-]+/[\w.-]+$", url):
        url = f"https://github.com/{url}"
    return re.sub(r"\.git$", "", url)


# ---------------------------------------------------------------- fallbacks
def mit_text(copyright_line):
    return (ROOT / "LICENSE-MIT").read_text().replace("Copyright (c) 2026 The commit.kiwi contributors", copyright_line)


def apache_text():
    return (ROOT / "LICENSE-APACHE").read_text().split("\n", 2)[2]  # without our own copyright line


def fallback(name, spdx, authors):
    """Standard text for a package that ships no licence file; None when there is none to use."""
    ids = set(re.findall(r"[A-Za-z0-9.+-]+", spdx or "")) - {"OR", "AND", "WITH"}
    if "MIT" in ids:
        who = ", ".join(authors) if authors else f"the {name} authors"
        return "standard MIT text", mit_text(f"Copyright (c) {who}")
    if "Apache-2.0" in ids:
        return "standard Apache-2.0 text", apache_text()
    if "BSD-3-Clause" in ids:
        who = ", ".join(authors) if authors else f"the {name} authors"
        return "standard BSD-3-Clause text", BSD3.format(who=who)
    if "MPL-2.0" in ids and MPL:
        return "MPL-2.0 text", MPL[0]
    return None


BSD3 = """Copyright (c) {who}

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following
   disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following
   disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote
   products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE."""
MPL = []  # the full MPL-2.0 text, taken from a crate that ships it (filled in main)


# ---------------------------------------------------------------- output
def main():
    rows, texts, exceptions, missing = [], {}, [], []

    def add(kind, name, ver, spdx, source, found, authors):
        label = f"{name} {ver}"
        if not found:
            fb = fallback(name, spdx, authors)
            if fb is None:
                missing.append(label)
            else:
                exceptions.append(f"{kind} `{label}` ({spdx}) ships no licence file: the {fb[0]} is listed for it.")
                found = [(fb[0], fb[1])]
        for fname, t in found:
            texts.setdefault(clean(t), set()).add(f"{label} ({fname})")
        rows.append((kind, name, ver, spdx or "UNKNOWN", source))

    crates = rust_packages()
    MPL.extend(clean(txt) for _, p in sorted(crates.items()) if p.get("license") == "MPL-2.0"
               for _, txt in rust_texts(p) if "Mozilla Public License Version 2.0" in txt[:200])
    for (name, ver), p in sorted(crates.items()):
        add("crate", name, ver, p.get("license") or (f"see {p['license_file']}" if p.get("license_file") else None),
            rust_source(p), rust_texts(p), [re.sub(r"\s*<[^>]*>", "", a) for a in p.get("authors", [])])
    for (name, ver), (spdx, path) in sorted(npm_packages().items()):
        found = [(f.name, f.read_text(errors="replace")) for f in license_files(path)]
        add("npm", name, ver, spdx, npm_source(path), found, [])

    if missing:
        sys.exit("no licence text for: " + ", ".join(missing))

    crates = sum(1 for r in rows if r[0] == "crate")
    out = [
        "# Third-party licences",
        "",
        "commit.kiwi is licensed under MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`). It includes the",
        f"third-party software listed here: {crates} Rust crates and {len(rows) - crates} npm packages, each under its own",
        "licence. Each distinct licence text follows the table once, with the packages it belongs to.",
        "",
        "Generated by `scripts/gen-third-party.py` from `cargo metadata` (shipped targets: "
        + ", ".join(f"`{r}` for `{t}`" for t, r in TARGETS) + ") and `pnpm licenses list --prod`; do not edit by hand.",
        "",
        "The optional commit message models are not part of commit.kiwi: they are downloaded on request from Hugging",
        "Face under their own licences (see each model card).",
        "",
        "## Packages",
        "",
        "| Kind | Name | Version | Licence (SPDX) | Source |",
        "|---|---|---|---|---|",
    ]
    out += [f"| {k} | {n} | {v} | {s} | {u} |" for k, n, v, s, u in rows]
    notes = sorted((n, t) for n, t in NOTES.items() if any(r[1] == n for r in rows))
    if notes or exceptions:
        out += ["", "## Notes", ""]
        out += [f"- `{n}`: {t}" for n, t in notes]
        out += [f"- {e}" for e in sorted(exceptions)]
    out += ["", "## Licence texts"]
    groups = sorted(texts.items(), key=lambda kv: (-len(kv[1]), sorted(kv[1])[0]))
    for i, (text, users) in enumerate(groups, 1):
        out += ["", f"### Text {i}", "", "Used by: " + ", ".join(sorted(users)) + ".", "", "````text", text, "````"]
    result = "\n".join(out) + "\n"

    if "--check" in sys.argv:
        sys.exit(0 if OUT.is_file() and OUT.read_text() == result else 1)
    OUT.write_text(result)
    print(f"{OUT.name}: {crates} crates, {len(rows) - crates} npm packages, {len(groups)} distinct texts, "
          f"{len(exceptions)} fallbacks")
    for e in sorted(exceptions):
        print("  fallback:", e)


if __name__ == "__main__":
    main()
