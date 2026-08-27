-- =============================================================================
-- Warehouse-Executed Revenue Forecast Materialized View
--
-- Run this file with CREATE OR REFRESH MATERIALIZED VIEW on a Pro or Serverless
-- SQL warehouse. It is deliberately NOT part of `ra_medallion_pipeline` because
-- `ai_forecast` requires SQL warehouse execution rather than the Lakeflow
-- Declarative Pipeline DAG.
--
-- The fully qualified output name and selected columns are retained exactly for
-- the dashboard and downstream DQ-6 audit contract.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 9. Revenue Forecast Anomalies (ai_forecast)
-- Time-series anomaly detection on monthly GL revenue.
--
-- JOIN FIX: `ai_forecast` documents that its output "contains forecasted
--   values only, spanning the range of time between the end of the observed
--   data until horizon" -- it never returns rows inside the training range.
--   The prior version trained on the FULL history and then LEFT JOINed
--   monthly_revenue (all historical months) to that future-only forecast on
--   revenue_month. Those ranges never overlap, so forecast_revenue/bounds
--   were NULL for every historical row (anomaly_status was always 'NORMAL',
--   even for the seeded step-change months) and pure-future forecast rows
--   were dropped entirely by the LEFT JOIN's outer table. Verified live:
--   ai_forecast(horizon='2026-12-31') trained on data through 2025-12 returns
--   only 2026-01..2026-12.
--
-- Fixed by training on a truncated window (holding out the trailing
--   TRAINING_HOLDOUT_MONTHS of actuals) so the forecast's output range
--   overlaps the held-out actuals -- giving those months real bounds to
--   compare against -- while the horizon still extends past the last actual
--   month for the pure-future forecast scene. A FULL OUTER JOIN keeps both
--   the held-out-actuals-with-forecast rows AND the pure-future forecast-only
--   rows (previously dropped by the LEFT JOIN).
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies
COMMENT 'AI-powered time-series anomaly detection on monthly revenue. Trains ai_forecast on all but the trailing 24 months of actuals, so the forecast''s output range overlaps those held-out months (giving them real confidence bounds to compare against) as well as extending 12 months past the last actual for the pure-future forecast scene. Flags held-out months where actual deviates outside the forecast interval. Includes budget variance from gl_budgets.'
AS
WITH monthly_revenue AS (
  SELECT
    DATE_TRUNC('month', h.TRX_DATE) AS revenue_month,
    SUM(l.ENTERED_CR) AS actual_revenue
  FROM cdm_tmforum.oracle_erp_source.gl_je_lines l
  JOIN cdm_tmforum.oracle_erp_source.gl_je_headers h
    ON l.JE_HEADER_ID = h.JE_HEADER_ID
  JOIN cdm_tmforum.oracle_erp_source.gl_code_combinations cc
    ON l.CODE_COMBINATION_ID = cc.CODE_COMBINATION_ID
  WHERE cc.ACCOUNT = '4000'
  GROUP BY DATE_TRUNC('month', h.TRX_DATE)
),
bounds AS (
  SELECT MAX(revenue_month) AS max_actual_month FROM monthly_revenue
),
training_revenue AS (
  -- Hold out the trailing 24 months so ai_forecast's future-only output
  -- range overlaps them, giving the seeded forecast-anomaly months (and any
  -- other recent month) real forecast bounds to evaluate against.
  SELECT mr.revenue_month, mr.actual_revenue
  FROM monthly_revenue mr, bounds b
  WHERE mr.revenue_month <= ADD_MONTHS(b.max_actual_month, -24)
),
forecasted AS (
  SELECT * FROM ai_forecast(
    TABLE(training_revenue),
    horizon => (SELECT ADD_MONTHS(max_actual_month, 12) FROM bounds),
    time_col => 'revenue_month',
    value_col => 'actual_revenue',
    frequency => 'month',
    parameters => '{"global_floor": 0}'
  )
),
budgets AS (
  SELECT
    PERIOD_NAME,
    BUDGET_AMOUNT
  FROM cdm_tmforum.oracle_erp_source.gl_budgets
  WHERE ACCOUNT = '4000'
)
SELECT
  COALESCE(mr.revenue_month, f.revenue_month) AS revenue_month,
  mr.actual_revenue,
  f.actual_revenue_forecast AS forecast_revenue,
  f.actual_revenue_upper AS forecast_upper_bound,
  f.actual_revenue_lower AS forecast_lower_bound,
  b.BUDGET_AMOUNT AS budget_amount,
  -- Anomaly: actual outside confidence interval. Months with no actual yet
  -- (pure future) or no forecast coverage (training-window months) are NORMAL
  -- by construction -- there's nothing to compare.
  CASE
    WHEN mr.actual_revenue IS NULL OR f.actual_revenue_upper IS NULL THEN 'NORMAL'
    WHEN mr.actual_revenue > f.actual_revenue_upper THEN 'ABOVE_EXPECTED'
    WHEN mr.actual_revenue < f.actual_revenue_lower THEN 'BELOW_EXPECTED'
    ELSE 'NORMAL'
  END AS anomaly_status,
  -- Budget variance
  CASE
    WHEN b.BUDGET_AMOUNT IS NOT NULL AND b.BUDGET_AMOUNT > 0 AND mr.actual_revenue IS NOT NULL
    THEN ROUND((mr.actual_revenue - b.BUDGET_AMOUNT) / b.BUDGET_AMOUNT * 100, 2)
    ELSE NULL
  END AS budget_variance_pct,
  'ai_forecast' AS detection_method
FROM monthly_revenue mr
FULL OUTER JOIN forecasted f
  ON mr.revenue_month = f.revenue_month
LEFT JOIN budgets b
  ON b.PERIOD_NAME = DATE_FORMAT(COALESCE(mr.revenue_month, f.revenue_month), 'MMM-yy');


-- -----------------------------------------------------------------------------
-- DQ-6 Warehouse Audit
-- Warn when anomaly_status leaves the known set or revenue_month is not unique.
-- This audit stays beside the warehouse-created forecast MV so the Lakeflow
-- pipeline has no dependency on an object that may not exist on its first run.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies_dq_audit
COMMENT 'DQ-6 warn-level checks for forecast anomaly status validity and one row per revenue month.'
AS
WITH forecast_counts AS (
  SELECT
    COUNT(*) AS observed_records,
    COUNT(DISTINCT revenue_month) AS unique_months,
    SUM(CASE WHEN anomaly_status IN ('ABOVE_EXPECTED', 'BELOW_EXPECTED', 'NORMAL') THEN 1 ELSE 0 END) AS valid_status_records
  FROM cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies
)
SELECT
  'DQ-6' AS check_id,
  'cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies' AS dataset,
  'dq6_revenue_month_unique' AS expectation_name,
  'WARN' AS action,
  observed_records,
  unique_months AS passed_records,
  observed_records - unique_months AS failed_records,
  CASE WHEN observed_records = unique_months THEN 'GREEN' ELSE 'WARN' END AS status,
  'row_count = count(distinct revenue_month)' AS expected_condition
FROM forecast_counts
UNION ALL
SELECT
  'DQ-6' AS check_id,
  'cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies' AS dataset,
  'dq6_anomaly_status_in_known_set' AS expectation_name,
  'WARN' AS action,
  observed_records,
  valid_status_records AS passed_records,
  observed_records - valid_status_records AS failed_records,
  CASE WHEN observed_records = valid_status_records THEN 'GREEN' ELSE 'WARN' END AS status,
  'anomaly_status IN (ABOVE_EXPECTED, BELOW_EXPECTED, NORMAL)' AS expected_condition
FROM forecast_counts;
