"""A fake Databricks SQL warehouse on SQLite, for trying dbx-trace without a workspace.

Three-part names (`rcm_prod.charges.fct_charge_inventory`) map to SQLite tables
(`rcm_prod__charges__fct_charge_inventory`). Every statement, failed ones included,
is logged to `system.query.history` with the columns dbx-trace reads, so its
enrichment runs end to end. All data is synthetic.
"""

from __future__ import annotations

import os
import random
import re
import sqlite3
import time
import uuid
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("FAKE_DBX_DB", HERE / ".state" / "warehouse.db"))
USER = os.environ.get("FAKE_DBX_USER", "matt.romano@example.org")
WAREHOUSE = os.environ.get("FAKE_DBX_WAREHOUSE", "4f2a9c81e0b3d7a1")
LATENCY = float(os.environ.get("FAKE_DBX_LATENCY", "0.4"))
CATALOGS = ("rcm_prod", "rcm_dev", "system")

NAME = re.compile(r"`?\b(" + "|".join(CATALOGS) + r")`?\.`?(\w+)`?\.`?(\w+)`?", re.I)
NO_OP = re.compile(r"^\s*(merge|optimize|alter|vacuum|analyze|grant|use)\b", re.I)
CREATE_OR_REPLACE = re.compile(r"^\s*create\s+or\s+replace\s+table\s+(\S+)\s+as\b", re.I)
HISTORY = "system__query__history"


def _table(m: re.Match) -> str:
    return f"{m.group(1)}__{m.group(2)}__{m.group(3)}".lower()


def _strip_comments(sql: str) -> str:
    return re.sub(r"/\*.*?\*/", " ", re.sub(r"--[^\n]*", " ", sql), flags=re.S).strip()


def translate(sql: str) -> str:
    """Databricks SQL to the SQLite this fake runs; good for the statements a demo uses."""
    out = NAME.sub(_table, _strip_comments(sql))
    describe = re.match(r"^\s*desc(?:ribe)?\s+(?:table\s+)?(?:extended\s+)?(\w+)\s*;?\s*$", out, flags=re.I)
    if describe:
        return f"SELECT name AS col_name, type AS data_type, '' AS comment FROM pragma_table_info('{describe.group(1)}')"
    out = re.sub(r"\bcompute\.warehouse_id\b", "warehouse_id", out, flags=re.I)
    out = re.sub(r"\bcurrent_date\(\)", "date('now')", out, flags=re.I)
    out = re.sub(r"\bcurrent_timestamp\(\)", "CURRENT_TIMESTAMP", out, flags=re.I)
    return out.rstrip().rstrip(";")


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    fresh = not DB_PATH.exists()
    conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    conn.create_function("unix_millis", 1, lambda x: x)
    conn.create_function("timestamp_millis", 1, lambda x: x)
    conn.create_function("current_user", 0, lambda: USER)
    if fresh:
        seed(conn)
    return conn


def seed(conn: sqlite3.Connection) -> None:
    rng = random.Random(7)
    payers = ["Aetna", "Cigna", "BCBS", "UnitedHealthcare", "Humana", "Medicare", "Medicaid", "Kaiser",
              "Anthem", "Molina", "Centene", "Self-pay"]
    conn.executescript(f"""
        CREATE TABLE {HISTORY} (
          statement_id TEXT PRIMARY KEY, executed_by TEXT, statement_text TEXT, execution_status TEXT,
          total_duration_ms INTEGER, read_bytes INTEGER, produced_rows INTEGER, warehouse_id TEXT,
          error_message TEXT, client_application TEXT, start_time INTEGER, end_time INTEGER);
        CREATE TABLE rcm_prod__ref__dim_payer (payer_id INTEGER PRIMARY KEY, payer_name TEXT, payer_type TEXT);
        CREATE TABLE rcm_prod__charges__fct_charge_inventory (
          charge_id INTEGER PRIMARY KEY, patient_key TEXT, payer_id INTEGER, service_date TEXT,
          cpt_code TEXT, charge_amount REAL, status TEXT, is_active INTEGER, is_test INTEGER);
    """)
    conn.executemany("INSERT INTO rcm_prod__ref__dim_payer VALUES (?,?,?)",
                     [(i + 1, p, "government" if p in ("Medicare", "Medicaid") else "commercial")
                      for i, p in enumerate(payers)])
    start = date(2026, 1, 1)
    rows = []
    for i in range(1, 5001):
        rows.append((
            i, f"P{rng.randint(10000, 99999)}", rng.randint(1, len(payers)),
            (start + timedelta(days=rng.randint(0, 270))).isoformat(),
            rng.choice(["99213", "99214", "93000", "80053", "36415", "71046"]),
            round(rng.uniform(40, 2400), 2), rng.choice(["open", "billed", "denied", "paid"]),
            1 if rng.random() > 0.08 else 0, 1 if rng.random() < 0.02 else 0,
        ))
    conn.executemany("INSERT INTO rcm_prod__charges__fct_charge_inventory VALUES (?,?,?,?,?,?,?,?,?)", rows)
    conn.executescript("""
        CREATE TABLE rcm_dev__charges__fct_charge_inventory AS
          SELECT * FROM rcm_prod__charges__fct_charge_inventory WHERE charge_id % 50 <> 0;
        CREATE TABLE rcm_dev__ref__dim_payer AS SELECT * FROM rcm_prod__ref__dim_payer;
    """)


def _read_bytes(conn: sqlite3.Connection, sqlite_sql: str) -> int:
    """A believable scan size: about 180 bytes per row of each table the statement names."""
    total = 0
    for name in set(re.findall(r"\b((?:rcm_prod|rcm_dev|system)__\w+)", sqlite_sql)):
        try:
            total += conn.execute(f"SELECT count(*) FROM {name}").fetchone()[0] * 180
        except sqlite3.Error:
            pass
    return total


def _databricks_error(err: Exception) -> str:
    text = str(err)
    missing = re.match(r"no such table: (\w+?)__(\w+?)__(\w+)", text)
    if missing:
        c, s, t = missing.groups()
        return f"[TABLE_OR_VIEW_NOT_FOUND] The table or view `{c}`.`{s}`.`{t}` cannot be found."
    return f"[PARSE_SYNTAX_ERROR] {text}"


def execute(sql: str, client_application: str, warehouse_id: str | None = None) -> dict:
    """Runs one statement and answers the way the Statement Execution API does."""
    conn = connect()
    statement_id = str(uuid.uuid4())
    started = int(time.time() * 1000)
    translated = translate(sql)
    columns: list[str] = []
    data: list[list] = []
    error = None
    try:
        if NO_OP.match(translated):
            pass
        else:
            m = CREATE_OR_REPLACE.match(translated)
            if m:
                conn.execute(f"DROP TABLE IF EXISTS {m.group(1)}")
                translated = re.sub(r"^\s*create\s+or\s+replace\s+table", "CREATE TABLE", translated, flags=re.I)
            cur = conn.execute(translated)
            describe = re.match(r"SELECT name AS col_name\b.* pragma_table_info\('(\w+)'\)", translated)
            if describe and conn.execute(f"SELECT count(*) FROM pragma_table_info('{describe.group(1)}')").fetchone()[0] == 0:
                raise sqlite3.OperationalError(f"no such table: {describe.group(1)}")
            if cur.description:
                columns = [d[0] for d in cur.description]
                data = [list(r) for r in cur.fetchall()]
            elif cur.rowcount and cur.rowcount > 0:
                columns, data = ["num_affected_rows"], [[cur.rowcount]]
    except sqlite3.Error as err:
        error = _databricks_error(err)
    time.sleep(LATENCY * random.uniform(0.5, 2.0))
    ended = int(time.time() * 1000)
    conn.execute(
        f"INSERT INTO {HISTORY} VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (statement_id, USER, sql, "FAILED" if error else "FINISHED", ended - started,
         0 if error else _read_bytes(conn, translated), len(data), warehouse_id or WAREHOUSE,
         error, client_application, started, ended),
    )
    conn.close()
    if error:
        return {"statement_id": statement_id, "status": {"state": "FAILED", "error": {"message": error}}}
    return {
        "statement_id": statement_id,
        "status": {"state": "SUCCEEDED"},
        "manifest": {"schema": {"columns": [{"name": c} for c in columns]}, "total_row_count": len(data)},
        "result": {"data_array": data[:200]},
    }
