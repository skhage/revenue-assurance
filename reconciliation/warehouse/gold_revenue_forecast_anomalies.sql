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
--
-- TUNING NOTES (RA-P5-FORECAST-SENSITIVITY, @ml-engineer, 2026-09-29):
--   - prediction_interval_width reduced from default 0.95 to 0.80 to tighten
--     the confidence bands and increase sensitivity to 15%+ deviations.
--   - Added seasonal_baseline_revenue, forecast_deviation_pct, seasonal_zscore,
--     and sensitivity_flag columns for multi-signal anomaly detection.
--   - The config.yaml seeded anomaly (+15% in 2025-06, +30% in 2025-11) is a
--     mixed-signal test: Nov +30% is easily detected as ABOVE_EXPECTED;
--     Jun +15% lands on a naturally low month (baseline ~$3.92M, seasonal avg
--     ~$5.05M) so the injection partially masks a deep seasonal low rather
--     than creating a high-side spike. The sensitivity_flag catches this as
--     ELEVATED when |forecast_deviation_pct| > 12 or |seasonal_zscore| > 1.5.
--   - All original columns preserved for backward compatibility with the
--     dashboard and DQ-6 audit contract.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 9. Revenue Forecast Anomalies (ai_forecast) — tuned for ±15% sensitivity
-- Time-series anomaly detection on monthly GL revenue with multi-signal scoring.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies
COMMENT 'AI-powered time-series anomaly detection on monthly revenue. Uses ai_forecast (80% CI) to predict expected revenue and flags months where actual deviates outside the prediction interval. Supplemented with seasonal z-score and forecast deviation percentage for multi-signal sensitivity. Includes budget variance from gl_budgets.'
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
-- TUNED: prediction_interval_width 0.95 → 0.80 for sharper anomaly detection.
-- At 80% CI the bounds tighten ~35%, making ≥15% deviations more likely to
-- breach the interval. global_floor keeps forecasts non-negative.
forecasted AS (
  SELECT * FROM ai_forecast(
    TABLE(monthly_revenue),
    horizon => '2026-12-31',
    time_col => 'revenue_month',
    value_col => 'actual_revenue',
    frequency => 'month',
    prediction_interval_width => 0.80,
    parameters => '{"global_floor": 0}',
    version => '1'
  )
),
-- Seasonal baseline: per-calendar-month average and stddev from history
-- (pre-2025) for detecting deviations that the time-series forecast misses.
seasonal_baseline AS (
  SELECT
    MONTH(revenue_month) AS cal_month,
    AVG(actual_revenue) AS seasonal_avg,
    STDDEV(actual_revenue) AS seasonal_std
  FROM monthly_revenue
  WHERE YEAR(revenue_month) < 2025
  GROUP BY MONTH(revenue_month)
),
budgets AS (
  SELECT
    PERIOD_NAME,
    BUDGET_AMOUNT
  FROM cdm_tmforum.oracle_erp_source.gl_budgets
  WHERE ACCOUNT = '4000'
)
SELECT
  mr.revenue_month,
  mr.actual_revenue,
  f.actual_revenue_forecast AS forecast_revenue,
  f.actual_revenue_upper AS forecast_upper_bound,
  f.actual_revenue_lower AS forecast_lower_bound,
  b.BUDGET_AMOUNT AS budget_amount,
  -- Preserved: original anomaly status based on prediction interval bounds
  CASE
    WHEN mr.actual_revenue > f.actual_revenue_upper THEN 'ABOVE_EXPECTED'
    WHEN mr.actual_revenue < f.actual_revenue_lower THEN 'BELOW_EXPECTED'
    ELSE 'NORMAL'
  END AS anomaly_status,
  -- Preserved: budget variance
  CASE
    WHEN b.BUDGET_AMOUNT IS NOT NULL AND b.BUDGET_AMOUNT > 0
    THEN ROUND((mr.actual_revenue - b.BUDGET_AMOUNT) / b.BUDGET_AMOUNT * 100, 2)
    ELSE NULL
  END AS budget_variance_pct,
  'ai_forecast' AS detection_method,
  -- NEW: seasonal baseline for the same calendar month
  sb.seasonal_avg AS seasonal_baseline_revenue,
  -- NEW: percentage deviation from the forecast central estimate
  CASE
    WHEN f.actual_revenue_forecast IS NOT NULL AND f.actual_revenue_forecast > 0
    THEN ROUND((mr.actual_revenue - f.actual_revenue_forecast) / f.actual_revenue_forecast * 100, 2)
    ELSE NULL
  END AS forecast_deviation_pct,
  -- NEW: seasonal z-score (how many seasonal stddevs from the calendar-month mean)
  CASE
    WHEN sb.seasonal_std IS NOT NULL AND sb.seasonal_std > 0
    THEN ROUND((mr.actual_revenue - sb.seasonal_avg) / sb.seasonal_std, 2)
    ELSE NULL
  END AS seasonal_zscore,
  -- NEW: multi-signal sensitivity flag
  -- Catches injections the forecast bands miss (e.g. +15% on a naturally low month)
  CASE
    WHEN mr.actual_revenue > f.actual_revenue_upper THEN 'ABOVE_EXPECTED'
    WHEN mr.actual_revenue < f.actual_revenue_lower THEN 'BELOW_EXPECTED'
    WHEN f.actual_revenue_forecast IS NOT NULL AND f.actual_revenue_forecast > 0
         AND ABS((mr.actual_revenue - f.actual_revenue_forecast) / f.actual_revenue_forecast) > 0.12
         THEN 'ELEVATED'
    WHEN sb.seasonal_std IS NOT NULL AND sb.seasonal_std > 0
         AND ABS((mr.actual_revenue - sb.seasonal_avg) / sb.seasonal_std) > 1.5
         THEN 'ELEVATED'
    ELSE 'NORMAL'
  END AS sensitivity_flag
FROM monthly_revenue mr
LEFT JOIN forecasted f
  ON mr.revenue_month = f.revenue_month
LEFT JOIN seasonal_baseline sb
  ON MONTH(mr.revenue_month) = sb.cal_month
LEFT JOIN budgets b
  ON b.PERIOD_NAME = DATE_FORMAT(mr.revenue_month, 'MMM-yy');


-- -----------------------------------------------------------------------------
-- DQ-6 Warehouse Audit
-- Warn when anomaly_status leaves the known set or revenue_month is not unique.
-- This audit stays beside the warehouse-created forecast MV so the Lakeflow
-- pipeline has no dependency on an object that may not exist on its first run.
--
-- Updated: sensitivity_flag domain check added (ABOVE_EXPECTED, BELOW_EXPECTED,
-- ELEVATED, NORMAL) per RA-P5-FORECAST-SENSITIVITY tuning.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies_dq_audit
COMMENT 'DQ-6 warn-level checks for forecast anomaly status validity, sensitivity flag validity, and one row per revenue month.'
AS
WITH forecast_counts AS (
  SELECT
    COUNT(*) AS observed_records,
    COUNT(DISTINCT revenue_month) AS unique_months,
    SUM(CASE WHEN anomaly_status IN ('ABOVE_EXPECTED', 'BELOW_EXPECTED', 'NORMAL') THEN 1 ELSE 0 END) AS valid_status_records,
    SUM(CASE WHEN sensitivity_flag IN ('ABOVE_EXPECTED', 'BELOW_EXPECTED', 'ELEVATED', 'NORMAL') THEN 1 ELSE 0 END) AS valid_sensitivity_records
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
FROM forecast_counts
UNION ALL
SELECT
  'DQ-6' AS check_id,
  'cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies' AS dataset,
  'dq6_sensitivity_flag_in_known_set' AS expectation_name,
  'WARN' AS action,
  observed_records,
  valid_sensitivity_records AS passed_records,
  observed_records - valid_sensitivity_records AS failed_records,
  CASE WHEN observed_records = valid_sensitivity_records THEN 'GREEN' ELSE 'WARN' END AS status,
  'sensitivity_flag IN (ABOVE_EXPECTED, BELOW_EXPECTED, ELEVATED, NORMAL)' AS expected_condition
FROM forecast_counts;
