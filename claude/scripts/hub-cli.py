#!/usr/bin/env python3
"""
hub-cli — drive the task-hub over plain HTTP when MCP tools aren't attached.

The hub's /mcp endpoint is stateless streamable-HTTP with JSON responses, so a
bare JSON-RPC POST is a complete MCP client. This wraps the three tools; reads
go through the plain GET endpoints. Loopback only — same trust model as the
MCP registration.

Usage:
  hub-cli.py fetch [--project P] [--change C] [--status S] [--id ID]
  hub-cli.py sync <id> <title> [--project P] [--status S] [--metadata JSON]
  hub-cli.py sync-batch [--project P] < tasks.json   # [{id,title,metadata...}]
  hub-cli.py set-status <id> <status> [--notes TEXT]
  hub-cli.py status                                  # queue summary by project
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request

HUB = "http://127.0.0.1:8050"


def rpc(tool: str, arguments: dict):
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }).encode()
    req = urllib.request.Request(
        f"{HUB}/mcp", data=body, method="POST",
        headers={"Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        payload = json.load(resp)
    result = payload.get("result", {})
    content = result.get("content") or []
    texts = [c.get("text", "") for c in content if c.get("type") == "text"]
    if result.get("isError"):
        raise SystemExit(f"hub error: {' '.join(texts)}")
    if len(texts) == 1:
        try:
            return json.loads(texts[0])
        except json.JSONDecodeError:
            return texts[0]
    out = []
    for t in texts:
        try:
            out.append(json.loads(t))
        except json.JSONDecodeError:
            out.append(t)
    return out


def get(path: str):
    with urllib.request.urlopen(f"{HUB}{path}", timeout=15) as resp:
        return json.load(resp)


def main() -> int:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch")
    for flag in ("--project", "--change", "--status", "--id"):
        f.add_argument(flag)

    s = sub.add_parser("sync")
    s.add_argument("id"); s.add_argument("title")
    s.add_argument("--project"); s.add_argument("--status")
    s.add_argument("--metadata", help="JSON object")

    sb = sub.add_parser("sync-batch")
    sb.add_argument("--project")

    st = sub.add_parser("set-status")
    st.add_argument("id"); st.add_argument("status")
    st.add_argument("--notes")

    sub.add_parser("status")

    a = p.parse_args()

    if a.cmd == "fetch":
        args = {k: v for k, v in
                [("project", a.project), ("change", a.change),
                 ("status", a.status), ("id", a.id)] if v}
        print(json.dumps(rpc("fetch_tasks", args), indent=2))
    elif a.cmd == "sync":
        args = {"id": a.id, "title": a.title}
        if a.project: args["project"] = a.project
        if a.status: args["status"] = a.status
        if a.metadata: args["metadata"] = json.loads(a.metadata)
        print(json.dumps(rpc("sync_task", args), indent=2))
    elif a.cmd == "sync-batch":
        tasks = json.load(sys.stdin)
        ok, errs = 0, []
        for t in tasks:
            args = {"id": t["id"], "title": t["title"], "status": t.get("status", "pending")}
            proj = t.get("project") or a.project
            if proj: args["project"] = proj
            meta = {k: v for k, v in t.items()
                    if k not in ("id", "title", "status", "project") and v is not None}
            if "metadata" in meta: meta = meta["metadata"]
            if meta: args["metadata"] = meta
            try:
                rpc("sync_task", args); ok += 1
            except SystemExit as e:
                errs.append(f"{t['id']}: {e}")
        print(f"synced {ok}/{len(tasks)}")
        for e in errs: print(f"  FAILED {e}", file=sys.stderr)
        return 1 if errs else 0
    elif a.cmd == "set-status":
        args = {"id": a.id, "status": a.status}
        if a.notes: args["notes"] = a.notes
        print(json.dumps(rpc("update_task_status", args), indent=2))
    elif a.cmd == "status":
        health = get("/health")
        tasks = get("/tasks")
        print(f"hub: {health['status']} · {health['task_count']} tasks")
        by: dict[str, dict[str, int]] = {}
        for t in tasks:
            proj = t.get("project") or "—"
            by.setdefault(proj, {})
            by[proj][t["status"]] = by[proj].get(t["status"], 0) + 1
        for proj in sorted(by):
            counts = " ".join(f"{k}:{v}" for k, v in sorted(by[proj].items()))
            print(f"  {proj:<20} {counts}")
        blocked = [t for t in tasks if t["status"] == "blocked"]
        for t in blocked:
            notes = (t["metadata"].get("statusNotes") or [{}])[-1].get("note", "?")
            print(f"  BLOCKED {t['id']}: {notes}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
