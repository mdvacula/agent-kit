---
description: Task Hub queue overview — counts by project/change, blocked tasks with reasons, stale claims.
---
Hub status as of now:

!`python3 ~/.config/opencode/scripts/hub/hub-cli.py status 2>&1 || curl -s http://127.0.0.1:8050/health`

Summarize it per the `hub-status` skill (load it with
`skill({ name: "hub-status" })` if you need the drill-down steps): a compact
table of counts grouped project → change, then blocked tasks with their latest
statusNotes reason, then stale in-progress claims (>2 h). Remind me that the
live view is http://taskhub.local/ui and its Specs screen shows changes
pending review. $ARGUMENTS
