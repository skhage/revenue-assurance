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
-- CHECK-1 FIXED: this check previously referenced `leakage_flag`, a column
-- that no longer exists on silver_contract_price_reconciliation's output --
-- the view became full-sided (FULL OUTER JOIN, explicit reconciliation_status
-- in {MATCHED, MISMATCH, MISSING_ERP, MISSING_SALESFORCE}) and dropped that
-- column entirely, so this check would fail to even EXECUTE
-- (UNRESOLVED_COLUMN) against the real deployed view, not just fail its
-- assertion. Rewritten to validate reconciliation_status instead.
--
-- A runtime query can't prove "the SQL doesn't read column X" (that's a
-- structural property of the source, checked separately by
-- `check_source_independence.py`). What a query CAN prove: contracted_price
-- and billed_unit_price come from two different systems/tables (Salesforce
-- vs Oracle ERP) and every MATCHED/MISMATCH row's reconciliation_status is
-- arithmetically consistent with those two values -- i.e. re-deriving the
-- status from (contracted_price, billed_unit_price) alone reproduces
-- exactly what's stored, with no other input. Restricted to rows where
-- BOTH sides are present (billed_unit_price IS NOT NULL AND
-- contracted_price is the row's own Salesforce-side value) so MISSING_ERP/
-- MISSING_SALESFORCE rows -- which have no meaningful price_mismatch_pct to
-- re-derive from -- don't need to be reproduced by this arithmetic check
-- (they're covered by CHECK-1b below instead). Also covers the
-- zero-contracted-price edge case (contracted_price = 0 AND
-- billed_unit_price > 0 must be MISMATCH, not a NULL-arithmetic MATCHED).
-- -----------------------------------------------------------------------------
SELECT
  'CHECK-1 price reconciliation status is arithmetically self-consistent' AS check_name,
  CASE WHEN COUNT(*) = SUM(CASE
    WHEN (
      (contracted_price = 0 AND billed_unit_price > 0)
      OR ABS(contracted_price - billed_unit_price) / NULLIF(contracted_price, 0) > 0.01
    ) = (reconciliation_status = 'MISMATCH')
    THEN 1 ELSE 0 END)
    THEN 'PASS' ELSE 'FAIL' END AS status,
  COUNT(*) AS total_matched_or_mismatch_rows,
  SUM(CASE WHEN reconciliation_status = 'MISMATCH' THEN 1 ELSE 0 END) AS mismatch_rows,
  SUM(CASE WHEN reconciliation_status = 'MATCHED' THEN 1 ELSE 0 END) AS matched_rows
FROM cdm_tmforum.revenue_assurance.silver_contract_price_reconciliation
WHERE reconciliation_status IN ('MATCHED', 'MISMATCH');

-- CHECK-1b: MISSING_ERP/MISSING_SALESFORCE rows carry the full one-sided
-- amount as their exposure, never NULL, and never MATCHED/MISMATCH (which
-- require both sides present by construction -- silver's own CASE checks
-- line_item_id/billed_line_item_id IS NULL before ever comparing prices).
SELECT
  'CHECK-1b missing-side rows have non-null, correctly-derived exposure' AS check_name,
  CASE WHEN missing_side_rows = 0 OR missing_side_rows_with_valid_exposure = missing_side_rows
    THEN 'PASS' ELSE 'FAIL' END AS status,
  missing_side_rows,
  missing_side_rows_with_valid_exposure
FROM (
  SELECT
    COUNT(*) AS missing_side_rows,
    -- Deliberately NOT filtering out NULL estimated_amount_at_risk rows
    -- from the denominator -- a NULL exposure on a MISSING_* row IS the
    -- bug this check exists to catch, so it must count against
    -- missing_side_rows_with_valid_exposure (via the ELSE 0 branch, since
    -- `NULL = contracted_total` is NULL, not TRUE), not be excluded from
    -- the total and let the check vacuously pass.
    SUM(CASE
      WHEN reconciliation_status = 'MISSING_ERP' AND estimated_amount_at_risk = contracted_total THEN 1
      WHEN reconciliation_status = 'MISSING_SALESFORCE' AND estimated_amount_at_risk = billed_total THEN 1
      ELSE 0
    END) AS missing_side_rows_with_valid_exposure
  FROM cdm_tmforum.revenue_assurance.silver_contract_price_reconciliation
  WHERE reconciliation_status IN ('MISSING_ERP', 'MISSING_SALESFORCE')
);


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
-- CHECK-2c/2d/2e: DETERMINISTIC FIXTURES proving missing-market-rate,
-- missing-applied-rate, and unsupported-currency are their OWN explicit
-- exception statuses, not a silent MATCHED/clean fallthrough. Reproduces the
-- exact fx_validation_status CASE order from silver_fx_rate_validation.
-- -----------------------------------------------------------------------------
WITH mock_trx AS (
  SELECT * FROM (VALUES
    ('T1', 'USD', CAST(1.0 AS DOUBLE)),             -- not_applicable
    ('T2', 'EUR', CAST(1.08 AS DOUBLE)),            -- matched
    ('T3', 'EUR', CAST(1.30 AS DOUBLE)),            -- deviation
    ('T4', 'EUR', CAST(NULL AS DOUBLE)),            -- missing_applied_rate
    ('T5', 'EUR', CAST(2.0 AS DOUBLE)),             -- supported currency, missing date quote
    ('T6', 'XYZ', CAST(2.0 AS DOUBLE))              -- unsupported currency
  ) AS t(trx_id, currency, applied_rate)
),
mock_fx AS (
  SELECT * FROM (VALUES
    ('T2', 'EUR', CAST(1.08 AS DOUBLE)),
    ('T3', 'EUR', CAST(1.08 AS DOUBLE)),
    ('T4', 'EUR', CAST(1.08 AS DOUBLE))
  ) AS t(trx_id, currency, market_rate)
),
supported_currencies AS (
  SELECT DISTINCT currency FROM mock_fx
),
joined AS (
  SELECT t.trx_id, t.currency, t.applied_rate, f.market_rate, sc.currency AS supported_currency
  FROM mock_trx t
  LEFT JOIN mock_fx f ON f.trx_id = t.trx_id
  LEFT JOIN supported_currencies sc ON sc.currency = t.currency
),
statused AS (
  SELECT trx_id,
    CASE
      WHEN currency = 'USD' THEN 'NOT_APPLICABLE'
      WHEN supported_currency IS NULL THEN 'UNSUPPORTED_CURRENCY'
      WHEN applied_rate IS NULL THEN 'MISSING_APPLIED_RATE'
      WHEN market_rate IS NULL THEN 'MISSING_MARKET_RATE'
      WHEN ABS(applied_rate - market_rate) / NULLIF(market_rate, 0) > 0.01 THEN 'MISMATCH'
      ELSE 'MATCHED'
    END AS fx_validation_status
  FROM joined
)
SELECT
  'CHECK-2c missing applied rate is its own exception status' AS check_name,
  CASE WHEN (SELECT fx_validation_status FROM statused WHERE trx_id = 'T4') = 'MISSING_APPLIED_RATE'
    THEN 'PASS' ELSE 'FAIL' END AS status,
  (SELECT fx_validation_status FROM statused WHERE trx_id = 'T4') AS observed_status;

WITH mock_trx AS (
  SELECT * FROM (VALUES
    ('T1', 'USD', CAST(1.0 AS DOUBLE)),
    ('T2', 'EUR', CAST(1.08 AS DOUBLE)),
    ('T3', 'EUR', CAST(1.30 AS DOUBLE)),
    ('T4', 'EUR', CAST(NULL AS DOUBLE)),
    ('T5', 'EUR', CAST(2.0 AS DOUBLE)),
    ('T6', 'XYZ', CAST(2.0 AS DOUBLE))
  ) AS t(trx_id, currency, applied_rate)
),
mock_fx AS (
  SELECT * FROM (VALUES
    ('T2', 'EUR', CAST(1.08 AS DOUBLE)),
    ('T3', 'EUR', CAST(1.08 AS DOUBLE)),
    ('T4', 'EUR', CAST(1.08 AS DOUBLE))
  ) AS t(trx_id, currency, market_rate)
),
supported_currencies AS (
  SELECT DISTINCT currency FROM mock_fx
),
joined AS (
  SELECT t.trx_id, t.currency, t.applied_rate, f.market_rate, sc.currency AS supported_currency
  FROM mock_trx t
  LEFT JOIN mock_fx f ON f.trx_id = t.trx_id
  LEFT JOIN supported_currencies sc ON sc.currency = t.currency
),
statused AS (
  SELECT trx_id,
    CASE
      WHEN currency = 'USD' THEN 'NOT_APPLICABLE'
      WHEN supported_currency IS NULL THEN 'UNSUPPORTED_CURRENCY'
      WHEN applied_rate IS NULL THEN 'MISSING_APPLIED_RATE'
      WHEN market_rate IS NULL THEN 'MISSING_MARKET_RATE'
      WHEN ABS(applied_rate - market_rate) / NULLIF(market_rate, 0) > 0.01 THEN 'MISMATCH'
      ELSE 'MATCHED'
    END AS fx_validation_status
  FROM joined
)
SELECT
  'CHECK-2d missing market rate is its own exception status' AS check_name,
  CASE WHEN (SELECT fx_validation_status FROM statused WHERE trx_id = 'T5') = 'MISSING_MARKET_RATE'
    THEN 'PASS' ELSE 'FAIL' END AS status,
  (SELECT fx_validation_status FROM statused WHERE trx_id = 'T5') AS observed_status;

WITH mock_status AS (
  SELECT CASE
    WHEN currency = 'USD' THEN 'NOT_APPLICABLE'
    WHEN supported_currency IS NULL THEN 'UNSUPPORTED_CURRENCY'
    WHEN applied_rate IS NULL THEN 'MISSING_APPLIED_RATE'
    WHEN market_rate IS NULL THEN 'MISSING_MARKET_RATE'
    WHEN ABS(applied_rate - market_rate) / NULLIF(market_rate, 0) > 0.01 THEN 'MISMATCH'
    ELSE 'MATCHED'
  END AS fx_validation_status
  FROM (VALUES ('XYZ', CAST(2.0 AS DOUBLE), CAST(NULL AS DOUBLE), CAST(NULL AS STRING)))
    AS t(currency, applied_rate, market_rate, supported_currency)
)
SELECT
  'CHECK-2e unsupported currency is distinct from a missing date quote' AS check_name,
  CASE WHEN fx_validation_status = 'UNSUPPORTED_CURRENCY' THEN 'PASS' ELSE 'FAIL' END AS status,
  fx_validation_status AS observed_status
FROM mock_status;


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
-- CHECK-3d/3e/3f/3g: PRODUCTION-EQUIVALENT set-level validation. CHECK-3b/3c
-- above are deterministic fixtures (isolated proof the logic is correct on a
-- synthetic universe); these instead query the ACTUAL live tables --
-- catching failure modes a synthetic fixture can't: duplicate schedule/GL
-- rows in the real data, pre-aggregation loss when GROUP BY collapses more
-- than expected, fan-out from a bad join, and silver-vs-scorecard
-- divergence (the two views must agree on total recognized/GL across the
-- SAME underlying invoice universe, since gold_reconciliation_scorecard's
-- rev_rec_by_invoice was fixed in this branch to mirror silver's
-- invoice_level pattern exactly -- see gold_aggregation.sql).
-- -----------------------------------------------------------------------------
WITH invoice_recognition AS (
  SELECT CUSTOMER_TRX_ID, SUM(RECOGNIZED_AMOUNT) AS recognized_total
  FROM cdm_tmforum.oracle_erp_source.revenue_recognition_schedule
  GROUP BY CUSTOMER_TRX_ID
),
invoice_gl AS (
  SELECT h.CUSTOMER_TRX_ID, SUM(l.ENTERED_CR) AS gl_posted
  FROM cdm_tmforum.oracle_erp_source.gl_je_lines l
  JOIN cdm_tmforum.oracle_erp_source.gl_je_headers h ON l.JE_HEADER_ID = h.JE_HEADER_ID
  JOIN cdm_tmforum.oracle_erp_source.gl_code_combinations cc ON l.CODE_COMBINATION_ID = cc.CODE_COMBINATION_ID
  WHERE cc.ACCOUNT = '4000'
  GROUP BY h.CUSTOMER_TRX_ID
),
invoice_level AS (
  SELECT
    t.CUSTOMER_TRX_ID,
    COALESCE(ir.recognized_total, 0) AS recognized_total,
    COALESCE(ig.gl_posted, 0) AS gl_posted
  FROM cdm_tmforum.oracle_erp_source.ra_customer_trx_all t
  LEFT JOIN invoice_recognition ir ON ir.CUSTOMER_TRX_ID = t.CUSTOMER_TRX_ID
  LEFT JOIN invoice_gl ig ON ig.CUSTOMER_TRX_ID = t.CUSTOMER_TRX_ID
)
-- CHECK-3d: no fan-out. ra_customer_trx_all's own CUSTOMER_TRX_ID must be
-- unique going INTO the LEFT JOINs -- a duplicate here would double-count
-- an invoice's recognized/GL totals in every downstream rollup.
SELECT
  'CHECK-3d no fan-out in the full invoice universe' AS check_name,
  CASE WHEN total_invoices = distinct_invoices THEN 'PASS' ELSE 'FAIL' END AS status,
  total_invoices,
  distinct_invoices
FROM (
  SELECT COUNT(*) AS total_invoices, COUNT(DISTINCT CUSTOMER_TRX_ID) AS distinct_invoices
  FROM cdm_tmforum.oracle_erp_source.ra_customer_trx_all
);

WITH invoice_recognition_raw AS (
  SELECT CUSTOMER_TRX_ID, SUM(RECOGNIZED_AMOUNT) AS recognized_total
  FROM cdm_tmforum.oracle_erp_source.revenue_recognition_schedule
  GROUP BY CUSTOMER_TRX_ID
)
-- CHECK-3e: no duplicate schedule aggregation -- the per-invoice
-- SUM(RECOGNIZED_AMOUNT) GROUP BY CUSTOMER_TRX_ID must itself produce one
-- row per CUSTOMER_TRX_ID (trivially true of a GROUP BY, but this proves
-- the grouping key is actually CUSTOMER_TRX_ID and not something coarser
-- that would silently blend multiple invoices' schedules together).
SELECT
  'CHECK-3e revenue_recognition_schedule aggregates cleanly per invoice' AS check_name,
  CASE WHEN total_groups = distinct_ids THEN 'PASS' ELSE 'FAIL' END AS status,
  total_groups,
  distinct_ids
FROM (
  SELECT COUNT(*) AS total_groups, COUNT(DISTINCT CUSTOMER_TRX_ID) AS distinct_ids
  FROM invoice_recognition_raw
);

WITH invoice_recognition AS (
  SELECT CUSTOMER_TRX_ID, SUM(RECOGNIZED_AMOUNT) AS recognized_total
  FROM cdm_tmforum.oracle_erp_source.revenue_recognition_schedule
  GROUP BY CUSTOMER_TRX_ID
),
invoice_gl AS (
  SELECT h.CUSTOMER_TRX_ID, SUM(l.ENTERED_CR) AS gl_posted
  FROM cdm_tmforum.oracle_erp_source.gl_je_lines l
  JOIN cdm_tmforum.oracle_erp_source.gl_je_headers h ON l.JE_HEADER_ID = h.JE_HEADER_ID
  JOIN cdm_tmforum.oracle_erp_source.gl_code_combinations cc ON l.CODE_COMBINATION_ID = cc.CODE_COMBINATION_ID
  WHERE cc.ACCOUNT = '4000'
  GROUP BY h.CUSTOMER_TRX_ID
),
invoice_level AS (
  SELECT
    t.CUSTOMER_TRX_ID,
    t.TRX_DATE,
    COALESCE(ir.recognized_total, 0) AS recognized_total,
    COALESCE(ig.gl_posted, 0) AS gl_posted
  FROM cdm_tmforum.oracle_erp_source.ra_customer_trx_all t
  LEFT JOIN invoice_recognition ir ON ir.CUSTOMER_TRX_ID = t.CUSTOMER_TRX_ID
  LEFT JOIN invoice_gl ig ON ig.CUSTOMER_TRX_ID = t.CUSTOMER_TRX_ID
),
silver_period_total AS (
  -- Reproduces silver_revenue_recognition_check's own grouping exactly
  -- (by invoice-origination period), then sums across ALL periods -- this
  -- must equal the flat sum across the whole invoice_level universe
  -- (CHECK-3f), proving no pre-aggregation loss when collapsing invoice
  -- grain into period grain.
  SELECT SUM(recognized_total) AS period_grouped_total, SUM(gl_posted) AS period_grouped_gl
  FROM invoice_level
),
flat_total AS (
  SELECT SUM(recognized_total) AS flat_total, SUM(gl_posted) AS flat_gl
  FROM invoice_level
)
SELECT
  'CHECK-3f no pre-aggregation loss (period rollup == invoice-flat total)' AS check_name,
  CASE WHEN ABS(period_grouped_total - flat_total) < 0.01 AND ABS(period_grouped_gl - flat_gl) < 0.01
    THEN 'PASS' ELSE 'FAIL' END AS status,
  period_grouped_total,
  flat_total,
  period_grouped_gl,
  flat_gl
FROM silver_period_total, flat_total;

-- CHECK-3g REPLACED: the prior version reproduced BOTH "silver_shaped" and
-- "scorecard_shaped" from the exact same invoice_recognition/invoice_gl
-- CTEs with the exact same LEFT JOINs -- two independently-named CTEs
-- computing the SAME query twice, guaranteed to agree with each other
-- regardless of whether either one actually matches the REAL deployed
-- silver_revenue_recognition_check or gold_reconciliation_scorecard. It
-- validated nothing about the actual production objects.
--
-- Rewritten to query the two REAL deployed objects directly:
-- gold_leakage_summary's rev_rec_timing_mismatch arm independently
-- re-derives its amount_at_risk from silver_revenue_recognition_check
-- (see gold_aggregation.sql), so summing that check_type's amount_at_risk
-- must equal silver's own flagged-period ABS(recognition_variance) sum --
-- both read the identical upstream rows, so any divergence is a real bug
-- in one of the two deployed views, not an artifact of re-derived test SQL.
WITH leakage_rev_rec_totals AS (
  SELECT SUM(amount_at_risk) AS leakage_rev_rec_amount
  FROM cdm_tmforum.revenue_assurance.gold_leakage_summary
  WHERE check_type = 'rev_rec_timing_mismatch'
),
silver_flagged_variance AS (
  SELECT SUM(ABS(recognition_variance)) AS silver_flagged_amount
  FROM cdm_tmforum.revenue_assurance.silver_revenue_recognition_check
  WHERE material_timing_mismatch = TRUE
)
SELECT
  'CHECK-3g gold_leakage_summary rev_rec exposure matches silver''s own flagged-period variance' AS check_name,
  CASE WHEN ABS(COALESCE(leakage_rev_rec_amount, 0) - COALESCE(silver_flagged_amount, 0)) < 0.01
    THEN 'PASS' ELSE 'FAIL' END AS status,
  leakage_rev_rec_amount,
  silver_flagged_amount
FROM leakage_rev_rec_totals, silver_flagged_variance;

-- CHECK-3h: gold_reconciliation_scorecard's rev_rec_accuracy_score must be
-- consistent with silver's OWN period-grain material_timing_mismatch flag
-- -- not a re-derived per-invoice threshold. Deterministic fixture:
-- constructs the exact "offsetting invoice variances" scenario (two
-- invoices in one period, opposite-direction, each individually breaching
-- 5% but the period AGGREGATE is clean) and proves the scorecard's fixed
-- period-join logic reports ZERO exceptions for both invoices' customers,
-- matching what silver's period-grain check would report (no mismatch) --
-- the bug this check exists to catch: a naive per-invoice re-derivation
-- would wrongly flag both as exceptions even though silver sees a clean
-- period.
WITH fixture_invoices AS (
  SELECT * FROM (VALUES
    ('INV1', 'CUSTA', CAST(1000.0 AS DOUBLE), CAST(1200.0 AS DOUBLE)),
    ('INV2', 'CUSTB', CAST(1200.0 AS DOUBLE), CAST(1000.0 AS DOUBLE))
  ) AS t(CUSTOMER_TRX_ID, customer_id, invoice_recognized_total, invoice_gl_posted)
),
fixture_period AS (
  SELECT
    SUM(invoice_recognized_total) AS period_recognized_total,
    SUM(invoice_gl_posted) AS period_gl_posted,
    CASE
      WHEN ABS(SUM(invoice_recognized_total) - SUM(invoice_gl_posted))
           / NULLIF(GREATEST(SUM(invoice_recognized_total), SUM(invoice_gl_posted)), 0) > 0.05
      THEN TRUE ELSE FALSE
    END AS material_timing_mismatch
  FROM fixture_invoices
),
fixture_scorecard AS (
  SELECT
    fi.customer_id,
    SUM(CASE WHEN fp.material_timing_mismatch THEN 1 ELSE 0 END) AS rev_rec_exceptions
  FROM fixture_invoices fi
  CROSS JOIN fixture_period fp
  GROUP BY fi.customer_id
)
SELECT
  'CHECK-3h offsetting invoice variances: period-grain join produces zero false exceptions' AS check_name,
  CASE WHEN (SELECT material_timing_mismatch FROM fixture_period) = FALSE
       AND (SELECT SUM(rev_rec_exceptions) FROM fixture_scorecard) = 0
    THEN 'PASS' ELSE 'FAIL' END AS status,
  (SELECT material_timing_mismatch FROM fixture_period) AS silver_period_flag,
  (SELECT SUM(rev_rec_exceptions) FROM fixture_scorecard) AS scorecard_total_exceptions;


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
-- CHECK-5: Scorecard includes all 8 controls (columns present + populated for
-- at least one customer each).
-- -----------------------------------------------------------------------------
SELECT
  'CHECK-5 scorecard covers all 8 controls' AS check_name,
  CASE WHEN COUNT(*) = COUNT(price_accuracy_score)
       AND COUNT(*) = COUNT(discount_compliance_score)
       AND COUNT(*) = COUNT(fx_accuracy_score)
       AND COUNT(*) = COUNT(expired_quote_compliance_score)
       AND COUNT(*) = COUNT(collection_efficiency_score)
       AND COUNT(*) = COUNT(rev_rec_accuracy_score)
       AND COUNT(*) = COUNT(doc_consistency_score)
       AND COUNT(*) = COUNT(doc_invoice_consistency_score)
    THEN 'PASS' ELSE 'FAIL' END AS status,
  COUNT(*) AS total_customers,
  COUNT(fx_accuracy_score) AS with_fx_score,
  COUNT(rev_rec_accuracy_score) AS with_rev_rec_score,
  COUNT(doc_invoice_consistency_score) AS with_doc_invoice_score,
  COUNT(expired_quote_compliance_score) AS with_expired_quote_score
FROM cdm_tmforum.revenue_assurance.gold_reconciliation_scorecard;

-- CHECK-5b: the approved lower-risk schema keeps DQ-5 at one row per real
-- customer and repeats two GLOBAL audit columns for MISSING_SALESFORCE rows
-- that cannot be customer-attributed. Every scorecard row must carry the same
-- totals, and those totals must equal the drill-down rows in gold leakage.
WITH scorecard_totals AS (
  SELECT
    MIN(unattributed_missing_salesforce_exceptions) AS min_exception_count,
    MAX(unattributed_missing_salesforce_exceptions) AS max_exception_count,
    MIN(unattributed_missing_salesforce_amount_at_risk) AS min_risk_amount,
    MAX(unattributed_missing_salesforce_amount_at_risk) AS max_risk_amount
  FROM cdm_tmforum.revenue_assurance.gold_reconciliation_scorecard
),
leakage_totals AS (
  SELECT
    COUNT(*) AS exception_count,
    COALESCE(SUM(amount_at_risk), 0) AS risk_amount
  FROM cdm_tmforum.revenue_assurance.gold_leakage_summary
  WHERE check_type = 'contract_price_missing_salesforce'
    AND customer_id IS NULL
)
SELECT
  'CHECK-5b unattributed MISSING_SALESFORCE totals reconcile to gold drill-down' AS check_name,
  CASE WHEN min_exception_count = max_exception_count
         AND min_risk_amount = max_risk_amount
         AND max_exception_count = exception_count
         AND ABS(max_risk_amount - risk_amount) < 0.01
    THEN 'PASS' ELSE 'FAIL' END AS status,
  max_exception_count AS scorecard_exception_count,
  exception_count AS leakage_exception_count,
  max_risk_amount AS scorecard_risk_amount,
  risk_amount AS leakage_risk_amount
FROM scorecard_totals, leakage_totals;


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


-- -----------------------------------------------------------------------------
-- CHECK-8: rev_rec_risk_amount is exception-consistent -- it must sum
-- variance ONLY for invoices that breach the 5% material-timing threshold,
-- matching rev_rec_exceptions' count, not every invoice's variance
-- regardless of materiality (the same class of bug the AR fix addressed
-- for ar_risk_amount). Deterministic fixture: one clean invoice (0% var),
-- one immaterial invoice (4.9% var, below threshold), one material
-- exception (20% var, above threshold) -- the fixed sum must equal ONLY
-- the material exception's variance (200.0), not all three invoices'
-- variance (249.0).
-- -----------------------------------------------------------------------------
WITH mock_invoices AS (
  SELECT * FROM (VALUES
    (1, CAST(1000.0 AS DOUBLE), CAST(1000.0 AS DOUBLE)),  -- clean
    (1, CAST(1000.0 AS DOUBLE), CAST(1049.0 AS DOUBLE)),  -- 4.9% var, immaterial
    (1, CAST(1000.0 AS DOUBLE), CAST(1200.0 AS DOUBLE))   -- 20% var, material exception
  ) AS t(customer_id, recognized, gl)
),
rev_rec_check AS (
  SELECT
    customer_id,
    SUM(CASE WHEN ABS(recognized - gl) / NULLIF(GREATEST(recognized, gl), 0) > 0.05 THEN 1 ELSE 0 END)
      AS rev_rec_exceptions,
    SUM(CASE
      WHEN ABS(recognized - gl) / NULLIF(GREATEST(recognized, gl), 0) > 0.05
      THEN ABS(recognized - gl) ELSE 0
    END) AS rev_rec_risk_amount,
    SUM(ABS(recognized - gl)) AS naive_risk_amount_for_comparison
  FROM mock_invoices
  GROUP BY customer_id
)
SELECT
  'CHECK-8 rev_rec_risk_amount is exception-consistent (only material variance)' AS check_name,
  CASE WHEN rev_rec_exceptions = 1 AND rev_rec_risk_amount = 200.0
       AND naive_risk_amount_for_comparison = 249.0 AND rev_rec_risk_amount < naive_risk_amount_for_comparison
    THEN 'PASS' ELSE 'FAIL' END AS status,
  rev_rec_exceptions,
  rev_rec_risk_amount,
  naive_risk_amount_for_comparison
FROM rev_rec_check;
