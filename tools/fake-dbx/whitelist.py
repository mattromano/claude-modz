#!/usr/bin/env python3
"""A stand-in for the YAML whitelist PreToolUse hook: rcm_prod is select-only."""

import json
import re
import sys

event = json.load(sys.stdin)
sql = str((event.get("tool_input") or {}).get("statement", ""))
writes = re.compile(r"\b(insert\s+into|insert\s+overwrite|merge\s+into|update|delete\s+from|create(\s+or\s+replace)?\s+table|drop\s+table|truncate\s+table|alter\s+table)\s+`?rcm_prod\b", re.I)
if writes.search(sql):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": "whitelist: rcm_prod is select-only (rule prod_readonly)",
    }}))
