#!/usr/bin/env python3
"""hub-queue.py --project P [--change C] [--hub URL] [--limit N]

Print the RUNNABLE task set for a hub-drain lane as one JSON object:
{"tasks":[{id,title,status,change,priority,tier,touches}]}, priority-sorted.
Runnable = status pending and every blockedBy id already completed.
Computed here, not by a model, so the drain's queue step is a copy of stdout.
Exits 0 with {"tasks":[]} and a stderr note on any failure so a transient hub
error is distinguishable (stderr) from a genuinely empty queue.
"""
import argparse, json, sys, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--project", required=True)
ap.add_argument("--change")
ap.add_argument("--hub", default="http://127.0.0.1:8050")
ap.add_argument("--limit", type=int, default=12)
a = ap.parse_args()

try:
    with urllib.request.urlopen(f"{a.hub}/tasks", timeout=15) as r:
        ts = json.load(r)
except Exception as e:  # noqa: BLE001
    print(f"hub-queue: fetch failed: {e}", file=sys.stderr)
    print(json.dumps({"tasks": [], "error": str(e)}))
    sys.exit(0)

m = [t for t in ts if t.get("project") == a.project
     and (not a.change or (t.get("metadata") or {}).get("change") == a.change)]
done = {t["id"] for t in m if t.get("status") == "completed"}
rank = {"P0": 0, "P1": 1, "P2": 2}

def md(t): return t.get("metadata") or {}

run = [t for t in m if t.get("status") == "pending"
       and all(b in done for b in (md(t).get("blockedBy") or []))]
run.sort(key=lambda t: rank.get(md(t).get("priority"), 9))
out = [{
    "id": t["id"],
    "title": (t.get("title") or "")[:160],
    "status": "pending",
    "change": md(t).get("change"),
    "priority": md(t).get("priority"),
    "tier": md(t).get("tier"),
    "touches": [str(p) for p in (md(t).get("touches") or [])][:20],
} for t in run[:a.limit]]
print(json.dumps({"tasks": out, "runnable": len(run), "pending": sum(1 for t in m if t.get("status") == "pending")}))
