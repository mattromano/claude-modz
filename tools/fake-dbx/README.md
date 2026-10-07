# fake-dbx

A local stand-in for Databricks, so dbx-trace can be tried with no workspace. It has three parts:

- **`server.py`**: an MCP server named `databricks` with an `execute_sql` tool (and `list_warehouses`, a non-SQL call). It runs SQL on SQLite with mock RCM data (`rcm_prod.charges.fct_charge_inventory`, `rcm_prod.ref.dim_payer`, rcm_dev copies; all synthetic) and answers in the Statement Execution API shape. Every statement is logged to its own `system.query.history`, so enrichment runs for real.
- **`python/databricks/sql`**: a fake SQL Connector for Python on the same warehouse. `examples/qa_compare.py` uses it.
- **`whitelist.py`**: a stand-in for the YAML whitelist PreToolUse hook. `rcm_prod` is select-only.

```bash
./try.sh            # interactive session wired to all of it; ask Claude to query rcm_prod / rcm_dev, then /dbx-trace
./try.sh --demo     # scripted headless run: reads, a dev write, a failure, a blocked prod delete, a Python script; opens the page
./try.sh --reset    # fresh warehouse, no traces
```

Everything it writes stays in `.state/` (gitignored): the warehouse, generated `mcp.json` / `settings.json`, and the demo project whose `.claude/dbx-trace/` holds the traces. The settings set dummy `workspace_host` / `workspace_id` values, so deep links are generated (they lead nowhere). `FAKE_DBX_USER`, `FAKE_DBX_LATENCY` (seconds, default 0.4) and `FAKE_DBX_WAREHOUSE` tune it.

It is a fake: SQLite runs the SQL after three-part names are mapped, and `MERGE` / `OPTIMIZE` / `ALTER` succeed as no-ops.
