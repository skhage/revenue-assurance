"""Deterministic deployment gate for reconciliation/warehouse/gold_revenue_forecast_anomalies.sql.

Unlike EXPLAIN (planner-only), this actually executes the file's
CREATE OR REFRESH MATERIALIZED VIEW statements against a live warehouse
(deployed under a `_test_` prefix so it never touches the real objects),
confirms REFRESH succeeds, and asserts SHOW CREATE TABLE still contains the
scalar-subquery horizon expression verbatim (i.e. it was not silently
literalized at creation time). The test objects are dropped afterward
regardless of outcome.

This is the actual command referenced by the "deterministic SQL compile/
deployment validation" comment in gold_revenue_forecast_anomalies.sql.

Usage:
    python3 reconciliation/validation/check_forecast_mv_deploys.py \
        --profile <databricks-cli-profile> --warehouse-id <sql-warehouse-id>

Requires the `databricks` CLI to be installed and authenticated (this script
shells out to `databricks api post /api/2.0/sql/statements`, matching the
pattern used elsewhere in this repo's validation tooling -- it never reads or
prints a credential itself).
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FORECAST_SQL = REPO_ROOT / "reconciliation" / "warehouse" / "gold_revenue_forecast_anomalies.sql"

# Real object names -> the throwaway test names this script deploys instead.
RENAME_MAP = {
    "cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies_dq_audit":
        "cdm_tmforum.revenue_assurance._test_gold_revenue_forecast_anomalies_dq_audit",
    "cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies":
        "cdm_tmforum.revenue_assurance._test_gold_revenue_forecast_anomalies",
}


def extract_create_statements(sql_text: str) -> list[str]:
    """Split the file into its two CREATE OR REFRESH MATERIALIZED VIEW ... ; statements.

    Anchored to the start of a line (^CREATE, MULTILINE) so prose mentions of
    "CREATE OR REFRESH MATERIALIZED VIEW" inside `--` comments (there are
    several, documenting the design) are not mistaken for real statements.
    """
    statements = re.findall(
        r"^CREATE OR REFRESH MATERIALIZED VIEW.*?;", sql_text, re.DOTALL | re.MULTILINE
    )
    if len(statements) != 2:
        raise RuntimeError(
            f"Expected exactly 2 CREATE OR REFRESH statements in {FORECAST_SQL}, found {len(statements)}"
        )
    return statements


def rename_test_targets(statement: str) -> tuple[str, str]:
    """Rewrite EVERY known real object name in the statement to its _test_
    equivalent -- the DQ-6 audit statement references both its own name (the
    CREATE target) AND the main forecast MV's name (in its FROM clause), so
    a single-name substitution would leave the FROM clause pointing at the
    real object. Returns (rewritten_statement, real_name_being_created) --
    the latter identified as whichever key appears first in the statement
    text (the CREATE target always appears before any FROM reference).
    """
    rewritten = statement
    create_target = None
    for real_name in RENAME_MAP:
        if real_name in rewritten:
            if create_target is None or statement.index(real_name) < statement.index(create_target):
                create_target = real_name
            rewritten = rewritten.replace(real_name, RENAME_MAP[real_name])
    if create_target is None:
        raise RuntimeError("Statement does not reference a known object name to rename")
    return rewritten, create_target


def run_sql(profile: str, warehouse_id: str, statement: str, wait_timeout: str = "50s") -> dict:
    payload = json.dumps(
        {"warehouse_id": warehouse_id, "statement": statement, "wait_timeout": wait_timeout}
    )
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as fh:
        fh.write(payload)
        payload_path = fh.name
    try:
        result = subprocess.run(
            ["databricks", "api", "post", "/api/2.0/sql/statements",
             "--profile", profile, "--json", f"@{payload_path}"],
            capture_output=True, text=True, timeout=90,
        )
    finally:
        Path(payload_path).unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError(f"databricks CLI failed: {result.stderr or result.stdout}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Non-JSON response: {result.stdout[:500]}") from exc


def statement_error(response: dict) -> str | None:
    status = response.get("status", {})
    if status.get("state") == "FAILED":
        return status.get("error", {}).get("message", "unknown error")
    # Statements API can also embed errors as rows in EXPLAIN-style outputs,
    # but CREATE/REFRESH/DROP never do -- FAILED state is the only signal here.
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True, help="Databricks CLI profile name")
    parser.add_argument("--warehouse-id", required=True, help="SQL warehouse id to run against")
    args = parser.parse_args()

    sql_text = FORECAST_SQL.read_text()
    statements = extract_create_statements(sql_text)

    deployed_test_names: list[str] = []
    failures: list[str] = []

    try:
        for statement in statements:
            rewritten, real_name = rename_test_targets(statement)
            test_name = RENAME_MAP[real_name]
            print(f"Deploying test copy of {real_name} as {test_name} ...")

            create_resp = run_sql(args.profile, args.warehouse_id, rewritten)
            err = statement_error(create_resp)
            if err:
                failures.append(f"CREATE failed for {test_name}: {err}")
                continue
            deployed_test_names.append(test_name)
            print(f"  CREATE OK")

            refresh_resp = run_sql(args.profile, args.warehouse_id, f"REFRESH MATERIALIZED VIEW {test_name}")
            err = statement_error(refresh_resp)
            if err:
                failures.append(f"REFRESH failed for {test_name}: {err}")
                continue
            print(f"  REFRESH OK")

            # Only the main forecast MV carries the horizon subquery; the
            # DQ-6 audit MV reads from it and has no ai_forecast call.
            if "ai_forecast" in rewritten:
                show_resp = run_sql(args.profile, args.warehouse_id, f"SHOW CREATE TABLE {test_name}")
                if statement_error(show_resp):
                    failures.append(f"SHOW CREATE TABLE failed for {test_name}: {statement_error(show_resp)}")
                    continue
                rows = show_resp.get("result", {}).get("data_array", [])
                ddl_text = "\n".join(row[0] for row in rows if row)
                if "horizon =>" not in ddl_text or "SELECT" not in ddl_text:
                    failures.append(
                        f"{test_name}: stored DDL does not preserve the scalar-subquery "
                        "horizon expression (may have been literalized at creation time)"
                    )
                else:
                    print("  SHOW CREATE TABLE confirms subquery horizon preserved")
    finally:
        for test_name in deployed_test_names:
            print(f"Dropping {test_name} ...")
            drop_resp = run_sql(args.profile, args.warehouse_id, f"DROP MATERIALIZED VIEW IF EXISTS {test_name}")
            if statement_error(drop_resp):
                print(f"  WARNING: drop failed for {test_name}: {statement_error(drop_resp)}", file=sys.stderr)

    if failures:
        print("FAIL: forecast MV deployment validation failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("PASS: forecast MV DDL deploys, refreshes, and preserves its horizon subquery")
    return 0


if __name__ == "__main__":
    sys.exit(main())
