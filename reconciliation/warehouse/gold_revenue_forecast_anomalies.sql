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
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies
COMMENT 'AI-powered time-series anomaly detection on monthly revenue. Uses ai_forecast to predict expected revenue, then flags months where actual deviates > 2 standard deviations. Includes budget variance from gl_budgets.'
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
forecasted AS (
  SELECT * FROM ai_forecast(
    TABLE(monthly_revenue),
    horizon => '2026-12-31',
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
  mr.revenue_month,
  mr.actual_revenue,
  f.actual_revenue_forecast AS forecast_revenue,
  f.actual_revenue_upper AS forecast_upper_bound,
  f.actual_revenue_lower AS forecast_lower_bound,
  b.BUDGET_AMOUNT AS budget_amount,
  -- Anomaly: actual outside confidence interval
  CASE
    WHEN mr.actual_revenue > f.actual_revenue_upper THEN 'ABOVE_EXPECTED'
    WHEN mr.actual_revenue < f.actual_revenue_lower THEN 'BELOW_EXPECTED'
    ELSE 'NORMAL'
  END AS anomaly_status,
  -- Budget variance
  CASE
    WHEN b.BUDGET_AMOUNT IS NOT NULL AND b.BUDGET_AMOUNT > 0
    THEN ROUND((mr.actual_revenue - b.BUDGET_AMOUNT) / b.BUDGET_AMOUNT * 100, 2)
    ELSE NULL
  END AS budget_variance_pct,
  'ai_forecast' AS detection_method
FROM monthly_revenue mr
LEFT JOIN forecasted f
  ON mr.revenue_month = f.revenue_month
LEFT JOIN budgets b
  ON b.PERIOD_NAME = DATE_FORMAT(mr.revenue_month, 'MMM-yy');
