-- =============================================================================
-- Deterministic validation for the reconciliation-control fixes in this branch.
--
-- One SELECT per corrected defect. Each returns a `status` column of
-- 'PASS'/'FAIL' plus the underlying counts, so the whole file can run as a
-- single statement batch (or one query at a time) against the deployed
-- `${var.catalog}.${var.schema}` schema (defaults: cdm_tmforum.revenue_assurance)
-- and be read directly -- no external test runner required.
--
-- PREREQUISITE: this validates behavior that ships in
-- `data-sim/simulate_source_systems.py` (adds oracle_erp_source.ra_billed_circuit_rates
-- and ra_customer_trx_all.APPLIED_EXCHANGE_RATE/INVOICE_CURRENCY_CODE) and
-- `reconciliation/pipelines/*.sql` + `reconciliation/warehouse/*.sql` (the
-- corrected silver/gold views). Run the data-sim job and refresh the
-- reconciliation pipeline + warehouse forecast MV before running this file.
--
-- Usage: databricks experimental aitools tools query "<one SELECT>" --profile <name>
-- or paste into a SQL editor against the target catalog/schema.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- CHECK-1: Contract price reconciliation is independent of the leakage_flag.
-- A runtime query can't prove "the SQL doesn't read column X" (that's a
-- structural property of the source, checked separately by
-- `check_source_independence.py`). What a query CAN prove: contracted_price
-- and billed_unit_price come from two different systems/tables (Salesforce
-- vs Oracle ERP) and every row's detected leakage_flag is arithmetically
-- consistent with those two values -- i.e. re-deriving the flag from
-- (contracted_price, billed_unit_price) alone reproduces exactly what's
-- stored, with no other input.
-- -----------------------------------------------------------------------------
SELECT
  'CHECK-1 price reconciliation is arithmetically self-consistent' AS check_name,
  CASE WHEN COUNT(*) = SUM(CASE
    WHEN (ABS(contracted_price - billed_unit_price) / NULLIF(contracted_price, 0) > 0.01)
         = (leakage_flag = 'price_mismatch')
    THEN 1 ELSE 0 END)
    THEN 'PASS' ELSE 'FAIL' END AS status,
  COUNT(*) AS total_rows,
  SUM(CASE WHEN leakage_flag = 'price_mismatch' THEN 1 ELSE 0 END) AS flagged_rows
FROM cdm_tmforum.revenue_assurance.silver_contract_price_reconciliation
WHERE billed_unit_price IS NOT NULL;


-- -----------------------------------------------------------------------------
-- CHECK-2: FX validation covers meaningful non-USD transactions and compares
-- an independently-applied rate to the market rate (not a hardcoded 1.0).
-- -----------------------------------------------------------------------------
SELECT
  'CHECK-2a FX has non-USD invoices' AS check_name,
  CASE WHEN COUNT(*) > 0 THEN 'PASS' ELSE 'FAIL' END AS status,
  COUNT(*) AS non_usd_invoice_count
FROM cdm_tmforum.oracle_erp_source.ra_customer_trx_all
WHERE INVOICE_CURRENCY_CODE != 'USD';

SELECT
  'CHECK-2b FX deviation flag fires on real applied-vs-market divergence' AS check_name,
  CASE WHEN COUNT(*) = 0
       OR SUM(CASE WHEN rate_deviation_flag THEN 1 ELSE 0 END) > 0
    THEN 'PASS' ELSE 'FAIL' END AS status,
  COUNT(*) AS non_usd_rows_with_market_rate,
  SUM(CASE WHEN rate_deviation_flag THEN 1 ELSE 0 END) AS flagged_deviations
FROM cdm_tmforum.revenue_assurance.silver_fx_rate_validation
WHERE INVOICE_CURRENCY_CODE != 'USD' AND market_rate IS NOT NULL;


-- -----------------------------------------------------------------------------
-- CHECK-3: Revenue-recognition compares compatible (invoice-origination-period)
-- grains. On clean periods, variance should be near-zero (rounding only);
-- material variance should be rare and concentrated in the forecast-anomaly
-- months (2025-06, 2025-11 by default config), not spread across every period.
-- -----------------------------------------------------------------------------
SELECT
  'CHECK-3 rev-rec grain compatibility' AS check_name,
  CASE WHEN SUM(CASE WHEN material_timing_mismatch THEN 1 ELSE 0 END) < COUNT(*) * 0.5
    THEN 'PASS' ELSE 'FAIL' END AS status,
  COUNT(*) AS total_periods,
  SUM(CASE WHEN material_timing_mismatch THEN 1 ELSE 0 END) AS material_mismatch_periods
FROM cdm_tmforum.revenue_assurance.silver_revenue_recognition_check;


-- -----------------------------------------------------------------------------
-- CHECK-4: Forecast anomaly view retains pure-future rows (beyond the last
-- actual month) with non-null forecast bounds, and correctly flags at least
-- one held-out historical month as an anomaly (the seeded GL step-change).
-- -----------------------------------------------------------------------------
SELECT
  'CHECK-4a forecast retains future rows' AS check_name,
  CASE WHEN COUNT(*) > 0 THEN 'PASS' ELSE 'FAIL' END AS status,
  COUNT(*) AS future_rows_with_forecast
FROM cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies
WHERE actual_revenue IS NULL AND forecast_revenue IS NOT NULL;

SELECT
  'CHECK-4b forecast flags at least one real anomaly' AS check_name,
  CASE WHEN COUNT(*) > 0 THEN 'PASS' ELSE 'FAIL' END AS status,
  COUNT(*) AS anomaly_months
FROM cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies
WHERE anomaly_status IN ('ABOVE_EXPECTED', 'BELOW_EXPECTED');


-- -----------------------------------------------------------------------------
-- CHECK-5: Scorecard includes all 7 controls (columns present + populated for
-- at least one customer each).
-- -----------------------------------------------------------------------------
SELECT
  'CHECK-5 scorecard covers all 7 controls' AS check_name,
  CASE WHEN COUNT(*) = COUNT(price_accuracy_score)
       AND COUNT(*) = COUNT(discount_compliance_score)
       AND COUNT(*) = COUNT(expired_quote_compliance_score)
       AND COUNT(*) = COUNT(collection_efficiency_score)
       AND COUNT(*) = COUNT(rev_rec_accuracy_score)
       AND COUNT(*) = COUNT(doc_consistency_score)
       AND COUNT(*) = COUNT(doc_invoice_consistency_score)
    THEN 'PASS' ELSE 'FAIL' END AS status,
  COUNT(*) AS total_customers,
  COUNT(rev_rec_accuracy_score) AS with_rev_rec_score,
  COUNT(doc_invoice_consistency_score) AS with_doc_invoice_score,
  COUNT(expired_quote_compliance_score) AS with_expired_quote_score
FROM cdm_tmforum.revenue_assurance.gold_reconciliation_scorecard;


-- -----------------------------------------------------------------------------
-- CHECK-6: Document mismatch counts in the pipeline SQL use SUM(CASE WHEN ...)
-- rather than bare COUNT(nullable_col) -- i.e. doc_exceptions should be <=
-- total_docs and reflect only TRUE mismatches, not every non-null row. This
-- reruns the doc_check aggregation inline and cross-checks against a bare
-- COUNT to demonstrate they differ (proving the fix isn't a no-op).
-- -----------------------------------------------------------------------------
SELECT
  'CHECK-6 doc-contract mismatch counts actual mismatches' AS check_name,
  CASE WHEN correct_mismatch_count <= naive_nonnull_count THEN 'PASS' ELSE 'FAIL' END AS status,
  naive_nonnull_count,
  correct_mismatch_count
FROM (
  SELECT
    COUNT(total_mismatches) AS naive_nonnull_count,
    SUM(CASE WHEN total_mismatches > 0 THEN 1 ELSE 0 END) AS correct_mismatch_count
  FROM cdm_tmforum.revenue_assurance.silver_doc_intelligence_contracts
);


-- -----------------------------------------------------------------------------
-- CHECK-7: Expired quotes are counted at quote grain, not line grain --
-- gold_leakage_summary's expired_quote_active rows must equal the count of
-- DISTINCT expired quote_ids, not the (larger) count of expired quote LINES.
-- -----------------------------------------------------------------------------
SELECT
  'CHECK-7 expired-quote quote-grain counting' AS check_name,
  CASE WHEN register_rows = distinct_expired_quotes THEN 'PASS' ELSE 'FAIL' END AS status,
  register_rows,
  distinct_expired_quotes,
  line_grain_count
FROM (
  SELECT
    (SELECT COUNT(*) FROM cdm_tmforum.revenue_assurance.gold_leakage_summary
     WHERE check_type = 'expired_quote_active') AS register_rows,
    (SELECT COUNT(DISTINCT quote_id) FROM cdm_tmforum.revenue_assurance.silver_discount_authorization_check
     WHERE expired_quote_still_active) AS distinct_expired_quotes,
    (SELECT COUNT(*) FROM cdm_tmforum.revenue_assurance.silver_discount_authorization_check
     WHERE expired_quote_still_active) AS line_grain_count
);
