"""Compares row counts and amounts between rcm_prod and rcm_dev charge inventory (aggregates only)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from databricks import sql  # noqa: E402

TABLE = "charges.fct_charge_inventory"

with sql.connect(server_hostname="fake", http_path="/sql/1.0/warehouses/fake") as conn, conn.cursor() as cur:
    totals = {}
    for catalog in ("rcm_prod", "rcm_dev"):
        cur.execute(f"SELECT COUNT(*) AS n, ROUND(SUM(charge_amount), 2) AS amount FROM {catalog}.{TABLE} WHERE is_active = 1")
        totals[catalog] = cur.fetchone()
    cur.execute(
        f"SELECT COUNT(*) FROM rcm_prod.{TABLE} p LEFT JOIN rcm_dev.{TABLE} d USING (charge_id) WHERE d.charge_id IS NULL"
    )
    missing = cur.fetchone()[0]

(pn, pa), (dn, da) = totals["rcm_prod"], totals["rcm_dev"]
print(f"prod: {pn} rows, ${pa:,.2f}")
print(f"dev:  {dn} rows, ${da:,.2f}")
print(f"match rate: {dn / pn:.1%}; {missing} prod charges missing from dev")
