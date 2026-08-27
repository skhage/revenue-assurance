# Reconciliation control fix validation

Deterministic checks for the reconciliation-control fixes on this branch (independent
contract-price/FX comparisons, compatible rev-rec grain, forecast future-row retention,
full-coverage scorecard, actual-mismatch counting, quote-grain expired-quote counting).

- **`check_source_independence.py`** — static, offline. Inspects the SQL source text to
  confirm the price and FX checks derive their flags from independent cross-system values,
  not from simulator ground-truth columns, and that the expired-quote union uses
  `SELECT DISTINCT`. Run with `python3 reconciliation/validation/check_source_independence.py`.
- **`reconciliation_control_fixes.sql`** — runtime, against the deployed
  `cdm_tmforum.revenue_assurance` schema. One `SELECT` per defect, each returning a
  `status` column of `PASS`/`FAIL`. Requires the `data-sim` job and the reconciliation
  pipeline + warehouse forecast MV to have been (re)run first, since several checks
  exercise columns/tables added by this branch (`ra_billed_circuit_rates`,
  `APPLIED_EXCHANGE_RATE`, the expanded scorecard columns).

Run the SQL file's statements individually via the SQL editor, a notebook, or
`databricks experimental aitools tools query "<statement>" --profile <name>`.
