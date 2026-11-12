#!/usr/bin/env python3
"""hub-diff-guards.py [--staged | <git-range>] [--repo DIR] [--warn]

Cheap growth guards for agent-written code. Checks only what a diff ADDS, so
existing code is never flagged and each landing is held to the rule from now on.

  comment-history  an added source comment that cites task history (box/group
                   numbers, tasks.md/design.md, dates, "fix cycle"). History
                   belongs in the commit message.
  file-size        a source file over the line limit that this diff made more
                   than `fileGrowthSlack` lines longer, or a new file that
                   starts over the limit.
  data-in-git      an added data/result file (.json/.jsonl/.csv/.txt/.html) over
                   the data limit. Store it outside git and commit a manifest.

Exit 0 = clean, 1 = findings (0 with --warn), 2 = usage/git error. One line per
finding: `GUARD <kind> <path>[:<line>] <message>`.

Per-repo overrides in <repo>/.hub-guards.json, every key optional:
  {"maxFileLines": 800, "fileGrowthSlack": 20, "maxDataLines": 1500,
   "exclude": ["openspec/**", "docs/**"],          # skipped by every check
   "dataAllow": ["**/__fixtures__/**"],            # data-in-git exemptions
   "commentPatterns": ["..."],                     # replaces the defaults
   "off": ["file-size"]}                           # disable a check
"""
import argparse, fnmatch, json, os, re, subprocess, sys

SOURCE_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sh", ".css", ".go", ".rs"}
DATA_EXT = {".json", ".jsonl", ".csv", ".txt", ".html"}
HASH_COMMENT_EXT = {".py", ".sh"}
DEFAULT_EXCLUDE = ["openspec/**", "docs/**", "graft/**", "**/_generated/**", "**/node_modules/**",
                   "**/*.lock", "**/pnpm-lock.yaml", "**/package-lock.json"]
# Evidence is exempt until it moves out of git (the visual gate still commits it).
DEFAULT_DATA_ALLOW = ["openspec/changes/*/evidence/**", "**/package.json", "**/tsconfig*.json",
                      "**/__fixtures__/**", "**/fixtures/**"]
DEFAULT_COMMENT_PATTERNS = [
    r"\bbox(es)?\s+\d+(\.\d+)?",            # box 7.2, boxes 3.1-3.6
    r"\b(group|task|step)\s+\d+(\.\d+)?\b",  # group 14, task 5.7
    r"\bg\d{2}[a-z]?\b",                     # g33, g23d
    r"\b(tasks|design|proposal|reconciliation)\.md\b",
    r"\b20\d\d-\d\d-\d\d\b",                 # dated history
    r"\b(fix[- ]cycle|review fix|review finding)\b",
]


def git(repo, *args):
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, errors="replace")
    if r.returncode != 0:
        sys.stderr.write(r.stderr)
        sys.exit(2)
    return r.stdout


def matches(path, globs):
    return any(fnmatch.fnmatch(path, g) or fnmatch.fnmatch(path, g.replace("**/", "")) for g in globs)


def comment_text(line, ext):
    """The comment part of a source line, or None. Deliberately simple: a line
    comment, a block-comment line, or a trailing ` // ` comment."""
    s = line.strip()
    if ext in HASH_COMMENT_EXT:
        if s.startswith("#") and not s.startswith("#!"):
            return s
        return None
    if s.startswith(("//", "/*", "*")):
        return s
    i = line.find(" // ")
    if i >= 0 and "://" not in line[max(0, i - 6):i + 4]:
        return line[i:]
    return None


def added_lines(repo, diff_args):
    """→ {path: [(new_line_no, text), ...]} from a zero-context diff."""
    out = git(repo, "diff", "--unified=0", "--no-color", "--diff-filter=AM",
              "--src-prefix=a/", "--dst-prefix=b/", *diff_args)  # fixed prefixes: diff.mnemonicPrefix changes them
    res, path, n = {}, None, 0
    for line in out.splitlines():
        if line.startswith("+++ "):
            path = line[6:] if line.startswith("+++ b/") else None
        elif line.startswith("@@"):
            m = re.search(r"\+(\d+)", line)
            n = int(m.group(1)) if m else 0
        elif path and line.startswith("+") and not line.startswith("+++"):
            res.setdefault(path, []).append((n, line[1:]))
            n += 1
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("range", nargs="?", help="git range, e.g. <base>..HEAD")
    ap.add_argument("--staged", action="store_true", help="check the staged diff")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--warn", action="store_true", help="report but exit 0")
    a = ap.parse_args()
    if a.staged == bool(a.range):
        ap.error("give exactly one of --staged or a git range")
    repo = a.repo
    diff_args = ["--cached"] if a.staged else [a.range]

    cfg = {}
    cfg_path = os.path.join(repo, ".hub-guards.json")
    if os.path.isfile(cfg_path):
        try:
            cfg = json.load(open(cfg_path))
        except ValueError as e:
            print(f"GUARD config .hub-guards.json is not valid JSON: {e}")
            sys.exit(0 if a.warn else 1)
    off = set(cfg.get("off", []))
    exclude = DEFAULT_EXCLUDE + cfg.get("exclude", [])
    data_allow = DEFAULT_DATA_ALLOW + cfg.get("dataAllow", [])
    max_file = int(cfg.get("maxFileLines", 800))
    max_data = int(cfg.get("maxDataLines", 1500))
    slack = int(cfg.get("fileGrowthSlack", 20))
    pats = [re.compile(p, re.I) for p in cfg.get("commentPatterns", DEFAULT_COMMENT_PATTERNS)]

    findings = []
    added = added_lines(repo, diff_args)

    if "comment-history" not in off:
        for path, lines in added.items():
            ext = os.path.splitext(path)[1]
            if ext not in SOURCE_EXT or matches(path, exclude):
                continue
            for n, text in lines:
                c = comment_text(text, ext)
                if not c:
                    continue
                hit = next((p for p in pats if p.search(c)), None)
                if hit:
                    findings.append(f"GUARD comment-history {path}:{n} comment cites task history "
                                    f"(\"{hit.search(c).group(0)}\"); explain the code, put history in the commit message")

    # numstat: added, deleted, path — for growth and for new data files
    stat = git(repo, "diff", "--numstat", "--diff-filter=AM", *diff_args)
    status = dict(reversed(l.split("\t", 1)) for l in
                  git(repo, "diff", "--name-status", "--diff-filter=AM", *diff_args).splitlines() if "\t" in l)
    for row in stat.splitlines():
        parts = row.split("\t")
        if len(parts) != 3 or parts[0] == "-":
            continue  # binary
        add, dele, path = int(parts[0]), int(parts[1]), parts[2]
        if matches(path, exclude):
            continue
        ext = os.path.splitext(path)[1]
        full = os.path.join(repo, path)
        if not os.path.isfile(full):
            continue
        if ext in SOURCE_EXT and "file-size" not in off and add > dele:
            total = sum(1 for _ in open(full, errors="replace"))
            is_new = status.get(path) == "A"
            if total > max_file and (is_new or add - dele > slack):
                what = "new file starts at" if is_new else f"file grew by {add - dele} to"
                findings.append(f"GUARD file-size {path} {what} {total} lines (limit {max_file}); "
                                f"split it or move the new code to its own module")
        if ext in DATA_EXT and "data-in-git" not in off and not matches(path, data_allow) and add > max_data:
            findings.append(f"GUARD data-in-git {path} adds {add} lines of data (limit {max_data}); "
                            f"store it outside git and commit a small manifest")

    for f in findings:
        print(f)
    print(f"hub-diff-guards: {len(findings)} finding(s)" + (" (warn only)" if a.warn and findings else ""))
    sys.exit(0 if (a.warn or not findings) else 1)


if __name__ == "__main__":
    main()
