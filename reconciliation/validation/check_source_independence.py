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
DATA_SIM = REPO_ROOT / "data-sim" / "simulate_source_systems.py"

FAILURES: list[str] = []


def check_price_reconciliation_independence(sql: str) -> None:
    """silver_contract_price_reconciliation must derive its flag from
    contracted_price vs billed_unit_price, not from cli.leakage_flag, and
    must not select the simulator's leakage_flag/known_leakage_flag column
    at all (production silver/gold outputs must not carry it -- audit
    finding). It must also join 1:1 on the contract line's own immutable id
    (SOURCE_LINE_ITEM_ID), not the (circuit, contract) composite, which is
    not a candidate key."""
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

    # Detect any comparison of known_leakage_flag / leakage_flag against a
    # literal inside a CASE/WHEN clause -- deriving the check's own flag
    # from the ground-truth column instead of an independent comparison.
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

    # AUDIT FINDING: known_leakage_flag (the simulator's ground-truth marker,
    # selected via cli.leakage_flag AS known_leakage_flag) must not appear in
    # this view's SELECT list at all -- not even as informational metadata.
    if re.search(r"\bknown_leakage_flag\b", body):
        FAILURES.append(
            "silver_contract_price_reconciliation still selects/references "
            "known_leakage_flag -- the simulator's ground-truth leakage "
            "column must not reach any silver or gold reconciliation output"
        )
    if re.search(r"cli\.leakage_flag", body) or re.search(r"cl\.leakage_flag", body):
        FAILURES.append(
            "silver_contract_price_reconciliation still selects the "
            "simulator's raw leakage_flag column from contract_line_item"
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

    # ONE-TO-ONE JOIN: must join on SOURCE_LINE_ITEM_ID (the immutable
    # contract-line primary key), not the (SERVICE_CIRCUIT_ID,
    # SOURCE_CONTRACT_ID) composite, which is not guaranteed unique -- two
    # lines on the same contract can independently hash to the same circuit.
    if "billed.SOURCE_LINE_ITEM_ID" not in body and "SOURCE_LINE_ITEM_ID = cl.line_item_id" not in body:
        FAILURES.append(
            "silver_contract_price_reconciliation does not join "
            "ra_billed_circuit_rates on SOURCE_LINE_ITEM_ID -- the join may "
            "have reverted to the (SERVICE_CIRCUIT_ID, SOURCE_CONTRACT_ID) "
            "composite, which is many-to-many"
        )
    if re.search(r"billed\.SERVICE_CIRCUIT_ID\s*=\s*cl\.Service_Circuit_Id__c", body):
        FAILURES.append(
            "silver_contract_price_reconciliation still joins on "
            "SERVICE_CIRCUIT_ID/SOURCE_CONTRACT_ID -- this composite is not "
            "a candidate key and can fan out a single contract line into "
            "multiple priced rows"
        )
    if "line_item_match_count" not in body:
        FAILURES.append(
            "silver_contract_price_reconciliation no longer computes "
            "line_item_match_count -- the row-level proof that the join "
            "stayed 1:1 (DQ-2's dq2_one_to_one_join constraint) is missing"
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


def check_billed_price_generation_independence(py_source: str) -> None:
    """oracle_erp_source.ra_billed_circuit_rates (BILLED_UNIT_PRICE) must not
    be derived from cli.UnitPrice or cli.leakage_flag -- it must be
    re-derived from the shared stable business parameters (list_mrr, the
    negotiated discount fraction) with its own independent leakage draw."""
    match = re.search(
        r"billed_rates_out\s*=\s*cli\.select\(.*?\)\)",
        py_source,
        re.DOTALL,
    )
    if not match:
        # Fall back to a looser window around the billed-rate computation.
        match = re.search(
            r"# ---- Independent ERP-side.*?billed_rates_out = cli\.select\(.*?\)\)",
            py_source,
            re.DOTALL,
        )
    if not match:
        FAILURES.append(
            "billed_rates_out computation not found in simulate_source_systems.py"
        )
        return

    # Look at the broader block that computes _billed_unit_price, since
    # billed_rates_out itself just selects/aliases those columns.
    calc_match = re.search(
        r'\.withColumn\("_billed_unit_price".*?\.withColumn\("_billed_total_amount".*?\)\)',
        py_source,
        re.DOTALL,
    )
    if not calc_match:
        FAILURES.append(
            "_billed_unit_price computation not found in simulate_source_systems.py"
        )
        return
    calc_body = calc_match.group(0)

    if re.search(r'F\.col\("UnitPrice"\)', calc_body):
        FAILURES.append(
            "_billed_unit_price reads cli's own UnitPrice column as an input "
            "-- the billed side must be re-derived independently from "
            "list_mrr + the negotiated discount fraction, not copy the "
            "contracted price"
        )
    if re.search(r'F\.col\("leakage_flag"\)', calc_body):
        FAILURES.append(
            "_billed_unit_price reads cli's own leakage_flag -- the billed "
            "side must draw its own independent leakage signal "
            "(_billed_leak), not share contract_line_item's flag"
        )
    if "_billed_leak" not in calc_body:
        FAILURES.append(
            "_billed_unit_price no longer has its own independent leakage "
            "draw (_billed_leak) -- billing-side leakage injection appears "
            "to have been removed or merged with the Salesforce side"
        )


def check_fx_generation_independence(py_source: str) -> None:
    """ra_customer_trx_all.APPLIED_EXCHANGE_RATE must not recompute the same
    drift formula as gl_daily_rates.CONVERSION_RATE -- it must reference the
    actual `fx` DataFrame (a real cross-system lookup) and apply its own
    independent spread + leakage draw."""
    match = re.search(
        r'\.withColumn\("APPLIED_EXCHANGE_RATE".*?\)\)\)',
        py_source,
        re.DOTALL,
    )
    if not match:
        FAILURES.append(
            "APPLIED_EXCHANGE_RATE computation not found in simulate_source_systems.py"
        )
        return
    trx_block_start = py_source.rfind("trx = (bill.select", 0, match.start())
    body = py_source[trx_block_start:match.end()] if trx_block_start != -1 else match.group(0)

    if "market_rate_lookup" not in body and "_market_rate" not in body:
        FAILURES.append(
            "APPLIED_EXCHANGE_RATE does not join to the actual market-rate "
            "DataFrame (market_rate_lookup/_market_rate) -- it may be "
            "recomputing a parallel drift formula instead of looking up the "
            "real cross-system rate"
        )
    if re.search(r"% 300 - 150", body):
        FAILURES.append(
            "APPLIED_EXCHANGE_RATE reuses gl_daily_rates' exact drift range "
            "(% 300 - 150) -- the ERP side must use its own independent "
            "noise formula, not duplicate the market side's"
        )
    if "_fx_leak" not in body or "_fx_bias" not in body:
        FAILURES.append(
            "APPLIED_EXCHANGE_RATE no longer has its own independent "
            "leakage draw (_fx_leak/_fx_bias)"
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


def check_gold_leakage_flag_removed(gold_sql: str) -> None:
    """gold_leakage_summary's contract_price_mismatch arm must not select
    the simulator's known_leakage_flag ground-truth column -- it must
    publish a fixed FALSE placeholder (`FALSE AS known_leakage_flag`) like
    every other arm in the union, not read a real column into that alias."""
    match = re.search(
        r"-- Contract price mismatches.*?(?=UNION ALL|\Z)", gold_sql, re.DOTALL
    )
    if not match:
        FAILURES.append("contract_price_mismatch union arm not found in gold_aggregation.sql")
        return
    body = match.group(0)
    # Any occurrence of `known_leakage_flag` NOT immediately preceded by
    # `FALSE AS ` means the arm is reading the real ground-truth column
    # rather than publishing the fixed placeholder every other arm uses.
    for occurrence in re.finditer(r"known_leakage_flag", body):
        preceding = body[max(0, occurrence.start() - 12):occurrence.start()]
        if "FALSE AS " not in preceding:
            FAILURES.append(
                "gold_leakage_summary's contract_price_mismatch arm reads a "
                "real known_leakage_flag column instead of the fixed FALSE "
                "placeholder -- the simulator's ground-truth leakage column "
                "must not reach any gold output"
            )
            break


def check_scorecard_revrec_full_universe(gold_sql: str) -> None:
    """The scorecard's rev_rec_by_invoice CTE must build from the full
    ra_customer_trx_all invoice universe (LEFT JOIN + COALESCE-to-0), the
    same pattern silver_revenue_recognition_check uses -- not its own
    (looser) INNER JOIN from revenue_recognition_schedule, which would
    silently drop GL-only invoices from the scorecard even after silver
    was fixed to include them."""
    match = re.search(
        r"rev_rec_by_invoice AS \(.*?\n\),\n", gold_sql, re.DOTALL
    )
    if not match:
        FAILURES.append("rev_rec_by_invoice CTE not found in gold_aggregation.sql")
        return
    body = match.group(0)

    if "FROM oracle_erp_source.ra_customer_trx_all" not in body:
        FAILURES.append(
            "rev_rec_by_invoice does not select FROM the full "
            "ra_customer_trx_all invoice universe -- it may still start "
            "from revenue_recognition_schedule, which would drop GL-only "
            "invoices"
        )
    if re.search(r"FROM oracle_erp_source\.revenue_recognition_schedule\s+r\s*\n\s*JOIN\s+oracle_erp_source\.ra_customer_trx_all", body):
        FAILURES.append(
            "rev_rec_by_invoice still INNER JOINs "
            "revenue_recognition_schedule to ra_customer_trx_all -- this "
            "silently excludes GL-only invoices from the scorecard"
        )
    if "COALESCE(ir.recognized_total, 0)" not in body or "COALESCE(ig.gl_posted, 0)" not in body:
        FAILURES.append(
            "rev_rec_by_invoice does not COALESCE missing recognized/GL "
            "amounts to 0 -- a schedule-only or GL-only invoice would "
            "produce NULL instead of a zero-filled exception amount"
        )


def main() -> int:
    sql = SILVER_RECON.read_text()
    check_price_reconciliation_independence(sql)
    check_fx_validation_independence(sql)
    check_expired_quote_grain(SILVER_RECON)

    gold_sql = (REPO_ROOT / "reconciliation" / "pipelines" / "gold_aggregation.sql").read_text()
    check_gold_leakage_flag_removed(gold_sql)
    check_scorecard_revrec_full_universe(gold_sql)

    py_source = DATA_SIM.read_text()
    check_billed_price_generation_independence(py_source)
    check_fx_generation_independence(py_source)

    if FAILURES:
        print("FAIL: source-independence checks failed:")
        for failure in FAILURES:
            print(f"  - {failure}")
        return 1

    print("PASS: all source-independence checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
