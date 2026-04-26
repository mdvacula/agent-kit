#!/usr/bin/env python3
"""Write pr-body.md into GITHUB_OUTPUT using a random delimiter."""

import sys
import secrets

out_file = sys.argv[1]
body_file = sys.argv[2]

body = open(body_file).read()
delim = "BODY_" + secrets.token_hex(32)

with open(out_file, "a") as f:
    f.write(f"body<<{delim}\n{body}\n{delim}\n")
