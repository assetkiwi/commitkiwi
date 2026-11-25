//! What the model is asked, and what comes back. Pure: no model, no IO.
//!
//! Small models follow examples better than rules and forget rules in long prompts, so: the facts the model cannot
//! get wrong (file list, status, counts) come from git; the diff is trimmed to a budget; the style of the repository
//! is shown through its recent subjects; and the shape of the answer is enforced by a grammar, not by asking nicely.

/// One staged file. `status`: `A` added, `M` modified, `D` deleted, `R` renamed.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct FileChange {
    pub path: String,
    pub status: char,
    pub adds: Option<u32>,
    pub dels: Option<u32>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct Input {
    #[serde(default)]
    pub branch: Option<String>,
    /// Subjects of the latest commits, newest first.
    pub recent: Vec<String>,
    pub files: Vec<FileChange>,
    /// Unified diff text per file (`git diff --staged -- path`), in the order of `files`. May be shorter than `files`.
    pub patches: Vec<(String, String)>,
}

/// How the commit message should look.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Style {
    /// `type(scope): subject`; the default, and what a repository with such history keeps.
    Conventional,
    /// The repository has its own habit (`[PROJ-6]: Subject`, plain sentences): follow the recent subjects.
    Mimic,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompt {
    /// `(role, content)`, to be run through the model's own chat template.
    pub messages: Vec<(&'static str, String)>,
    /// GBNF the answer must follow.
    pub grammar: String,
    pub style: Style,
}

const TYPES: &[&str] = &["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"];
/// Characters of diff text in the prompt (about 3k tokens): a 1.5B model gets worse, not better, with more.
pub const DIFF_BUDGET: usize = 10_000;
const PER_FILE_MIN: usize = 600;
const PER_FILE_MAX: usize = 3_000;
const MAX_LISTED_FILES: usize = 40;

fn is_conventional(subject: &str) -> bool {
    let Some((head, rest)) = subject.split_once(": ") else { return false };
    let head = head.strip_suffix('!').unwrap_or(head);
    let ty = head.split('(').next().unwrap_or("");
    !rest.is_empty() && TYPES.contains(&ty) && (head == ty || (head.ends_with(')') && head.len() > ty.len() + 2))
}

/// Conventional unless at least half of the (non-merge) recent subjects show another habit.
pub fn detect_style(recent: &[String]) -> Style {
    let own: Vec<&String> = recent.iter().filter(|s| !s.starts_with("Merge ") && !s.trim().is_empty()).collect();
    if own.len() < 3 {
        return Style::Conventional;
    }
    if own.iter().filter(|s| is_conventional(s)).count() * 2 >= own.len() { Style::Conventional } else { Style::Mimic }
}

/// Files whose diff says nothing about intent: lock files, generated and minified output, vendored code, binaries.
pub fn is_noise(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    const NAMES: &[&str] = &["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "cargo.lock", "composer.lock", "gemfile.lock", "poetry.lock", "go.sum", "bun.lockb"];
    const SUFFIXES: &[&str] = &[".min.js", ".min.css", ".map", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".woff", ".woff2", ".snap", ".lock"];
    const DIRS: &[&str] = &["node_modules/", "vendor/", "dist/", "build/", "target/", ".next/"];
    NAMES.contains(&name) || SUFFIXES.iter().any(|s| name.ends_with(s)) || DIRS.iter().any(|d| lower.starts_with(d) || lower.contains(&format!("/{d}")))
}

/// Tests and documentation say less about what a commit is for than the code they accompany: they go last, so the
/// budget is spent on the code first and the model reads that first.
pub fn is_secondary(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    let orig = path.rsplit('/').next().unwrap_or(path); // case matters for PHPUnit's FooTest.php, not for Contest.php
    name.contains(".test.") || name.contains(".spec.") || name.ends_with("_test.go") || name.starts_with("test_") || orig.ends_with("Test.php") || orig.ends_with("Tests.php")
        || name == "tests.rs" || name.ends_with("_tests.rs") || name.ends_with(".md") || name.ends_with(".txt")
        || ["test/", "tests/", "e2e/", "__tests__/", "docs/", "spec/"].iter().any(|d| lower.starts_with(d) || lower.contains(&format!("/{d}")))
}

/// Cut `text` to about `max` bytes at a line end, saying how many lines were left out.
fn clip(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.trim_end().to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let cut = text[..end].rfind('\n').unwrap_or(end);
    let left = text[cut..].lines().filter(|l| !l.is_empty()).count();
    format!("{}\n[… {left} more lines]", text[..cut].trim_end())
}

/// The diff part of the prompt: noise dropped, every remaining file clipped to its share of `budget`, the rest of the
/// files named in one line.
pub fn trimmed_diff(patches: &[(String, String)], budget: usize) -> String {
    let mut useful: Vec<&(String, String)> = patches
        .iter()
        .filter(|(p, t)| !is_noise(p) && !t.trim().is_empty() && !t.contains("\nBinary files ") && !t.starts_with("Binary files "))
        .collect();
    useful.sort_by_key(|(p, _)| is_secondary(p)); // stable: git's order otherwise
    if useful.is_empty() {
        return String::new();
    }
    let share = (budget / useful.len()).clamp(PER_FILE_MIN, PER_FILE_MAX);
    let (mut out, mut used, mut shown) = (String::new(), 0usize, 0usize);
    for (path, text) in &useful {
        let part = clip(text, share);
        if shown > 0 && used + part.len() > budget {
            break;
        }
        out.push_str(&format!("### {path}\n{part}\n\n"));
        used += part.len();
        shown += 1;
    }
    if shown < useful.len() {
        let names: Vec<&str> = useful[shown..].iter().map(|(p, _)| p.as_str()).collect();
        out.push_str(&format!("[diff of {} more files left out: {}]\n", names.len(), names.join(", ")));
    }
    out.trim_end().to_string()
}

fn status_word(c: char) -> &'static str {
    match c {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        _ => "modified",
    }
}

fn file_line(f: &FileChange) -> String {
    match (f.adds, f.dels) {
        (Some(a), Some(d)) => format!("- {} ({}, +{a} -{d})", f.path, status_word(f.status)),
        _ => format!("- {} ({})", f.path, status_word(f.status)),
    }
}

/// The first line the prompt asks for: the subject after `type(scope): `, or the whole line in the other style.
pub const fn target(style: Style) -> usize {
    match style {
        Style::Conventional => 72,
        Style::Mimic => 90,
    }
}
/// What the grammar lets a first line run to. Loose on purpose: a model that overshoots finishes its sentence and is
/// asked to shorten it (`shorten_prompt`), instead of being cut wherever a tight cap happens to fall.
const CONV_SUBJECT_MAX: usize = 200;
const MIMIC_LINE_MAX: usize = 210;
/// What a shortened line may still run over `target` by (a small model counts characters badly).
const SLACK: usize = 15;

/// The lead of a first line, in chars: everything up to and including its first `: ` or ` - ` when that comes within
/// 30 characters (`type(scope): `, `[PROJ-6]: `, `chore/ai-models: `, `25464651 - `). 0 when there is none.
fn lead_len(head: &str) -> usize {
    [": ", " - "].iter().filter_map(|m| head.find(m).filter(|&i| head[..i].chars().count() <= 30).map(|i| head[..i + m.len()].chars().count())).min().unwrap_or(0)
}

/// What does not count towards `target`: the Conventional `type(scope): `. The other style counts the whole line.
fn prefix_len(head: &str, style: Style) -> usize {
    match style {
        Style::Conventional => lead_len(head),
        Style::Mimic => 0,
    }
}

fn subject_len(head: &str, style: Style) -> usize {
    head.chars().count().saturating_sub(prefix_len(head, style))
}

/// The first line of `text` when it is longer than the prompt asked for.
pub fn overlong(text: &str, style: Style) -> Option<&str> {
    let head = text.lines().next()?;
    (subject_len(head, style) > target(style)).then_some(head)
}

/// Whether a shortened first line is good enough: within `target` plus `SLACK`.
pub fn subject_fits(text: &str, style: Style) -> bool {
    text.lines().next().is_some_and(|h| subject_len(h, style) <= soft_max(style))
}

/// Back `text`'s first line up to a whole thought that fits when its subject is `max` long or more: cut at the last clause
/// break (", ", " and ", " or ", " to ", " with ") inside the limit, else at the last space inside it.
pub fn trim_overrun(text: &str, style: Style, max: usize) -> String {
    let (head, rest) = text.split_once('\n').unwrap_or((text, ""));
    if subject_len(head, style) < max {
        return text.to_string();
    }
    let window_end = head.char_indices().nth((prefix_len(head, style) + max).saturating_sub(1)).map_or(head.len(), |(i, _)| i);
    let window = &head[..window_end];
    let cut = [", ", " and ", " or ", " to ", " with "].iter().filter_map(|m| window.rfind(m)).max().or_else(|| window.rfind(' ')).unwrap_or(window.len());
    let head = head[..cut].trim_end_matches([',', ' ']);
    if rest.is_empty() { head.to_string() } else { format!("{head}\n{rest}") }
}

/// Ask the model to shorten one first line: it sees the whole line, so it can compress what it could not plan for.
/// The lead (`type(scope): `, `[PROJ-6]: `) is written into the grammar, so the model cannot change or drop it.
pub fn shorten_prompt(line: &str, style: Style, limit: usize) -> Prompt {
    let lead: String = line.chars().take(lead_len(line)).collect();
    let keep = if lead.is_empty() { "" } else { " The start of the line, up to and including its first `: ` or ` - `, stays exactly as it is." };
    let counted = if style == Style::Conventional && !lead.is_empty() { " Only the text after that start counts." } else { "" };
    let system = format!(
        "You shorten commit message subject lines. Rewrite the line so it is at most {limit} characters, in imperative mood, \
         with no trailing period.{keep}{counted} Keep the main change and drop secondary details; do not add anything new. \
         Answer with the shortened line only."
    );
    // no tight cap here: a cap hit mid-phrase is what this pass exists to avoid, and the answer must beat the input anyway
    let rest_max = line.chars().count().saturating_sub(lead.chars().count()).max(8);
    let lead = lead.replace('\\', "\\\\").replace('"', "\\\"");
    let grammar = format!("root ::= \"{lead}\" [^\\n]{{8,{rest_max}}}\n");
    Prompt { messages: vec![("system", system), ("user", line.to_string())], grammar, style }
}

/// Accept a shortened line only if it is a real shortening that kept the lead.
pub fn accept_shortened(old: &str, new: &str, style: Style) -> Option<String> {
    let new = clean(new)?;
    let new = new.lines().next()?.trim().to_string();
    let lead: String = old.chars().take(lead_len(old)).collect();
    (new.chars().count() < old.chars().count() && new.starts_with(&lead) && subject_len(&new, style) >= 8).then_some(new)
}

/// The most a shortened line may run to before the clause trim takes over.
pub const fn soft_max(style: Style) -> usize {
    target(style) + SLACK
}

/// GBNF for the answer: the first line and an optional bullet list as the body. The prompt asks for ≤ 72 (90) characters;
/// the cap here is looser, because a model that overshoots must finish its sentence, not be cut mid-phrase.
pub fn grammar(style: Style) -> String {
    let body = r#"body ::= "\n\n" bullet ("\n" bullet){0,5}
bullet ::= "- " [^\n]{4,100}
"#;
    match style {
        Style::Conventional => {
            let types = TYPES.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(" | ");
            format!("root ::= type scope? \"!\"? \": \" subject body?\ntype ::= {types}\nscope ::= \"(\" [a-z0-9_./-]{{1,24}} \")\"\nsubject ::= [^\\n]{{8,{CONV_SUBJECT_MAX}}}\n{body}")
        }
        // another habit: any first line, but still one line of sane length
        Style::Mimic => format!("root ::= subject body?\nsubject ::= [^\\n-] [^\\n]{{7,{}}}\n{body}", MIMIC_LINE_MAX - 1),
    }
}

pub fn build(input: &Input) -> Prompt {
    let style = detect_style(&input.recent);
    let rules = match style {
        Style::Conventional => format!(
            "Write one Conventional Commit message for the staged changes.\n\
             First line: type(scope): subject. Types: {}. The scope is optional (the area of the code, not a file path). \
             The subject is imperative, lowercase, has no trailing period and is at most 72 characters.\n\
             Add a body only when the change is more than trivial: a short list of lines starting with \"- \" saying what changed and why.",
            TYPES.join(", ")
        ),
        Style::Mimic => "Write one commit message for the staged changes, in exactly the style of the recent commits shown below \
             (same prefix or ticket format, same language, same capitalisation).\n\
             First line: at most 90 characters, imperative mood, no trailing period.\n\
             Add a body only when the change is more than trivial: a short list of lines starting with \"- \" saying what changed and why."
            .to_string(),
    };
    // the example only for the Conventional style: in the other one a conventional example would be copied over the repository's own habit
    let example = match style {
        Style::Conventional => "\n\nExample of a good answer:\nfix(auth): reject malformed email addresses\n\n- validate the address in UserService before saving\n- add tests for invalid addresses",
        Style::Mimic => "",
    };
    let system = format!("You write git commit messages. Reply with the commit message only: no explanation, no quotes, no code fences.\n{rules}{example}");

    let mut user = String::new();
    if let Some(b) = input.branch.as_deref().filter(|b| !b.is_empty() && *b != "HEAD") {
        user.push_str(&format!("Branch: {b}\n"));
    }
    let recent: Vec<&String> = input.recent.iter().filter(|s| !s.starts_with("Merge ")).take(5).collect();
    if !recent.is_empty() {
        user.push_str("Earlier commits of this repository (other changes: copy their format, never their content):\n");
        for s in recent {
            user.push_str(&format!("- {s}\n"));
        }
    }
    user.push_str("\nChanged files:\n");
    let mut files: Vec<&FileChange> = input.files.iter().collect();
    files.sort_by_key(|f| is_secondary(&f.path));
    for f in files.iter().take(MAX_LISTED_FILES) {
        user.push_str(&file_line(f));
        user.push('\n');
    }
    if input.files.len() > MAX_LISTED_FILES {
        user.push_str(&format!("- … and {} more files\n", input.files.len() - MAX_LISTED_FILES));
    }
    let diff = trimmed_diff(&input.patches, DIFF_BUDGET);
    if !diff.is_empty() {
        user.push_str(&format!("\nDiff:\n{diff}\n"));
    }
    user.push_str("\nWrite the commit message.");
    Prompt { messages: vec![("system", system), ("user", user)], grammar: grammar(style), style }
}

/// What the model said, made safe to put in the commit box: fences, quotes and a "Commit message:" lead removed,
/// blank lines collapsed. `None` when nothing usable is left.
pub fn clean(raw: &str) -> Option<String> {
    let mut s = raw.trim().to_string();
    // a thinking block some models emit first
    if let Some(i) = s.find("</think>") {
        s = s[i + "</think>".len()..].trim().to_string();
    }
    if s.starts_with("```") {
        s = s.trim_start_matches('`').trim_start_matches(|c: char| c.is_ascii_alphanumeric()).to_string();
    }
    s = s.trim_end_matches('`').trim().to_string();
    for lead in ["commit message:", "Commit message:", "Commit Message:"] {
        if let Some(rest) = s.strip_prefix(lead) {
            s = rest.trim().to_string();
        }
    }
    if s.len() > 2 && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\''))) {
        s = s[1..s.len() - 1].trim().to_string();
    }
    let lines: Vec<&str> = s.lines().map(str::trim_end).collect();
    let mut out = String::new();
    let mut blank = false;
    for l in lines {
        if l.is_empty() {
            blank = !out.is_empty();
            continue;
        }
        if blank {
            out.push_str("\n\n");
        } else if !out.is_empty() {
            out.push('\n');
        }
        blank = false;
        out.push_str(l);
    }
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subjects(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn style_follows_the_history() {
        assert_eq!(detect_style(&[]), Style::Conventional);
        assert_eq!(detect_style(&subjects(&["fix: a", "feat(x): b"])), Style::Conventional); // too little to judge
        assert_eq!(detect_style(&subjects(&["feat(ui): x", "fix: y", "Merge branch 'a'", "chore!: z"])), Style::Conventional);
        let own = subjects(&["[PROJ-6]: Show the full width of diff rows", "[PROJ-5]: Rename the settings page", "[PROJ-4]: Sidebar toggle", "Merge branch 'x'"]);
        assert_eq!(detect_style(&own), Style::Mimic);
        assert_eq!(detect_style(&subjects(&["Add search", "Fix typo", "Update readme"])), Style::Mimic);
        assert!(!is_conventional("feature: nope") && !is_conventional("fix(: x") && !is_conventional("fix:") && is_conventional("fix(a-b)!: x"));
    }

    #[test]
    fn noise_files_are_recognised() {
        for p in ["Cargo.lock", "app/pnpm-lock.yaml", "dist/app.min.js", "src/a.svg", "vendor/x/y.php", "web/node_modules/a/b.js", "a/b.snap", "composer.lock"] {
            assert!(is_noise(p), "{p}");
        }
        for p in ["src/lib.rs", "docs/lockdown.md", "src/vendored.rs", "app/build.rs", "README.md"] {
            assert!(!is_noise(p), "{p}");
        }
    }

    #[test]
    fn the_diff_is_clipped_to_the_budget_and_names_what_it_left_out() {
        let big = format!("@@ -1 +1 @@\n{}", "+line of code\n".repeat(2000));
        let patches: Vec<(String, String)> = (0..8).map(|i| (format!("src/f{i}.rs"), big.clone())).collect();
        let d = trimmed_diff(&patches, 6_000);
        assert!(d.len() < 6_000 + 1_500, "{}", d.len());
        assert!(d.contains("### src/f0.rs") && d.contains("more lines]"));
        assert!(d.contains("more files left out") && d.contains("src/f7.rs"));
        // noise and binaries never take budget
        let mixed = vec![
            ("Cargo.lock".to_string(), "+x\n".repeat(500)),
            ("img/a.bin".to_string(), "Binary files a/img/a.bin and b/img/a.bin differ\n".to_string()),
            ("src/a.rs".to_string(), "@@ -1 +1 @@\n-old\n+new\n".to_string()),
        ];
        let d = trimmed_diff(&mixed, 5_000);
        assert!(d.contains("### src/a.rs") && !d.contains("Cargo.lock") && !d.contains("a.bin"));
        assert_eq!(trimmed_diff(&[("Cargo.lock".into(), "+x".into())], 5_000), "");
    }

    #[test]
    fn an_overrun_first_line_is_backed_up_to_a_clause() {
        let line = "chore/ai-models: Update AI models to gpt-5.6-luna and gpt-image-2.5-flare, increase context length to 4000, and update";
        let cut = &line[..line.len() - 6];
        assert_eq!(
            trim_overrun(cut, Style::Mimic, cut.chars().count()),
            "chore/ai-models: Update AI models to gpt-5.6-luna and gpt-image-2.5-flare, increase context length to 4000"
        );
        assert_eq!(trim_overrun("fix: short subject", Style::Conventional, 110), "fix: short subject");
        // always lands inside the limit: the last break that fits, not the last break there is
        let t = trim_overrun("feat: add the first thing, add the second thing, add the third thing and the fourth", Style::Conventional, 40);
        assert_eq!(t, "feat: add the first thing");
        assert_eq!(trim_overrun("feat: aaaa bbbb cccc dddd eeee ffff", Style::Conventional, 12), "feat: aaaa bbbb");
    }

    #[test]
    fn only_a_line_over_the_target_is_shortened() {
        assert!(overlong("feat(ui): add a thing", Style::Conventional).is_none());
        let long = format!("feat(ui): {}", "word ".repeat(20));
        assert!(overlong(&long, Style::Conventional).is_some());
        assert!(overlong(&"x".repeat(91), Style::Mimic).is_some() && overlong(&"x".repeat(90), Style::Mimic).is_none());
    }

    #[test]
    fn a_shortening_must_be_shorter_and_keep_the_lead() {
        let old = "feat(ui): add the long thing and the other long thing";
        assert_eq!(accept_shortened(old, "feat(ui): add the long thing", Style::Conventional).as_deref(), Some("feat(ui): add the long thing"));
        assert!(accept_shortened(old, "fix(ui): add the long thing", Style::Conventional).is_none());
        assert!(accept_shortened(old, old, Style::Conventional).is_none());
    }

    #[test]
    fn the_shortening_grammar_pins_the_lead() {
        let g = shorten_prompt("[PROJ-6]: Do the first thing and then also do a second thing besides", Style::Mimic, 90).grammar;
        assert!(g.starts_with("root ::= \"[PROJ-6]: \" "), "{g}");
        assert!(shorten_prompt("25464651 - Update a thing and another thing and a third thing", Style::Mimic, 90).grammar.starts_with("root ::= \"25464651 - \" "));
        assert!(shorten_prompt("No lead here but a long enough sentence to shorten", Style::Mimic, 90).grammar.starts_with("root ::= \"\" "));
        assert!(shorten_prompt("feat(a\"b): quoted scope that is long enough to be shortened somehow", Style::Mimic, 90).grammar.contains("feat(a\\\"b): "));
    }

    #[test]
    fn clipping_keeps_utf8_and_whole_lines() {
        let t = "é".repeat(400) + "\nsecond line\nthird\n";
        let c = clip(&t, 301); // 301 falls inside a two-byte character
        assert!(c.starts_with('é') && c.contains("more lines]"));
        assert_eq!(clip("short\n", 100), "short");
    }

    #[test]
    fn the_prompt_carries_the_facts() {
        let input = Input {
            branch: Some("feature/PROJ-7".into()),
            recent: subjects(&["feat: a", "fix: b", "chore: c"]),
            files: vec![
                FileChange { path: "src/Service/UserService.php".into(), status: 'M', adds: Some(12), dels: Some(3) },
                FileChange { path: "tests/UserServiceTest.php".into(), status: 'A', adds: Some(30), dels: Some(0) },
                FileChange { path: "old.txt".into(), status: 'D', adds: None, dels: None },
            ],
            patches: vec![("src/Service/UserService.php".into(), "@@ -1 +1 @@\n-a\n+b\n".into())],
        };
        let p = build(&input);
        assert_eq!(p.style, Style::Conventional);
        let (sys, user) = (&p.messages[0].1, &p.messages[1].1);
        assert!(sys.contains("Conventional Commit") && sys.contains("Reply with the commit message only"));
        assert!(user.contains("Branch: feature/PROJ-7") && user.contains("- feat: a"));
        assert!(user.contains("- src/Service/UserService.php (modified, +12 -3)") && user.contains("- tests/UserServiceTest.php (added, +30 -0)") && user.contains("- old.txt (deleted)"));
        assert!(user.contains("### src/Service/UserService.php\n@@ -1 +1 @@") && user.ends_with("Write the commit message."));
        // code before tests in the file list
        assert!(user.find("- src/Service/UserService.php").unwrap() < user.find("- tests/UserServiceTest.php").unwrap());
        assert!(p.grammar.contains("type ::= \"feat\"") && p.grammar.contains("subject ::= [^\\n]{8,200}"));
        // a repository with its own habit is mimicked, and the grammar no longer forces a type
        let own = Input { recent: subjects(&["[PROJ-6]: One", "[PROJ-5]: Two", "[PROJ-4]: Three"]), ..Default::default() };
        let m = build(&own);
        assert_eq!(m.style, Style::Mimic);
        assert!(m.grammar.contains("subject ::= [^\\n-]") && m.messages[0].1.contains("exactly the style of the recent commits") && !m.grammar.contains("type ::=") && !m.messages[0].1.contains("fix(auth)"));
        // nothing to show: the prompt still stands
        assert!(build(&Input::default()).messages[1].1.contains("Changed files:"));
    }

    #[test]
    fn tests_and_docs_come_after_the_code() {
        for p in ["app/e2e/forge.mjs", "src/lib.test.ts", "tests/UserServiceTest.php", "docs/GUIDE.md", "README.md", "pkg/foo_test.go", "a/__tests__/x.js"] {
            assert!(is_secondary(p), "{p}");
        }
        for p in ["src/lib.rs", "app/src/App.svelte", "src/Service/Contest.php", "crates/core/src/latest.rs"] {
            assert!(!is_secondary(p), "{p}");
        }
        let patches = vec![("tests/a_test.rs".to_string(), "@@
+t
".to_string()), ("src/a.rs".to_string(), "@@
+c
".to_string())];
        let d = trimmed_diff(&patches, 5_000);
        assert!(d.find("### src/a.rs").unwrap() < d.find("### tests/a_test.rs").unwrap());
    }

    #[test]
    fn many_files_are_listed_up_to_a_cap() {
        let files = (0..55).map(|i| FileChange { path: format!("f{i}.rs"), status: 'M', adds: Some(1), dels: Some(1) }).collect();
        let user = build(&Input { files, ..Default::default() }).messages[1].1.clone();
        assert!(user.contains("- f39.rs") && !user.contains("- f40.rs") && user.contains("… and 15 more files"));
    }

    #[test]
    fn model_output_is_cleaned() {
        assert_eq!(clean("```\nfix: a thing\n```").as_deref(), Some("fix: a thing"));
        assert_eq!(clean("```text\nfix: a thing\n\n\n- one\n- two\n```").as_deref(), Some("fix: a thing\n\n- one\n- two"));
        assert_eq!(clean("Commit message: \"feat: add x\"").as_deref(), Some("feat: add x"));
        assert_eq!(clean("<think>\nhmm\n</think>\n\nfix: y").as_deref(), Some("fix: y"));
        assert_eq!(clean("fix: a\n\n\n\n- b  \n").as_deref(), Some("fix: a\n\n- b"));
        assert_eq!(clean("  \n"), None);
        assert_eq!(clean("```\n```"), None);
    }
}
