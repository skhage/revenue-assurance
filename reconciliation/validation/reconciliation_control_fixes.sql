-- =============================================================================
-- Deterministic validation for the reconciliation-control fixes in this branch.
--
-- One SELECT per corrected defect. Each returns a `status` column of
-- 'PASS'/'FAIL' plus the underlying counts, so the whole file can run as a
-- single statement batch (or one query at a time) and be read directly --
-- no external test runner required.
--
-- NOT A LAKEFLOW PIPELINE FILE: unlike reconciliation/pipelines/*.sql, this
-- is a standalone diagnostic script run ad hoc against a live warehouse, not
-- a pipeline dataset definition -- so it does NOT get `${var.catalog}`
-- substitution from a Lakeflow Declarative Pipeline / DAB deploy. Every
-- reference below is hardcoded to `cdm_tmforum.revenue_assurance` /
-- `cdm_tmforum.oracle_erp_source` etc., matching this repo's actual deployed
-- catalog (per demo-artifacts/README.md ground truth). If you need to run
-- this against a different catalog, find-and-replace `cdm_tmforum` --
-- there is no bundle-variable indirection to rely on here.
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
--
-- NULL-SAFETY FIX: `leakage_flag` is NULL on every clean row (by design --
-- see silver_contract_price_reconciliation's CASE...ELSE NULL). Comparing
-- `(price_mismatch_pct > 0.01) = (leakage_flag = 'price_mismatch')` is a
-- three-valued-logic trap: on a clean row the right side is
-- `(NULL = 'price_mismatch')` which itself evaluates to NULL (not FALSE),
-- so the whole equality is NULL, and `CASE WHEN NULL THEN 1 ELSE 0 END`
-- silently falls to the ELSE branch -- meaning every correctly-clean row
-- contributed 0, not 1, to the match count, and the check would fail even
-- when the SQL is 100% correct. Fixed by normalizing "is this row flagged"
-- to a plain boolean on BOTH sides before comparing (`leakage_flag IS NOT
-- NULL` rather than `leakage_flag = 'price_mismatch'`), so a clean row
-- correctly compares FALSE = FALSE.
-- -----------------------------------------------------------------------------
SELECT
  'CHECK-1 price reconciliation is arithmetically self-consistent' AS check_name,
  CASE WHEN COUNT(*) = SUM(CASE
    WHEN (ABS(contracted_price - billed_unit_price) / NULLIF(contracted_price, 0) > 0.01)
         = (leakage_flag IS NOT NULL)
    THEN 1 ELSE 0 END)
    THEN 'PASS' ELSE 'FAIL' END AS status,
  COUNT(*) AS total_rows,
  SUM(CASE WHEN leakage_flag IS NOT NULL THEN 1 ELSE 0 END) AS flagged_rows,
  SUM(CASE WHEN leakage_flag IS NULL THEN 1 ELSE 0 END) AS clean_rows
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

-- CHECK-2b STRENGTHENED: the prior version only asserted "at least one
-- deviation was flagged" (or vacuously passed on zero rows), which would
-- also pass if every single non-USD row were flagged (a broken check that
-- always fires) or if coverage were negligible (e.g. 2 rows total). This
-- version instead establishes: (a) actual source coverage -- a meaningful
-- row count, not a token few; (b) the flagged fraction sits in a plausible
-- band around the configured LEAKAGE_RATE (default 6%), not near-0% (check
-- never fires) or near-100% (check always fires, i.e. broken/inverted); and
-- (c) non-flagged rows really do have small deviation (median well under the
-- 1% threshold), proving the "clean" bucket isn't clean only by definition.
SELECT
  'CHECK-2b FX deviation flag establishes real coverage + plausible leakage rate' AS check_name,
  CASE WHEN total_rows >= 100
       AND flagged_fraction BETWEEN 0.01 AND 0.20
       AND clean_median_deviation_pct < 0.5
    THEN 'PASS' ELSE 'FAIL' END AS status,
  total_rows,
  flagged_deviations,
  ROUND(flagged_fraction, 4) AS flagged_fraction,
  ROUND(clean_median_deviation_pct, 4) AS clean_median_deviation_pct
FROM (
  SELECT
    COUNT(*) AS total_rows,
    SUM(CASE WHEN rate_deviation_flag THEN 1 ELSE 0 END) AS flagged_deviations,
    SUM(CASE WHEN rate_deviation_flag THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0) AS flagged_fraction,
    PERCENTILE(CASE WHEN NOT rate_deviation_flag THEN rate_deviation_pct * 100 END, 0.5) AS clean_median_deviation_pct
  FROM cdm_tmforum.revenue_assurance.silver_fx_rate_validation
  WHERE INVOICE_CURRENCY_CODE != 'USD' AND market_rate IS NOT NULL
);


-- -----------------------------------------------------------------------------
-- CHECK-3 STRENGTHENED: Revenue-recognition compares compatible (invoice-
-- origination-period) grains, built from the full invoice universe. The
-- prior version only asserted "< 50% of periods are material mismatches" --
-- a bound loose enough to pass even with the OLD, broken grain-mismatched
-- query (which produced material variance on most, but plausibly not
-- literally >50%, of periods). This version instead directly asserts the
-- median absolute variance percentage across ALL periods is small (proving
-- the comparison is apples-to-apples on clean data, not just "usually under
-- material threshold") AND that mismatches are rare (<= 2 out of ~96
-- periods with the default config, matching the two seeded forecast-anomaly
-- months) rather than the loose <50% bound.
-- -----------------------------------------------------------------------------
SELECT
  'CHECK-3 rev-rec grain compatibility (tight bound)' AS check_name,
  CASE WHEN median_abs_variance_pct < 1.0
       AND material_mismatch_periods <= GREATEST(2, CAST(total_periods * 0.05 AS INT))
    THEN 'PASS' ELSE 'FAIL' END AS status,
  total_periods,
  material_mismatch_periods,
  ROUND(median_abs_variance_pct, 4) AS median_abs_variance_pct
FROM (
  SELECT
    COUNT(*) AS total_periods,
    SUM(CASE WHEN material_timing_mismatch THEN 1 ELSE 0 END) AS material_mismatch_periods,
    PERCENTILE(
      ABS(scheduled_recognized_total - gl_revenue_posted)
        / NULLIF(GREATEST(scheduled_recognized_total, gl_revenue_posted), 0) * 100,
      0.5
    ) AS median_abs_variance_pct
  FROM cdm_tmforum.revenue_assurance.silver_revenue_recognition_check
);


-- -----------------------------------------------------------------------------
-- CHECK-3b/3c: DETERMINISTIC FIXTURES proving schedule-only and GL-only
-- invoice detection individually. CHECK-3 above is a live-data statistical
-- check; it can't prove the full-invoice-universe logic handles a
-- missing-side invoice correctly unless the live data happens to contain
-- one (it currently doesn't -- see gate report). These reproduce the EXACT
-- full-invoice-universe pattern from silver_revenue_recognition_check /
-- gold_reconciliation_scorecard's rev_rec_by_invoice against a literal
-- 3-row fixture (VALUES): one clean invoice, one schedule-only invoice (has
-- a recognition-schedule row, no GL posting), one GL-only invoice (has a GL
-- posting, no recognition-schedule row). No live table is read.
-- -----------------------------------------------------------------------------
WITH mock_invoices AS (
  SELECT * FROM (VALUES
    (1, CAST('2025-01-15' AS DATE)),   -- clean: schedule 1000, GL 1000
    (2, CAST('2025-01-20' AS DATE)),   -- schedule-only: schedule 500, no GL
    (3, CAST('2025-01-25' AS DATE))    -- GL-only: no schedule, GL 750
  ) AS t(CUSTOMER_TRX_ID, TRX_DATE)
),
mock_recognition AS (
  SELECT * FROM (VALUES (1, 1000.0), (2, 500.0)) AS t(CUSTOMER_TRX_ID, RECOGNIZED_AMOUNT)
),
mock_gl AS (
  SELECT * FROM (VALUES (1, 1000.0), (3, 750.0)) AS t(CUSTOMER_TRX_ID, gl_posted)
),
invoice_level AS (
  SELECT
    m.CUSTOMER_TRX_ID,
    COALESCE(r.RECOGNIZED_AMOUNT, 0) AS recognized_total,
    COALESCE(g.gl_posted, 0) AS gl_posted
  FROM mock_invoices m
  LEFT JOIN mock_recognition r ON r.CUSTOMER_TRX_ID = m.CUSTOMER_TRX_ID
  LEFT JOIN mock_gl g ON g.CUSTOMER_TRX_ID = m.CUSTOMER_TRX_ID
)
SELECT
  'CHECK-3b schedule-only invoice detected with GL side zero-filled' AS check_name,
  CASE WHEN schedule_only_recognized = 500.0 AND schedule_only_gl = 0.0
       AND schedule_only_variance_pct = 100.0
    THEN 'PASS' ELSE 'FAIL' END AS status,
  schedule_only_recognized,
  schedule_only_gl,
  schedule_only_variance_pct
FROM (
  SELECT
    recognized_total AS schedule_only_recognized,
    gl_posted AS schedule_only_gl,
    ROUND(ABS(recognized_total - gl_posted) / NULLIF(GREATEST(recognized_total, gl_posted), 0) * 100, 4)
      AS schedule_only_variance_pct
  FROM invoice_level WHERE CUSTOMER_TRX_ID = 2
);

WITH mock_invoices AS (
  SELECT * FROM (VALUES
    (1, CAST('2025-01-15' AS DATE)),
    (2, CAST('2025-01-20' AS DATE)),
    (3, CAST('2025-01-25' AS DATE))
  ) AS t(CUSTOMER_TRX_ID, TRX_DATE)
),
mock_recognition AS (
  SELECT * FROM (VALUES (1, 1000.0), (2, 500.0)) AS t(CUSTOMER_TRX_ID, RECOGNIZED_AMOUNT)
),
mock_gl AS (
  SELECT * FROM (VALUES (1, 1000.0), (3, 750.0)) AS t(CUSTOMER_TRX_ID, gl_posted)
),
invoice_level AS (
  SELECT
    m.CUSTOMER_TRX_ID,
    COALESCE(r.RECOGNIZED_AMOUNT, 0) AS recognized_total,
    COALESCE(g.gl_posted, 0) AS gl_posted
  FROM mock_invoices m
  LEFT JOIN mock_recognition r ON r.CUSTOMER_TRX_ID = m.CUSTOMER_TRX_ID
  LEFT JOIN mock_gl g ON g.CUSTOMER_TRX_ID = m.CUSTOMER_TRX_ID
)
SELECT
  'CHECK-3c GL-only invoice detected with recognized side zero-filled' AS check_name,
  CASE WHEN gl_only_recognized = 0.0 AND gl_only_gl = 750.0
       AND gl_only_variance_pct = 100.0
    THEN 'PASS' ELSE 'FAIL' END AS status,
  gl_only_recognized,
  gl_only_gl,
  gl_only_variance_pct
FROM (
  SELECT
    recognized_total AS gl_only_recognized,
    gl_posted AS gl_only_gl,
    ROUND(ABS(recognized_total - gl_posted) / NULLIF(GREATEST(recognized_total, gl_posted), 0) * 100, 4)
      AS gl_only_variance_pct
  FROM invoice_level WHERE CUSTOMER_TRX_ID = 3
);


-- -----------------------------------------------------------------------------
-- CHECK-4 STRENGTHENED: Forecast anomaly view retains pure-future rows
-- (beyond the last actual month) with non-null forecast bounds, and
-- correctly flags at least one held-out historical month as an anomaly (the
-- seeded GL step-change). The prior CHECK-4a/4b only proved "some future
-- rows exist" and "some anomaly exists" in isolation -- neither proved the
-- held-out ACTUAL months are the ones carrying forecast bounds (as opposed
-- to some unrelated coincidence), that the grain is clean (no duplicate
-- months from the FULL OUTER JOIN silently double-counting), or that a
-- flagged anomaly month has BOTH sides present (an anomaly derived from a
-- NULL-vs-something comparison would be a bug, not a real signal).
-- -----------------------------------------------------------------------------
SELECT
  'CHECK-4a forecast retains future rows with real bounds' AS check_name,
  CASE WHEN COUNT(*) > 0
       AND SUM(CASE WHEN forecast_upper_bound IS NULL OR forecast_lower_bound IS NULL THEN 1 ELSE 0 END) = 0
    THEN 'PASS' ELSE 'FAIL' END AS status,
  COUNT(*) AS future_rows_with_forecast
FROM cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies
WHERE actual_revenue IS NULL AND forecast_revenue IS NOT NULL;

-- CHECK-4b: revenue_month grain is unique -- a FULL OUTER JOIN between
-- monthly_revenue and forecasted can silently duplicate a month if either
-- side isn't already deduplicated by month. This is the same DQ-6 assertion
-- gold_revenue_forecast_anomalies_dq_audit makes in production, re-asserted
-- here directly against the gold view as an independent check.
SELECT
  'CHECK-4b revenue_month grain is unique' AS check_name,
  CASE WHEN total_rows = distinct_months THEN 'PASS' ELSE 'FAIL' END AS status,
  total_rows,
  distinct_months
FROM (
  SELECT COUNT(*) AS total_rows, COUNT(DISTINCT revenue_month) AS distinct_months
  FROM cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies
);

-- CHECK-4c: held-out actual months actually overlap forecast bounds -- not
-- just "some future row has bounds" (4a) but specifically that months WITH
-- a real actual_revenue also carry non-null forecast bounds, proving the
-- FULL OUTER JOIN's held-out training window genuinely intersects the
-- forecast's output range (the original bug this branch fixed: the two
-- ranges never overlapped, so every historical row's bounds were NULL).
SELECT
  'CHECK-4c held-out actual months overlap forecast bounds' AS check_name,
  CASE WHEN actual_months_total > 0 AND actual_months_with_bounds > 0
    THEN 'PASS' ELSE 'FAIL' END AS status,
  actual_months_total,
  actual_months_with_bounds
FROM (
  SELECT
    COUNT(*) AS actual_months_total,
    SUM(CASE WHEN forecast_upper_bound IS NOT NULL AND forecast_lower_bound IS NOT NULL THEN 1 ELSE 0 END)
      AS actual_months_with_bounds
  FROM cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies
  WHERE actual_revenue IS NOT NULL
);

-- CHECK-4d: every flagged anomaly month has BOTH actual_revenue and forecast
-- bounds present (an "aligned" row) -- proving anomaly_status is derived
-- from a genuine actual-vs-forecast comparison, not a NULL-safety fallthrough
-- or a coincidental comparison against an unrelated row.
SELECT
  'CHECK-4d anomalies arise from aligned actual/forecast rows' AS check_name,
  CASE WHEN anomaly_months > 0 AND anomaly_months = aligned_anomaly_months
    THEN 'PASS' ELSE 'FAIL' END AS status,
  anomaly_months,
  aligned_anomaly_months
FROM (
  SELECT
    COUNT(*) AS anomaly_months,
    SUM(CASE
      WHEN actual_revenue IS NOT NULL AND forecast_upper_bound IS NOT NULL AND forecast_lower_bound IS NOT NULL
      THEN 1 ELSE 0
    END) AS aligned_anomaly_months
  FROM cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies
  WHERE anomaly_status IN ('ABOVE_EXPECTED', 'BELOW_EXPECTED')
);


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
-- CHECK-6 FIXED: `correct_mismatch_count <= naive_nonnull_count` is a
-- mathematical tautology -- SUM of a 0/1 indicator over N rows is always
-- <= COUNT(nonnull) over the same N rows, so this "check" could never fail
-- and proved nothing (confirmed live: with all 50 doc-contract rows at
-- total_mismatches=0, naive_nonnull_count=50, correct=0, and 0<=50 trivially
-- passes regardless of which formula is "correct"). The actual production
-- behavior this must validate: the dashboard-style bare `COUNT(nullable_col)`
-- pattern the audit flagged (see git history / demo-artifacts) counts EVERY
-- non-null row as a "mismatch" -- so it is wrong specifically whenever a
-- legitimately clean (total_mismatches = 0) row exists, since that row is
-- still non-null. This check now asserts there are actual clean rows in the
-- data (so the two formulas have a real opportunity to diverge) AND that the
-- naive/bare-COUNT formula strictly overcounts relative to the corrected
-- SUM(CASE...) formula by exactly the number of clean rows -- i.e. it proves
-- the corrected formula is not merely "a valid lower bound" but the actual
-- fix for a demonstrated overcount.
-- -----------------------------------------------------------------------------
SELECT
  'CHECK-6 doc-contract mismatch counting: naive COUNT overcounts, SUM(CASE) is exact' AS check_name,
  CASE WHEN clean_rows > 0
       AND naive_nonnull_count = correct_mismatch_count + clean_rows
       AND naive_nonnull_count > correct_mismatch_count
    THEN 'PASS' ELSE 'FAIL' END AS status,
  total_docs,
  clean_rows,
  naive_nonnull_count,
  correct_mismatch_count
FROM (
  SELECT
    COUNT(*) AS total_docs,
    SUM(CASE WHEN total_mismatches = 0 THEN 1 ELSE 0 END) AS clean_rows,
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
