"""Static guard: the reconciliation SQL must not read simulator ground-truth
leakage columns as its detection signal.

Run: python3 reconciliation/validation/check_source_independence.py

This is a structural check, not a data check -- it inspects the SQL source
text so it can run offline without a warehouse. It complements
`reconciliation_control_fixes.sql`, which validates runtime behavior against
live data but can't prove "the query never reads column X".
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SILVER_RECON = REPO_ROOT / "reconciliation" / "pipelines" / "silver_reconciliation.sql"

FAILURES: list[str] = []


def check_price_reconciliation_independence(sql: str) -> None:
    """silver_contract_price_reconciliation must derive its flag from
    contracted_price vs billed_unit_price, not from cli.leakage_flag."""
    match = re.search(
        r"CREATE OR REFRESH MATERIALIZED VIEW silver_contract_price_reconciliation.*?"
        r"(?=CREATE OR REFRESH MATERIALIZED VIEW|\Z)",
        sql,
        re.DOTALL,
    )
    if not match:
        FAILURES.append("silver_contract_price_reconciliation view not found in silver_reconciliation.sql")
        return
    body = match.group(0)

    # The view is allowed to SELECT the ground-truth column (renamed
    # known_leakage_flag) for downstream metadata, but must not use it in a
    # WHEN/CASE/comparison to derive its own `leakage_flag` output.
    # Detect any comparison of known_leakage_flag (or the raw cli.leakage_flag)
    # against a literal inside a CASE/WHEN clause.
    forbidden = re.search(
        r"WHEN\s+(?:cl\.|cli\.|p\.)?(?:known_leakage_flag|leakage_flag)\s*=",
        body,
    )
    if forbidden:
        FAILURES.append(
            "silver_contract_price_reconciliation derives its flag from the "
            "ground-truth leakage column, not an independent price comparison: "
            f"{forbidden.group(0)!r}"
        )

    if "billed_unit_price" not in body:
        FAILURES.append(
            "silver_contract_price_reconciliation no longer references "
            "billed_unit_price -- the independent billed-side comparison "
            "appears to have been removed"
        )

    if "price_mismatch_pct" not in body:
        FAILURES.append(
            "silver_contract_price_reconciliation no longer computes "
            "price_mismatch_pct from the two independent price columns"
        )


def check_fx_validation_independence(sql: str) -> None:
    """silver_fx_rate_validation must compare an applied rate to the market
    rate, not hardcode 1.0."""
    match = re.search(
        r"CREATE OR REFRESH MATERIALIZED VIEW silver_fx_rate_validation.*?"
        r"(?=CREATE OR REFRESH MATERIALIZED VIEW|\Z)",
        sql,
        re.DOTALL,
    )
    if not match:
        FAILURES.append("silver_fx_rate_validation view not found in silver_reconciliation.sql")
        return
    body = match.group(0)

    if re.search(r"CONVERSION_RATE\s*-\s*1\.0", body) or re.search(r"1\.0\s*-\s*.*CONVERSION_RATE", body):
        FAILURES.append(
            "silver_fx_rate_validation still compares the market rate "
            "against a hardcoded 1.0 instead of an independently-applied rate"
        )

    if "APPLIED_EXCHANGE_RATE" not in body:
        FAILURES.append(
            "silver_fx_rate_validation does not reference "
            "APPLIED_EXCHANGE_RATE -- the applied-vs-market comparison "
            "appears to have been removed"
        )


def check_expired_quote_grain(sql_path: Path) -> None:
    gold_sql = (REPO_ROOT / "reconciliation" / "pipelines" / "gold_aggregation.sql").read_text()
    match = re.search(
        r"-- Expired quotes still active.*?(?=UNION ALL|\Z)", gold_sql, re.DOTALL
    )
    if not match:
        FAILURES.append("expired_quote_active union arm not found in gold_aggregation.sql")
        return
    body = match.group(0)
    if "SELECT DISTINCT" not in body:
        FAILURES.append(
            "gold_leakage_summary's expired_quote_active arm does not use "
            "SELECT DISTINCT -- it will over-count expired quotes at line grain"
        )


def main() -> int:
    sql = SILVER_RECON.read_text()
    check_price_reconciliation_independence(sql)
    check_fx_validation_independence(sql)
    check_expired_quote_grain(SILVER_RECON)

    if FAILURES:
        print("FAIL: source-independence checks failed:")
        for failure in FAILURES:
            print(f"  - {failure}")
        return 1

    print("PASS: all source-independence checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
