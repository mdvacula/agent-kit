---
description: Reconcile an OpenSpec change against the codebase, chunk + tier it, and sync tasks to the MCP Task Hub. Usage: /hub-plan project=<repo-dir> change=<change-id>
---
Load the `hub-plan` skill (`skill({ name: "hub-plan" })`) and follow it for:
$ARGUMENTS

`project=` is the repo directory name (the hub's project key); `change=` is
the `openspec/changes/<id>/` to plan. Present the §2 reconciliation audit and
wait for my go-ahead before syncing anything.
