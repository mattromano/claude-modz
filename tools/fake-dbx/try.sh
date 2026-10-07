#!/usr/bin/env bash
# Try dbx-trace against a fake Databricks: a local MCP warehouse with mock RCM data,
# a fake databricks.sql package, and a stand-in whitelist hook (rcm_prod is select-only).
#
#   ./try.sh [flags]    interactive session (extra flags go to claude); ask Claude to query rcm_prod / rcm_dev
#   ./try.sh --demo     scripted headless run, then opens the trace page
#   ./try.sh --reset    start over with a fresh warehouse and no traces
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MOD="$(cd "$HERE/../../dbx-trace" && pwd)"
STATE="$HERE/.state"
DEMO="$STATE/demo"

if [[ "${1:-}" == "--reset" ]]; then rm -rf "$STATE"; echo "Reset $STATE"; exit 0; fi

mkdir -p "$DEMO/jobs"
ln -sf "$HERE/examples/qa_compare.py" "$DEMO/jobs/qa_compare.py"
export FAKE_DBX_DB="$STATE/warehouse.db"

cat > "$STATE/mcp.json" <<JSON
{ "mcpServers": { "databricks": { "command": "python3", "args": ["$HERE/server.py"],
  "env": { "FAKE_DBX_DB": "$STATE/warehouse.db" } } } }
JSON

cat > "$STATE/settings.json" <<JSON
{
  "hooks": { "PreToolUse": [ { "matcher": "mcp__databricks__execute_sql",
    "hooks": [ { "type": "command", "command": "python3 '$HERE/whitelist.py'" } ] } ] },
  "pluginConfigs": { "dbx-trace": { "options": {
    "workspace_host": "https://adb-0000000000000000.0.azuredatabricks.net",
    "workspace_id": "0000000000000000" } } }
}
JSON

FLAGS=(--plugin-dir "$MOD" --mcp-config "$STATE/mcp.json" --strict-mcp-config --settings "$STATE/settings.json")
cd "$DEMO"

if [[ "${1:-}" != "--demo" ]]; then
  cat <<TXT
Fake Databricks is wired up in $DEMO
Try asking Claude, for example:
  - how many active charges are in rcm_prod.charges.fct_charge_inventory, by payer (join rcm_prod.ref.dim_payer)?
  - build rcm_dev.charges.stg_charge_inventory from the active prod rows
  - delete the test rows (is_test = 1) from rcm_prod.charges.fct_charge_inventory   <- the whitelist blocks this
  - run python3 jobs/qa_compare.py
The Databricks trace panel opens on the first action; /dbx-trace reopens it, /dbx-trace page opens the HTML.
TXT
  exec claude "${FLAGS[@]}" "$@"
fi

PROMPT='This is a local fake Databricks warehouse with synthetic data, set up to test a recorder plugin and our guardrail hook. Using the databricks MCP execute_sql tool, one statement per call:
1. Count active charges (is_active = 1) in rcm_prod.charges.fct_charge_inventory.
2. Show the top 5 payers by charge count, joining rcm_prod.ref.dim_payer on payer_id.
3. CREATE OR REPLACE TABLE rcm_dev.charges.stg_charge_inventory AS the active rows from rcm_prod.charges.fct_charge_inventory.
4. Count rows in rcm_dev.charges.stg_charge_invetory (spelled exactly like that; it is a deliberate typo to test failure capture).
5. Delete the test rows (is_test = 1) from rcm_prod.charges.fct_charge_inventory. A guardrail hook is expected to block this; do not retry or work around it.
Then run this exact Bash command: python3 jobs/qa_compare.py
Finish with a short summary, including any links you were given.'

# --allowedTools takes several values, so the prompt goes in on stdin.
printf '%s' "$PROMPT" | claude -p "${FLAGS[@]}" \
  --allowedTools "mcp__databricks__execute_sql" "Bash(python3 jobs/qa_compare.py)"

PAGE="$(ls -t "$DEMO/.claude/dbx-trace/"*.html 2>/dev/null | head -1 || true)"
if [[ -n "$PAGE" ]]; then
  echo; echo "Trace page: $PAGE"
  [[ -n "${NO_OPEN:-}" ]] || open "$PAGE" 2>/dev/null || xdg-open "$PAGE" 2>/dev/null || true
else
  echo "No trace page was written; see $DEMO/.claude/dbx-trace/" >&2
fi
