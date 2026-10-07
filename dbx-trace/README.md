# dbx-trace

A flight recorder for what Claude does on Databricks. Every query, Python script and guardrail block from a session shows up inside Claude Code as it happens, in a panel beside the conversation. Each session also gets one self-contained HTML page, with deep links into the workspace.

- **Panel** (`/dbx-trace`): opens itself on a session's first Databricks action. It shows:
  - session totals and query-history status
  - a timeline (coloured cells in the terminal, a drawn chart in the desktop app)
  - guardrails: every block and every prod write
  - every action, newest first, with client time, server time and bytes read
  - tables touched, grouped by catalog

  Enter on any action opens its full SQL, error or block reason, tables, query-profile link and, for a script, the statements inferred from its run. `k` / `j` step through actions and `b` goes back.
- **Band** above the prompt: a compact view of the newest actions for when the panel is closed or the terminal is too narrow for it. It steps aside while the panel is up. Writes to `rcm_prod` are red, writes to `rcm_dev` green, and blocks amber.
- **Trace page** (`/dbx-trace page`): the same trace as one HTML file with no external assets: totals, a timeline, guardrails, a sortable and filterable actions table, a tables-touched graph and a reports list. It opens offline and can be attached to a PR.
- **Deep links**: each query links to its query-history profile and each table to Catalog Explorer. Claude also receives the links with each query result, so its replies can quote them.
- **Server-side numbers**: at the end of each turn the mod reads `system.query.history` and fills in server duration, bytes read and rows.

Nothing is added to your SQL. Statements reach Databricks exactly as Claude wrote them. They are tied back to the session by **who ran them and when**: `executed_by` (your Entra email) plus each call's time window.

## Use

| | |
| --- | --- |
| `/dbx-trace` | Open the panel |
| `/dbx-trace page` | Write the HTML page and open it in the browser |
| `/dbx-trace refresh` | Read query history now and update the panel and page |
| `/dbx-trace path` | Print where the trace and page are |
| `/dbx-trace hide` | Close the panel and hide the band (`/dbx-trace` brings them back) |
| `/dbx-trace clear` | Empty this session's trace |
| In the panel | `ctrl+x tab` to focus it, then ↑↓ and Enter to open an action; `b` back, `k` / `j` previous / next, `r` refresh history, `o` page |
| In the band | Enter on an action opens it in the panel; `p` panel, `o` page, `m` minimize |

The panel opens by itself only in an interactive session. On a terminal narrower than 144 columns it waits, and the band covers in the meantime. Asking for it with `/dbx-trace` opens it at any width. In fullscreen (`/tui fullscreen`) it docks beside the conversation; otherwise it sits above the prompt. If dbt-runs is also showing, the two bands stack.

## What is recorded

| Captured | How it is detected | How it is tied to query history |
| --- | --- | --- |
| `query`: SQL through the Databricks MCP | Tool name matches `mcp_tool_pattern` and carries SQL in one of `sql_arg_names` | By `statement_id` when the MCP returns one, otherwise by identical statement text within ±2 min |
| `script`: Python through Bash | A `python` / `uv run` / `poetry run` script whose source imports `databricks`, or inline `-c` code that does | Every statement you ran during the script's run (±5 s), marked as *inferred*, with `client_application` shown |
| `cli`: the `databricks` CLI | `databricks <subcommand>` at a command position | Same window match as scripts |
| `blocked` | Your whitelist PreToolUse hook (or any plugin) denied the call | Not run, so there is nothing in history; the page shows the rule and what Claude did next |

Each action is one line in `<project>/.claude/dbx-trace/<session>.jsonl`. The file is append-only: a `running` line is written when the call starts and a settled line when it ends. Query-history results are cached beside it in `<session>.enrich.json`, and the page is `<session>.html`. A `.gitignore` containing `*` is written into that folder, so traces can't be committed by accident.

**PHI.** Only SQL text, ids and counts are kept. Result rows, samples and cell values never reach the trace, the page or the history cache. Row counts are read from the response's count fields or its row-array length, never from the values.

### Reports (Phase 2 hook-in)

A report generator registers its pages in `<session>.reports.json` as `[{ "title": "...", "path": "...", "kind": "profile" }]`. The trace page lists them under Reports.

## Configure

Set the options in `/config` (or under `pluginConfigs["dbx-trace"].options` in `settings.json`):

| Option | Default | |
| --- | --- | --- |
| `workspace_host` | (blank) | e.g. `https://adb-1234567890123456.7.azuredatabricks.net`; deep links are left out until this is set |
| `workspace_id` | (blank) | Azure workspace id; links get `?o=<id>` |
| `user_email` | (blank: `current_user()`) | The identity `system.query.history` records as `executed_by` |
| `mcp_tool_pattern` | `^mcp__.*databricks.*__` | Regex matching the MCP tools that run SQL |
| `sql_arg_names` | `statement,query,sql,sql_query` | Argument names that carry the SQL |
| `enrich_tool` | (blank: the last SQL tool used) | Full tool name, e.g. `mcp__databricks__execute_sql`, for reading history in a session that only ran scripts |
| `prod_catalogs` / `dev_catalogs` | `rcm_prod` / `rcm_dev` | Catalogs drawn red and green |
| `enrich` | `true` | Read query history at the end of each turn |

The history read runs through the same MCP tool, as you (on behalf of you), so Unity Catalog grants apply. No tokens are stored anywhere.

## Checks on the work machine (Gates 1 and 2)

These were built against the test kit and could not be verified against a live workspace:

- [ ] **Tool names**: run `/mcp` and confirm the Databricks SQL tool matches `mcp_tool_pattern` and its SQL argument is listed in `sql_arg_names`.
- [ ] **Statement id**: does the MCP response include `statement_id`? (Check `statement_id` in the `.jsonl` after one query.) If not, matching falls back to statement text, which still works.
- [ ] **Async results**: if the MCP answers `PENDING` and needs a second poll tool, the row count may be missing from the trace (the history read still fills it in).
- [ ] **System tables**: `SELECT * FROM system.query.history LIMIT 1` works for you. If not, the band and page show "query history unavailable: …" until the DW team grants SELECT.
- [ ] **Columns**: the history read uses `statement_id, execution_status, total_duration_ms, read_bytes, produced_rows, compute.warehouse_id, error_message, client_application, start_time, end_time, statement_text, executed_by`.
- [ ] **Latency**: how long until a statement appears in history? Unmatched actions are retried at each turn end for 15 minutes; `/dbx-trace refresh` forces a read.
- [ ] **Deep links** on the Azure workspace: Catalog Explorer `/explore/data/<c>/<s>/<t>`, query history `/sql/history?queryId=<id>`, warehouse `/sql/warehouses/<id>`. The patterns live in `hooks/links.ts`.

## How it works

One `tool.call` hook sees each Databricks call before and after it runs. Times come from the clock, ids and counts from the result, and tables from the SQL (a regex reader in `hooks/sql.ts`: reads from `FROM`/`JOIN`/`USING`, writes from `INSERT`/`MERGE`/`UPDATE`/`DELETE`/`CREATE`/`COPY`/`ALTER`/`DROP`, with CTEs excluded). A `classic.PreToolUse` hook sits beneath it and reads your whitelist's verdict, so a block is recorded as `blocked` and not as a failure. At the end of each main-loop turn, outside the turn's own time, the mod reads query history once for the whole session window (its own query carries a `/* dbx-trace enrichment */` marker to exclude itself) and redraws the page.

## Develop

To try it without a workspace, `../tools/fake-dbx/try.sh` starts a session against a local fake Databricks (MCP warehouse with mock RCM data, a fake `databricks.sql`, a stand-in whitelist hook); `--demo` runs a scripted session and opens the page.

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .   # load this working copy for one session
```
