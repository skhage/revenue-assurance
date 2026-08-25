-- =============================================================================
-- Gold Layer: Aggregated Intelligence
-- Unified leakage register, AI-powered forecast anomalies, and health scorecard.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 8. Unified Leakage Summary
-- Union of all silver checks into one register for dashboard consumption.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.gold_leakage_summary
COMMENT 'Unified revenue leakage register combining all silver-layer reconciliation checks. Each row is one detected exception with severity, amount at risk, and detection method (rule-based vs AI-extracted).'
AS
-- Contract price mismatches (seeded leakage ground truth)
SELECT
  'contract_price_mismatch' AS check_type,
  CASE WHEN leakage_flag = 'price_mismatch' THEN 'HIGH' ELSE 'MEDIUM' END AS severity,
  customer_id,
  account_name,
  estimated_amount_at_risk AS amount_at_risk,
  'salesforce_source.contract_line_item' AS source_table,
  detection_method,
  CAST(TRUE AS BOOLEAN) AS known_leakage_flag,
  ContractNumber AS reference_id
FROM cdm_tmforum.revenue_assurance.silver_contract_price_reconciliation
WHERE leakage_flag IS NOT NULL

UNION ALL

-- Unauthorized discounts
SELECT
  'unauthorized_discount' AS check_type,
  'HIGH' AS severity,
  customer_id,
  account_name,
  discount_overrun_amount AS amount_at_risk,
  'salesforce_source.sbqq__quoteline__c' AS source_table,
  detection_method,
  FALSE AS known_leakage_flag,
  quote_id AS reference_id
FROM cdm_tmforum.revenue_assurance.silver_discount_authorization_check
WHERE unauthorized_discount = TRUE

UNION ALL

-- Expired quotes still active
SELECT
  'expired_quote_active' AS check_type,
  'MEDIUM' AS severity,
  customer_id,
  account_name,
  0.0 AS amount_at_risk,
  'salesforce_source.sbqq__quote__c' AS source_table,
  detection_method,
  FALSE AS known_leakage_flag,
  quote_id AS reference_id
FROM cdm_tmforum.revenue_assurance.silver_discount_authorization_check
WHERE expired_quote_still_active = TRUE

UNION ALL

-- Document-vs-database contract mismatches
SELECT
  'doc_contract_mismatch' AS check_type,
  'HIGH' AS severity,
  CAST(customer_id AS BIGINT) AS customer_id,
  account_name,
  0.0 AS amount_at_risk,
  'ironclad_clm_source.contract_pdfs' AS source_table,
  'ai_extracted' AS detection_method,
  FALSE AS known_leakage_flag,
  doc_contract_number AS reference_id
FROM cdm_tmforum.revenue_assurance.silver_doc_intelligence_contracts
WHERE total_mismatches > 0

UNION ALL

-- Document-vs-database invoice amount mismatches
SELECT
  'doc_invoice_mismatch' AS check_type,
  'HIGH' AS severity,
  NULL AS customer_id,
  NULL AS account_name,
  amount_variance AS amount_at_risk,
  'ironclad_clm_source.invoice_pdfs' AS source_table,
  'ai_extracted' AS detection_method,
  FALSE AS known_leakage_flag,
  doc_invoice_number AS reference_id
FROM cdm_tmforum.revenue_assurance.silver_doc_intelligence_invoices
WHERE amount_mismatch = TRUE

UNION ALL

-- Revenue recognition timing mismatches
SELECT
  'rev_rec_timing_mismatch' AS check_type,
  'MEDIUM' AS severity,
  NULL AS customer_id,
  NULL AS account_name,
  ABS(recognition_variance) AS amount_at_risk,
  'oracle_erp_source.revenue_recognition_schedule' AS source_table,
  detection_method,
  FALSE AS known_leakage_flag,
  PERIOD_NAME AS reference_id
FROM cdm_tmforum.revenue_assurance.silver_revenue_recognition_check
WHERE material_timing_mismatch = TRUE

UNION ALL

-- High-risk AR aging (90+ days)
SELECT
  'ar_collection_risk' AS check_type,
  'HIGH' AS severity,
  customer_id,
  customer_name AS account_name,
  total_outstanding AS amount_at_risk,
  'oracle_erp_source.ar_payment_schedules_all' AS source_table,
  detection_method,
  FALSE AS known_leakage_flag,
  CAST(BILL_TO_CUSTOMER_ID AS STRING) AS reference_id
FROM cdm_tmforum.revenue_assurance.silver_ar_aging_analysis
WHERE collection_risk = 'HIGH';


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


-- -----------------------------------------------------------------------------
-- 10. Reconciliation Scorecard
-- Per-customer health score for dashboard consumption.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.gold_reconciliation_scorecard
COMMENT 'Per-customer reconciliation health scorecard. Aggregates all silver checks into a single score per customer: price accuracy, discount compliance, collection efficiency, and doc-vs-system consistency.'
AS
WITH price_check AS (
  SELECT
    customer_id,
    COUNT(*) AS total_lines,
    SUM(CASE WHEN leakage_flag IS NOT NULL THEN 1 ELSE 0 END) AS price_exceptions,
    SUM(estimated_amount_at_risk) AS price_risk_amount
  FROM cdm_tmforum.revenue_assurance.silver_contract_price_reconciliation
  GROUP BY customer_id
),
discount_check AS (
  SELECT
    customer_id,
    COUNT(*) AS total_quotes,
    SUM(CASE WHEN unauthorized_discount = TRUE THEN 1 ELSE 0 END) AS discount_exceptions,
    SUM(discount_overrun_amount) AS discount_risk_amount
  FROM cdm_tmforum.revenue_assurance.silver_discount_authorization_check
  GROUP BY customer_id
),
collection_check AS (
  SELECT
    customer_id,
    SUM(total_outstanding) AS total_outstanding,
    MAX(estimated_dso_days) AS max_dso_days,
    MAX(CASE WHEN collection_risk = 'HIGH' THEN 1 ELSE 0 END) AS has_high_risk_ar
  FROM cdm_tmforum.revenue_assurance.silver_ar_aging_analysis
  GROUP BY customer_id
),
doc_check AS (
  SELECT
    customer_id,
    COUNT(*) AS total_docs,
    SUM(CASE WHEN total_mismatches > 0 THEN 1 ELSE 0 END) AS doc_exceptions
  FROM cdm_tmforum.revenue_assurance.silver_doc_intelligence_contracts
  WHERE customer_id IS NOT NULL
  GROUP BY customer_id
)
SELECT
  cust.customer_id,
  a.Name AS account_name,
  cust.account_status,
  cust.arpu_tier,
  cust.billing_currency,
  -- Component scores (0-100 scale, 100 = perfect)
  ROUND(100.0 * (1 - COALESCE(pc.price_exceptions, 0) / NULLIF(pc.total_lines, 0)), 1) AS price_accuracy_score,
  ROUND(100.0 * (1 - COALESCE(dc.discount_exceptions, 0) / NULLIF(dc.total_quotes, 0)), 1) AS discount_compliance_score,
  CASE
    WHEN COALESCE(cc.max_dso_days, 0) <= 30 THEN 100.0
    WHEN cc.max_dso_days <= 60 THEN 75.0
    WHEN cc.max_dso_days <= 90 THEN 50.0
    ELSE 25.0
  END AS collection_efficiency_score,
  ROUND(100.0 * (1 - COALESCE(docc.doc_exceptions, 0) / NULLIF(docc.total_docs, 0)), 1) AS doc_consistency_score,
  -- Composite health score (weighted average)
  ROUND(
    0.35 * COALESCE(100.0 * (1 - COALESCE(pc.price_exceptions, 0) / NULLIF(pc.total_lines, 0)), 100) +
    0.25 * COALESCE(100.0 * (1 - COALESCE(dc.discount_exceptions, 0) / NULLIF(dc.total_quotes, 0)), 100) +
    0.20 * CASE WHEN COALESCE(cc.max_dso_days, 0) <= 30 THEN 100.0 WHEN cc.max_dso_days <= 60 THEN 75.0 WHEN cc.max_dso_days <= 90 THEN 50.0 ELSE 25.0 END +
    0.20 * COALESCE(100.0 * (1 - COALESCE(docc.doc_exceptions, 0) / NULLIF(docc.total_docs, 0)), 100)
  , 1) AS composite_health_score,
  -- Risk tier
  CASE
    WHEN (
      0.35 * COALESCE(100.0 * (1 - COALESCE(pc.price_exceptions, 0) / NULLIF(pc.total_lines, 0)), 100) +
      0.25 * COALESCE(100.0 * (1 - COALESCE(dc.discount_exceptions, 0) / NULLIF(dc.total_quotes, 0)), 100) +
      0.20 * CASE WHEN COALESCE(cc.max_dso_days, 0) <= 30 THEN 100.0 WHEN cc.max_dso_days <= 60 THEN 75.0 WHEN cc.max_dso_days <= 90 THEN 50.0 ELSE 25.0 END +
      0.20 * COALESCE(100.0 * (1 - COALESCE(docc.doc_exceptions, 0) / NULLIF(docc.total_docs, 0)), 100)
    ) >= 90 THEN 'GREEN'
    WHEN (
      0.35 * COALESCE(100.0 * (1 - COALESCE(pc.price_exceptions, 0) / NULLIF(pc.total_lines, 0)), 100) +
      0.25 * COALESCE(100.0 * (1 - COALESCE(dc.discount_exceptions, 0) / NULLIF(dc.total_quotes, 0)), 100) +
      0.20 * CASE WHEN COALESCE(cc.max_dso_days, 0) <= 30 THEN 100.0 WHEN cc.max_dso_days <= 60 THEN 75.0 WHEN cc.max_dso_days <= 90 THEN 50.0 ELSE 25.0 END +
      0.20 * COALESCE(100.0 * (1 - COALESCE(docc.doc_exceptions, 0) / NULLIF(docc.total_docs, 0)), 100)
    ) >= 70 THEN 'AMBER'
    ELSE 'RED'
  END AS risk_tier,
  -- Totals
  COALESCE(pc.price_risk_amount, 0) + COALESCE(dc.discount_risk_amount, 0) AS total_amount_at_risk,
  COALESCE(pc.price_exceptions, 0) + COALESCE(dc.discount_exceptions, 0) + COALESCE(docc.doc_exceptions, 0) AS total_exceptions
FROM cdm_tmforum.tmf_customer.customer cust
LEFT JOIN cdm_tmforum.salesforce_source.account a
  ON a.TMF_Customer_Id__c = cust.customer_id
LEFT JOIN price_check pc ON pc.customer_id = cust.customer_id
LEFT JOIN discount_check dc ON dc.customer_id = cust.customer_id
LEFT JOIN collection_check cc ON cc.customer_id = cust.customer_id
LEFT JOIN doc_check docc ON docc.customer_id = cust.customer_id;
