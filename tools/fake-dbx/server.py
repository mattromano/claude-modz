#!/usr/bin/env python3
"""A fake Databricks SQL MCP server over stdio (JSON-RPC, one message per line).

Tools: `execute_sql` (statement, warehouse_id?) runs against the fake warehouse;
`list_warehouses` is a non-SQL call, which dbx-trace should pass by unrecorded.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fakedbx import engine  # noqa: E402

TOOLS = [
    {
        "name": "execute_sql",
        "description": "Run a SQL statement on the Databricks SQL warehouse (Unity Catalog three-part names, "
        "e.g. rcm_prod.charges.fct_charge_inventory). Returns the statement id, schema and up to 200 rows.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "statement": {"type": "string", "description": "The SQL statement"},
                "warehouse_id": {"type": "string", "description": "Optional warehouse id"},
            },
            "required": ["statement"],
        },
    },
    {
        "name": "list_warehouses",
        "description": "List SQL warehouses",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def reply(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def call(name, args):
    if name == "list_warehouses":
        text = json.dumps({"warehouses": [{"id": engine.WAREHOUSE, "name": "rcm-dev-serverless", "state": "RUNNING"}]})
        return {"content": [{"type": "text", "text": text}], "isError": False}
    if name == "execute_sql":
        answer = engine.execute(str(args.get("statement", "")), "Databricks MCP (fake)", args.get("warehouse_id"))
        failed = answer["status"]["state"] == "FAILED"
        text = answer["status"]["error"]["message"] if failed else json.dumps(answer, default=str)
        return {"content": [{"type": "text", "text": text}], "isError": failed}
    return {"content": [{"type": "text", "text": f"unknown tool {name}"}], "isError": True}


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        msg = json.loads(line)
        method, id_ = msg.get("method"), msg.get("id")
        if id_ is None:
            continue  # a notification
        if method == "initialize":
            reply(id_, {
                "protocolVersion": msg.get("params", {}).get("protocolVersion", "2025-06-18"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "fake-databricks", "version": "0.1.0"},
            })
        elif method == "tools/list":
            reply(id_, {"tools": TOOLS})
        elif method == "tools/call":
            params = msg.get("params", {})
            reply(id_, call(params.get("name"), params.get("arguments") or {}))
        elif method == "ping":
            reply(id_, {})
        else:
            reply(id_, error={"code": -32601, "message": f"method not found: {method}"})


if __name__ == "__main__":
    main()
