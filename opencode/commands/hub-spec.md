---
description: Agentic spec development for an idea → reviewed OpenSpec artifacts on disk (no hub sync). Usage: /hub-spec project=<repo-dir> idea="<one sentence>" [changeId=<id>]
agent: hub-spec
---
Run the hub-spec pipeline with these arguments: $ARGUMENTS

Parse `project=`, `idea=`, `changeId=` (optional), `repo=` (optional) from
the line above; if `project` or `idea` is missing, ask once and stop.
