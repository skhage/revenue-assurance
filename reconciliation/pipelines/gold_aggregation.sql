-- =============================================================================
-- Gold Layer: Aggregated Intelligence
-- Lakeflow Declarative Pipeline source. Part of `ra_medallion_pipeline`.
--
-- Unified leakage register + per-customer health scorecard. These are the
-- serving surfaces the AI/BI dashboard, Genie, and the RA Exceptions Console
-- read, so the column contract here is load-bearing:
-- ra-exceptions-console/config/queries/*.sql select these names by hand.
--
-- IN-PIPELINE REFERENCES: the silver datasets are referenced by BARE NAME
--   (`silver_ar_aging_analysis`, not a 3-part name). That is what makes these
--   gold views true downstream nodes of the pipeline DAG rather than loose
--   warehouse DDL reading a table that happens to exist.
--
-- NOT IN THIS FILE:
--   * `gold_anomaly_scores` — owned by the separate ML workstream. It is NOT
--     defined here and this file does not reference it, so the pipeline is
--     complete and green without it. The AI/BI dashboard does have a tile bound
--     to `gold_anomaly_scores`; that tile will error until the ML workstream
--     lands the object. That is a pre-existing gap, not one introduced here, and
--     no placeholder is invented for it.
--   * Revenue forecasting stays warehouse-executed because `ai_forecast` is not
--     part of this pipeline DAG. The warehouse SQL also owns its DQ-6 checks, so
--     this pipeline has no first-run dependency on that separately built object.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 8. Unified Leakage Summary
-- Union of all silver checks into one register for dashboard consumption.
--
-- DQ-4: `check_type` in the 7 known types; `severity` in {HIGH, MEDIUM};
--   `amount_at_risk` >= 0. Action: FAIL UPDATE — the test plan specifies "fail".
--   This is the correct place to be strict: this register IS the demo's headline
--   number (~48K exceptions / ~$601M at risk) and the app's queue. A bad
--   check_type here silently breaks the dashboard's GROUP BY and the app's
--   filters, so the update should stop rather than publish a corrupt register.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW gold_leakage_summary (
  CONSTRAINT dq4_check_type_in_known_set
    EXPECT (check_type IN (
      'contract_price_mismatch',
      'unauthorized_discount',
      'expired_quote_active',
      'doc_contract_mismatch',
      'doc_invoice_mismatch',
      'rev_rec_timing_mismatch',
      'ar_collection_risk'
    )) ON VIOLATION FAIL UPDATE,
  CONSTRAINT dq4_severity_in_known_set
    EXPECT (severity IN ('HIGH', 'MEDIUM')) ON VIOLATION FAIL UPDATE,
  CONSTRAINT dq4_amount_at_risk_non_negative
    EXPECT (amount_at_risk >= 0) ON VIOLATION FAIL UPDATE
)
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
FROM silver_contract_price_reconciliation
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
FROM silver_discount_authorization_check
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
FROM silver_discount_authorization_check
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
FROM silver_doc_intelligence_contracts
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
FROM silver_doc_intelligence_invoices
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
FROM silver_revenue_recognition_check
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
FROM silver_ar_aging_analysis
WHERE collection_risk = 'HIGH';


-- -----------------------------------------------------------------------------
-- 10. Reconciliation Scorecard
-- Per-customer health score for dashboard consumption.
--
-- DQ-5: `composite_health_score` in [0,100]; `risk_tier` in {GREEN, AMBER, RED}.
--   Action: FAIL UPDATE per the test plan. The "one row per scored customer"
--   half of DQ-5 is a set-level uniqueness property — it cannot be expressed as
--   a row expectation (no aggregates or subqueries allowed), so it is enforced by
--   `dq_audit_scorecard_uniqueness` in dq_audit.sql.
--
-- REFACTOR NOTE: the composite score was previously written out THREE times —
--   once for `composite_health_score` and twice more inside the `risk_tier` CASE.
--   The four component scores were each computed twice. That is now computed once
--   in the `scored` CTE. Semantics are unchanged: same weights (0.35 / 0.25 /
--   0.20 / 0.20), same COALESCE-to-100 for customers with no rows in a check,
--   same GREEN >= 90 / AMBER >= 70 / else RED thresholds, same rounding of the
--   published score. Collapsing it matters now that DQ-5 gates on the value:
--   with three copies, a future edit to one could make `risk_tier` disagree with
--   `composite_health_score` and fail the update in a confusing way.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW gold_reconciliation_scorecard (
  CONSTRAINT dq5_composite_health_score_in_range
    EXPECT (composite_health_score BETWEEN 0 AND 100) ON VIOLATION FAIL UPDATE,
  CONSTRAINT dq5_risk_tier_in_known_set
    EXPECT (risk_tier IN ('GREEN', 'AMBER', 'RED')) ON VIOLATION FAIL UPDATE,
  CONSTRAINT dq5_customer_id_present
    EXPECT (customer_id IS NOT NULL) ON VIOLATION FAIL UPDATE
)
COMMENT 'Per-customer reconciliation health scorecard. Aggregates all silver checks into a single score per customer: price accuracy, discount compliance, collection efficiency, and doc-vs-system consistency.'
AS
WITH price_check AS (
  SELECT
    customer_id,
    COUNT(*) AS total_lines,
    SUM(CASE WHEN leakage_flag IS NOT NULL THEN 1 ELSE 0 END) AS price_exceptions,
    SUM(estimated_amount_at_risk) AS price_risk_amount
  FROM silver_contract_price_reconciliation
  GROUP BY customer_id
),
discount_check AS (
  SELECT
    customer_id,
    COUNT(*) AS total_quotes,
    SUM(CASE WHEN unauthorized_discount = TRUE THEN 1 ELSE 0 END) AS discount_exceptions,
    SUM(discount_overrun_amount) AS discount_risk_amount
  FROM silver_discount_authorization_check
  GROUP BY customer_id
),
collection_check AS (
  SELECT
    customer_id,
    SUM(total_outstanding) AS total_outstanding,
    MAX(estimated_dso_days) AS max_dso_days,
    MAX(CASE WHEN collection_risk = 'HIGH' THEN 1 ELSE 0 END) AS has_high_risk_ar
  FROM silver_ar_aging_analysis
  GROUP BY customer_id
),
doc_check AS (
  SELECT
    customer_id,
    COUNT(*) AS total_docs,
    SUM(CASE WHEN total_mismatches > 0 THEN 1 ELSE 0 END) AS doc_exceptions
  FROM silver_doc_intelligence_contracts
  WHERE customer_id IS NOT NULL
  GROUP BY customer_id
),
-- Component scores computed exactly once each.
scored AS (
  SELECT
    cust.customer_id,
    a.Name AS account_name,
    cust.account_status,
    cust.arpu_tier,
    cust.billing_currency,
    100.0 * (1 - COALESCE(pc.price_exceptions, 0) / NULLIF(pc.total_lines, 0)) AS price_accuracy_score,
    100.0 * (1 - COALESCE(dc.discount_exceptions, 0) / NULLIF(dc.total_quotes, 0)) AS discount_compliance_score,
    CASE
      WHEN COALESCE(cc.max_dso_days, 0) <= 30 THEN 100.0
      WHEN cc.max_dso_days <= 60 THEN 75.0
      WHEN cc.max_dso_days <= 90 THEN 50.0
      ELSE 25.0
    END AS collection_efficiency_score,
    100.0 * (1 - COALESCE(docc.doc_exceptions, 0) / NULLIF(docc.total_docs, 0)) AS doc_consistency_score,
    COALESCE(pc.price_risk_amount, 0) + COALESCE(dc.discount_risk_amount, 0) AS total_amount_at_risk,
    COALESCE(pc.price_exceptions, 0) + COALESCE(dc.discount_exceptions, 0) + COALESCE(docc.doc_exceptions, 0) AS total_exceptions
  FROM tmf_customer.customer cust
  LEFT JOIN salesforce_source.account a
    ON a.TMF_Customer_Id__c = cust.customer_id
  LEFT JOIN price_check pc ON pc.customer_id = cust.customer_id
  LEFT JOIN discount_check dc ON dc.customer_id = cust.customer_id
  LEFT JOIN collection_check cc ON cc.customer_id = cust.customer_id
  LEFT JOIN doc_check docc ON docc.customer_id = cust.customer_id
),
-- Composite computed exactly once. A customer with no rows in a given check
-- scores 100 for that component (nothing found wrong), matching the original.
composite AS (
  SELECT
    *,
    0.35 * COALESCE(price_accuracy_score, 100)
      + 0.25 * COALESCE(discount_compliance_score, 100)
      + 0.20 * collection_efficiency_score
      + 0.20 * COALESCE(doc_consistency_score, 100) AS composite_raw
  FROM scored
)
SELECT
  customer_id,
  account_name,
  account_status,
  arpu_tier,
  billing_currency,
  ROUND(price_accuracy_score, 1) AS price_accuracy_score,
  ROUND(discount_compliance_score, 1) AS discount_compliance_score,
  collection_efficiency_score,
  ROUND(doc_consistency_score, 1) AS doc_consistency_score,
  ROUND(composite_raw, 1) AS composite_health_score,
  CASE
    WHEN composite_raw >= 90 THEN 'GREEN'
    WHEN composite_raw >= 70 THEN 'AMBER'
    ELSE 'RED'
  END AS risk_tier,
  total_amount_at_risk,
  total_exceptions
FROM composite;
