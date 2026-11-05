-- silver_dispute_credit_reconciliation: check type #12 view (cdm_tmforum.revenue_assurance).
-- Exported from SHOW CREATE TABLE on 2026-11-05. The live definition includes the
-- RA-DE-FIX-FRAUD-ACCEPTED-FANOUT-1103 fix (2026-11-03): sub-check 12c uses an EXISTS semi-join on
-- tmf_customer.disputed_amount instead of a customer-level JOIN that fanned out 10.8x.
-- Source control copy for RA-DEVOPS-DISPUTE-CREDIT-SQL-DRIFT-1103 (DEC-PM-DISPUTE-VIEW-TRACKED-1104).
-- Reads tmf_customer (read-only) and gold_anomaly_scores. Run on a SQL warehouse.

CREATE OR REPLACE VIEW cdm_tmforum.revenue_assurance.silver_dispute_credit_reconciliation (
  billing_dispute_id COMMENT 'FK to tmf_customer.billing_dispute — source dispute identifier. NOT unique in this view: one dispute may join to multiple bill_adjustment rows and appear across multiple sub-checks (12a-12e). Grain is one row per dispute-adjustment-subcheck combination (no exact-duplicate rows since the 2026-11-03 12c EXISTS fix).',
  customer_id COMMENT 'FK to tmf_customer.customer — associated with this billing dispute',
  bill_id COMMENT 'FK to tmf_customer.bill — associated with this billing dispute',
  dispute_number COMMENT 'Dispute number of this billing dispute',
  dispute_type COMMENT 'Dispute type of this billing dispute',
  dispute_state COMMENT 'Dispute state of this billing dispute',
  reason_code COMMENT 'Reason code of this billing dispute',
  reason_description COMMENT 'Reason description of this billing dispute',
  disputed_amount COMMENT 'Original disputed dollar amount on this billing dispute',
  adjusted_amount COMMENT 'Total adjusted amount applied to this billing dispute',
  credit_amount COMMENT 'Credit amount from the associated bill adjustment',
  adjustment_type COMMENT 'Adjustment type of this bill adjustment',
  approval_status COMMENT 'Approval status of this bill adjustment',
  adjustment_status COMMENT 'Current lifecycle status of this bill adjustment',
  adjustment_reason COMMENT 'Reason code of this bill adjustment',
  raised_date COMMENT 'Date when this billing dispute was raised',
  actual_resolution_date COMMENT 'Date when this billing dispute was actual resolution',
  sub_check COMMENT 'RA sub-check classification (12a-12e): rejected_with_credit, withdrawn_with_credit, fraud_accepted, over_credited, double_jeopardy',
  severity COMMENT 'Exception severity level: CRITICAL, HIGH, or MEDIUM — based on sub-check type and threshold',
  finding COMMENT 'Human-readable finding description for this specific dispute/credit exception')
COMMENT 'Silver check type #12: Inbound credit/dispute leakage reconciliation. Five sub-checks: (12a) rejected disputes with approved credits, (12b) withdrawn disputes with unreversed credits, (12c) fraud-flagged disputes accepted without proper escalation, (12d) over-credited adjustments (credit > disputed amount by >10pct), (12e) double-jeopardy customers with both dispute credits and outbound RA exceptions. Source: tmf_customer.billing_dispute + bill_adjustment + disputed_amount. Built by @ai-engineer. 2026-11-03 @data-engineer: 12c uses EXISTS semi-join on disputed_amount (fraud_indicator_flag AND state=accepted) to remove 10.8x customer-level fanout (RA-DE-FIX-FRAUD-ACCEPTED-FANOUT-1103).'
WITH SCHEMA COMPENSATION
AS WITH
rejected_credited AS (
  SELECT bd.billing_dispute_id, bd.customer_id, bd.bill_id, bd.dispute_number, bd.dispute_type, bd.dispute_state,
    bd.reason_code, bd.reason_description,
    CAST(bd.disputed_amount AS DOUBLE) AS disputed_amount, CAST(bd.adjusted_amount AS DOUBLE) AS adjusted_amount,
    CAST(ba.adjustment_amount AS DOUBLE) AS credit_amount, ba.adjustment_type, ba.approval_status,
    ba.status AS adjustment_status, ba.reason_code AS adjustment_reason, bd.raised_date, bd.actual_resolution_date,
    'rejected_with_credit' AS sub_check, 'CRITICAL' AS severity,
    CONCAT('Dispute ', bd.dispute_number, ' rejected but $', ROUND(CAST(ba.adjustment_amount AS DOUBLE), 2), ' credit still approved') AS finding
  FROM cdm_tmforum.tmf_customer.billing_dispute bd
  JOIN cdm_tmforum.tmf_customer.bill_adjustment ba ON bd.billing_dispute_id = ba.billing_dispute_id
  WHERE bd.dispute_state = 'rejected' AND ba.approval_status = 'approved'
),
withdrawn_credited AS (
  SELECT bd.billing_dispute_id, bd.customer_id, bd.bill_id, bd.dispute_number, bd.dispute_type, bd.dispute_state,
    bd.reason_code, bd.reason_description,
    CAST(bd.disputed_amount AS DOUBLE) AS disputed_amount, CAST(bd.adjusted_amount AS DOUBLE) AS adjusted_amount,
    CAST(ba.adjustment_amount AS DOUBLE) AS credit_amount, ba.adjustment_type, ba.approval_status,
    ba.status AS adjustment_status, ba.reason_code AS adjustment_reason, bd.raised_date, bd.actual_resolution_date,
    'withdrawn_with_credit' AS sub_check, 'HIGH' AS severity,
    CONCAT('Dispute ', bd.dispute_number, ' withdrawn but $', ROUND(CAST(ba.adjustment_amount AS DOUBLE), 2), ' credit not reversed') AS finding
  FROM cdm_tmforum.tmf_customer.billing_dispute bd
  JOIN cdm_tmforum.tmf_customer.bill_adjustment ba ON bd.billing_dispute_id = ba.billing_dispute_id
  WHERE bd.dispute_state = 'withdrawn' AND ba.approval_status = 'approved'
),
fraud_accepted AS (
  SELECT bd.billing_dispute_id, bd.customer_id, bd.bill_id, bd.dispute_number, bd.dispute_type, bd.dispute_state,
    bd.reason_code, bd.reason_description,
    CAST(bd.disputed_amount AS DOUBLE) AS disputed_amount, CAST(bd.adjusted_amount AS DOUBLE) AS adjusted_amount,
    CAST(ba.adjustment_amount AS DOUBLE) AS credit_amount, ba.adjustment_type, ba.approval_status,
    ba.status AS adjustment_status, ba.reason_code AS adjustment_reason, bd.raised_date, bd.actual_resolution_date,
    'fraud_accepted' AS sub_check, 'CRITICAL' AS severity,
    CONCAT('Fraud-flagged dispute ', bd.dispute_number, ' from ', bd.channel, ' accepted: $', ROUND(CAST(bd.disputed_amount AS DOUBLE), 2)) AS finding
  FROM cdm_tmforum.tmf_customer.billing_dispute bd
  JOIN cdm_tmforum.tmf_customer.bill_adjustment ba ON bd.billing_dispute_id = ba.billing_dispute_id
  WHERE (bd.dispute_type = 'fraud_claim' OR bd.dispute_category = 'fraud')
    AND EXISTS (
      SELECT 1 FROM cdm_tmforum.tmf_customer.disputed_amount da
      WHERE da.customer_id = bd.customer_id
        AND da.fraud_indicator_flag = true
        AND da.state = 'accepted'
    )
),
over_credited AS (
  SELECT bd.billing_dispute_id, bd.customer_id, bd.bill_id, bd.dispute_number, bd.dispute_type, bd.dispute_state,
    bd.reason_code, bd.reason_description,
    CAST(bd.disputed_amount AS DOUBLE) AS disputed_amount, CAST(bd.adjusted_amount AS DOUBLE) AS adjusted_amount,
    CAST(ba.adjustment_amount AS DOUBLE) AS credit_amount, ba.adjustment_type, ba.approval_status,
    ba.status AS adjustment_status, ba.reason_code AS adjustment_reason, bd.raised_date, bd.actual_resolution_date,
    'over_credited' AS sub_check,
    CASE
      WHEN CAST(ba.adjustment_amount AS DOUBLE) > CAST(bd.disputed_amount AS DOUBLE) * 1.5 THEN 'CRITICAL'
      WHEN CAST(ba.adjustment_amount AS DOUBLE) > CAST(bd.disputed_amount AS DOUBLE) * 1.25 THEN 'HIGH'
      ELSE 'MEDIUM'
    END AS severity,
    CONCAT('Credit $', ROUND(CAST(ba.adjustment_amount AS DOUBLE), 2),
           ' exceeds disputed $', ROUND(CAST(bd.disputed_amount AS DOUBLE), 2),
           ' by ', ROUND((CAST(ba.adjustment_amount AS DOUBLE) / NULLIF(CAST(bd.disputed_amount AS DOUBLE), 0) - 1) * 100, 1), '%') AS finding
  FROM cdm_tmforum.tmf_customer.billing_dispute bd
  JOIN cdm_tmforum.tmf_customer.bill_adjustment ba ON bd.billing_dispute_id = ba.billing_dispute_id
  WHERE CAST(ba.adjustment_amount AS DOUBLE) > CAST(bd.disputed_amount AS DOUBLE) * 1.1
    AND CAST(bd.disputed_amount AS DOUBLE) > 0
),
double_jeopardy AS (
  SELECT bd.billing_dispute_id, bd.customer_id, bd.bill_id, bd.dispute_number, bd.dispute_type, bd.dispute_state,
    bd.reason_code, bd.reason_description,
    CAST(bd.disputed_amount AS DOUBLE) AS disputed_amount, CAST(bd.adjusted_amount AS DOUBLE) AS adjusted_amount,
    CAST(ba.adjustment_amount AS DOUBLE) AS credit_amount, ba.adjustment_type, ba.approval_status,
    ba.status AS adjustment_status, ba.reason_code AS adjustment_reason, bd.raised_date, bd.actual_resolution_date,
    'double_jeopardy' AS sub_check, 'HIGH' AS severity,
    CONCAT('Customer ', bd.customer_id, ' has $', ROUND(CAST(ba.adjustment_amount AS DOUBLE), 2), ' dispute credit AND $',
           ROUND(gl.total_leakage, 2), ' outbound RA exceptions — potential double recovery') AS finding
  FROM cdm_tmforum.tmf_customer.billing_dispute bd
  JOIN cdm_tmforum.tmf_customer.bill_adjustment ba ON bd.billing_dispute_id = ba.billing_dispute_id
  JOIN (
    SELECT customer_id, SUM(amount_at_risk) AS total_leakage
    FROM cdm_tmforum.revenue_assurance.gold_anomaly_scores
    GROUP BY customer_id
  ) gl ON bd.customer_id = gl.customer_id
  WHERE ba.approval_status = 'approved'
    AND bd.dispute_state NOT IN ('rejected', 'withdrawn')
)
SELECT * FROM rejected_credited
UNION ALL SELECT * FROM withdrawn_credited
UNION ALL SELECT * FROM fraud_accepted
UNION ALL SELECT * FROM over_credited
UNION ALL SELECT * FROM double_jeopardy
