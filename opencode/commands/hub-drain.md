---
description: Drain queued hub tasks for a project across parallel lanes (worker → opus review → fix cycles → land). Usage: /hub-drain project=<repo-dir> [change=<id>] [maxTasks=N] [lanes=3] [laneOffset=0]
agent: hub-drain
---
Drain the hub with these arguments: $ARGUMENTS

Parse `project=`, `change=`, `maxTasks=`, `repo=`, `lanes=`, `laneOffset=`
from the line above and run the full hub-drain loop. Report the summary table
when the queue is empty or the cap is reached.
