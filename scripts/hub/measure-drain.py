#!/usr/bin/env python3
"""measure-drain.py --project P [--since YYYY-MM-DD] [--role worker|reviewer|all] [--json]

Per-agent cost/effort metrics for hub drains, read from Claude Code subagent
transcripts (~/.claude/projects/<dir>/*/subagents/**/agent-*.jsonl). Groups
workers/reviewers by whether they used Graft, so a before/after comparison
needs no instrumentation:

  reads     Read/Grep/Glob calls + read-only Bash (cat/sed/head/rg/grep/find/ls/git log|diff|show)
  graft     graft CLI / mcp__graft__ calls
  edits     Edit/Write/MultiEdit calls
  turns     assistant messages (model round-trips)
  in_tok    sum of input tokens over turns (uncached + cache-create + cache-read) — context consumed
  out_tok   output tokens
  wall_s    first → last timestamp

Roles come from the drain's prompt templates: "Run task <id>" (worker),
"Fix-cycle for task <id>" (fix), "Review task <id>" (reviewer), "Job X" (steward).
"""
from __future__ import annotations
import argparse, glob, json, os, re, statistics, sys
from datetime import datetime, timezone

READ_BASH = re.compile(r"^\s*(?:cd\s+\S+\s*&&\s*)?(cat|sed|head|tail|less|ls|rg|grep|find|wc|tree|jq|git\s+(?:log|diff|show|status|blame|rev-parse))\b")
GRAFT_BASH = re.compile(r"(?:^|&&|;|\|)\s*(?:npx\s+(?:-y\s+)?(?:@nanonets/)?)?graft\s+(ask|skeleton|callers|map|grep|check|build)\b")
ROLE = [("Run task ", "worker"), ("Fix-cycle for task ", "fix"), ("Review task ", "reviewer"), ("Job ", "steward")]
TASK_RE = re.compile(r"^(?:Run task|Fix-cycle for task|Review task) (\S+)")

def first_user_text(recs):
    for d in recs:
        if d.get("type") != "user": continue
        c = (d.get("message") or {}).get("content")
        if isinstance(c, str): return c
        if isinstance(c, list):
            t = " ".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
            if t.strip(): return t
    return ""

def analyze(path):
    recs = []
    for line in open(path, encoding="utf-8", errors="replace"):
        try: recs.append(json.loads(line))
        except Exception: pass
    prompt = first_user_text(recs)
    role = next((r for p, r in ROLE if prompt.startswith(p)), "other")
    m = TASK_RE.match(prompt)
    out = {"file": path, "role": role, "task": m.group(1) if m else None, "reads": 0, "graft": 0, "edits": 0,
           "tools": 0, "turns": 0, "in_tok": 0, "out_tok": 0, "model": None, "start": None, "end": None}
    for d in recs:
        ts = d.get("timestamp")
        if ts:
            out["start"] = out["start"] or ts; out["end"] = ts
        if d.get("type") != "assistant": continue
        msg = d.get("message") or {}
        out["turns"] += 1
        out["model"] = msg.get("model") or out["model"]
        u = msg.get("usage") or {}
        out["in_tok"] += (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0)
        out["out_tok"] += u.get("output_tokens") or 0
        for x in msg.get("content") or []:
            if not (isinstance(x, dict) and x.get("type") == "tool_use"): continue
            out["tools"] += 1
            name = x.get("name", ""); inp = x.get("input") or {}
            if name in ("Read", "Grep", "Glob"): out["reads"] += 1
            elif name in ("Edit", "Write", "MultiEdit"): out["edits"] += 1
            elif name.startswith("mcp__graft__"): out["graft"] += 1
            elif name == "Bash":
                cmd = inp.get("command", "") or ""
                if GRAFT_BASH.search(cmd): out["graft"] += 1
                elif READ_BASH.match(cmd): out["reads"] += 1
    if out["start"] and out["end"]:
        f = datetime.fromisoformat(out["start"].replace("Z", "+00:00")); l = datetime.fromisoformat(out["end"].replace("Z", "+00:00"))
        out["wall_s"] = round((l - f).total_seconds())
    else:
        out["wall_s"] = None
    return out

def summarize(rows, key):
    vals = [r[key] for r in rows if r.get(key) is not None]
    if not vals: return "—"
    return f"{statistics.median(vals):.0f} / {statistics.mean(vals):.0f}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True, help="repo dir name under ~/code (transcripts in ~/.claude/projects/-home-mdv-code-<project>)")
    ap.add_argument("--since", help="YYYY-MM-DD (UTC) — only transcripts starting on/after this date")
    ap.add_argument("--role", default="all")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    base = os.path.expanduser(f"~/.claude/projects/-home-mdv-code-{a.project}")
    files = glob.glob(f"{base}/*/subagents/**/agent-*.jsonl", recursive=True)
    rows = [analyze(f) for f in files]
    rows = [r for r in rows if r["role"] in ("worker", "fix", "reviewer") and r["turns"] > 0]
    if a.since: rows = [r for r in rows if r["start"] and r["start"][:10] >= a.since]
    if a.role != "all": rows = [r for r in rows if r["role"] == a.role]
    if a.json:
        json.dump(rows, sys.stdout, indent=1); return
    print(f"{a.project}: {len(rows)} agent runs" + (f" since {a.since}" if a.since else ""))
    print(f"{'role':9} {'graft?':7} {'n':>4}  {'reads med/mean':>15} {'graft':>7} {'edits':>7} {'turns':>9} {'in_tok(k)':>12} {'out_tok(k)':>11} {'wall_s':>9}")
    for role in ("worker", "fix", "reviewer"):
        for used in (False, True):
            g = [r for r in rows if r["role"] == role and (r["graft"] > 0) == used]
            if not g: continue
            k = lambda key: summarize(g, key)
            ktok = lambda key: (lambda v: "—" if v == "—" else v)(("{:.0f} / {:.0f}".format(statistics.median([r[key] for r in g]) / 1000, statistics.mean([r[key] for r in g]) / 1000)))
            print(f"{role:9} {'yes' if used else 'no':7} {len(g):>4}  {k('reads'):>15} {k('graft'):>7} {k('edits'):>7} {k('turns'):>9} {ktok('in_tok'):>12} {ktok('out_tok'):>11} {k('wall_s'):>9}")
    print("(median / mean per agent run)")

if __name__ == "__main__":
    main()
