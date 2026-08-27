# Reconciliation control fix validation

Deterministic checks for the reconciliation-control fixes on this branch (independent
contract-price/FX comparisons, compatible rev-rec grain, forecast future-row retention,
full-coverage scorecard, actual-mismatch counting, quote-grain expired-quote counting).

- **`check_source_independence.py`** — static, offline. Inspects the SQL source text to
  confirm the price and FX checks derive their flags from independent cross-system values,
  not from simulator ground-truth columns, and that the expired-quote union uses
  `SELECT DISTINCT`. Run with `python3 reconciliation/validation/check_source_independence.py`.
- **`reconciliation_control_fixes.sql`** — runtime, against the deployed
  `cdm_tmforum.revenue_assurance` schema. Catalog/schema names are hardcoded (this is a
  standalone diagnostic script, not a Lakeflow pipeline file, so it has no `${var.catalog}`
  substitution to rely on) — edit them directly if validating against a different catalog.
  One `SELECT` per defect, each returning a `status` column of `PASS`/`FAIL`. Includes
  fixture-based checks (CHECK-3b/3c) that use literal `VALUES` rows rather than live data,
  so they prove schedule-only/GL-only invoice detection deterministically even when the
  live dataset has no such rows. Requires the `data-sim` job and the reconciliation
  pipeline + warehouse forecast MV to have been (re)run first, since several checks
  exercise columns/tables added by this branch (`ra_billed_circuit_rates`,
  `SOURCE_LINE_ITEM_ID`, `APPLIED_EXCHANGE_RATE`, the expanded scorecard columns).
- **`check_forecast_mv_deploys.py`** — live deployment gate for
  `reconciliation/warehouse/gold_revenue_forecast_anomalies.sql`. Unlike `EXPLAIN`
  (planner-only), this actually deploys the file's two `CREATE OR REFRESH MATERIALIZED
  VIEW` statements under a `_test_` prefix, runs `REFRESH MATERIALIZED VIEW`, asserts
  `SHOW CREATE TABLE` still contains the scalar-subquery `horizon` expression verbatim
  (proving it wasn't literalized at creation time), then drops the test objects. Run with
  `python3 reconciliation/validation/check_forecast_mv_deploys.py --profile <name>
  --warehouse-id <id>`.

Run the SQL files' statements individually via the SQL editor, a notebook, or
`databricks experimental aitools tools query "<statement>" --profile <name>`.
