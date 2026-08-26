-- Single exception + the customer's reconciliation scorecard, for the detail drawer.
-- Keyed by the synthesized exception_id (must match exceptions_list.sql).
-- @param exception_id STRING = 0
SELECT
  s.exception_id,
  s.reference_id,
  s.account_name,
  s.check_type,
  s.severity,
  s.amount_at_risk,
  s.detection_method,
  s.source_table,
  s.customer_id,
  s.known_leakage_flag,
  sc.risk_tier,
  sc.composite_health_score,
  sc.arpu_tier,
  sc.billing_currency,
  sc.account_status,
  sc.price_accuracy_score,
  sc.discount_compliance_score,
  sc.collection_efficiency_score,
  sc.doc_consistency_score,
  sc.total_exceptions AS customer_total_exceptions,
  sc.total_amount_at_risk AS customer_total_at_risk
FROM (
  SELECT *,
    md5(concat_ws('|', check_type, coalesce(reference_id, ''),
         coalesce(cast(customer_id AS string), ''), cast(amount_at_risk AS string))) AS exception_id
  FROM cdm_tmforum.revenue_assurance.gold_leakage_summary
) s
LEFT JOIN cdm_tmforum.revenue_assurance.gold_reconciliation_scorecard sc
  ON sc.customer_id = s.customer_id
WHERE s.exception_id = :exception_id
LIMIT 1;
