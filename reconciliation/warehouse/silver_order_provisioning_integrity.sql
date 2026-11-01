-- silver_order_provisioning_integrity: UC view (cdm_tmforum.revenue_assurance), Check Type #28.
-- Exported from SHOW CREATE TABLE on 2026-11-01. Live definition includes the #511
-- RA-BUG-ORDER-PROV-FANOUT fix (2026-10-30): the dual_system_order_conflict CTE uses WHERE EXISTS
-- instead of a JOIN to tmf_enterprise.order, so each product_order is counted once
-- (-26,667 rows / -$1.335B in v_gold_leakage_summary, DEC-PM-HEADLINE-1030).
-- Source control copy for RA-DEVOPS-PROV-INTEGRITY-SQL-DRIFT. Reads tmf_* (read-only).
-- Run on a SQL warehouse. After a change, refresh mv_gold_leakage_rollup
-- (gold_leakage_rollup_refresh.sql).
-- Note: the live view COMMENT reads "~.2B exposure" (a lost "$1" from shell expansion when it
-- was created). It is kept verbatim here so the file matches live.

CREATE OR REPLACE VIEW cdm_tmforum.revenue_assurance.silver_order_provisioning_integrity (
  check_type COMMENT 'Sub-check type within Order-to-Provisioning Integrity (Check Type #28). One of 8: completed_rejected, approval_state_mismatch, dual_system_order_conflict, inactive_service_billing, orphan_order_no_service, phantom_service_no_order, sla_breach_revenue_impact, late_provisioning.',
  severity COMMENT 'Exception severity: critical, high, or medium. Derived from sub-check risk classification and process control failure type.',
  customer_id COMMENT 'Foreign key to the customer in tmf_customer.customer. Sourced from product_order.customer_id or service.party_id depending on sub-check.',
  account_name COMMENT 'Human-readable label for the exception source — order description or service name.',
  amount_at_risk COMMENT 'Dollar exposure from the order-to-provisioning gap. Sourced from total_order_value, monthly_recurring_charge (annualized for phantom services), or item_total_amount.',
  source_table COMMENT 'Originating TMF table(s): tmf_enterprise.product_order, tmf_enterprise.order, tmf_service.service, or tmf_customer.product_order_item.',
  detection_method COMMENT 'Detection approach: rule_based (single-table threshold) or cross_system_reconciliation (multi-table join mismatch).',
  known_leakage_flag COMMENT 'TRUE if the exception matches a seeded or previously cataloged leakage pattern; FALSE for newly discovered anomalies.',
  reference_id COMMENT 'Unique key linking to the source record — product_order_id, service_id, or product_order_item_id cast to STRING.')
COMMENT 'Silver reconciliation: Order-to-Provisioning Integrity (Check Type #28). Cross-references 4 previously untapped TMF tables (product_order, order, product_order_item, service — 400K rows) to detect enterprise order/service provisioning gaps. 8 sub-checks: completed_rejected, approval_state_mismatch, dual_system_order_conflict, inactive_service_billing, orphan_order_no_service, phantom_service_no_order, sla_breach_revenue_impact, late_provisioning. ~241K exceptions / ~.2B exposure across 10K customers. Built by @ai-engineer Oct 19 2026.'
WITH SCHEMA COMPENSATION
AS WITH customer_service_summary AS (
    SELECT party_id AS customer_id, COUNT(*) AS active_service_count, SUM(monthly_recurring_charge) AS total_active_mrc
    FROM cdm_tmforum.tmf_service.service
    WHERE status IN ('active', 'reserved')
    GROUP BY party_id
),
completed_rejected AS (
    SELECT 'completed_rejected' AS check_type, 'high' AS severity,
        po.customer_id, po.order_description AS account_name, po.total_order_value AS amount_at_risk,
        'tmf_enterprise.product_order' AS source_table, 'rule_based' AS detection_method, TRUE AS known_leakage_flag,
        CAST(po.product_order_id AS STRING) AS reference_id
    FROM cdm_tmforum.tmf_enterprise.product_order po
    WHERE po.order_state = 'completed' AND po.approval_status = 'rejected'
),
approval_state_mismatch AS (
    SELECT 'approval_state_mismatch' AS check_type, 'medium' AS severity,
        po.customer_id, po.order_description AS account_name, po.total_order_value AS amount_at_risk,
        'tmf_enterprise.product_order' AS source_table, 'rule_based' AS detection_method, FALSE AS known_leakage_flag,
        CAST(po.product_order_id AS STRING) AS reference_id
    FROM cdm_tmforum.tmf_enterprise.product_order po
    WHERE (po.order_state = 'pending_approval' AND po.approval_status = 'approved')
       OR (po.order_state = 'acknowledged' AND po.approval_status = 'pending')
),
dual_system_order_conflict AS (
    SELECT 'dual_system_order_conflict' AS check_type, 'critical' AS severity,
        po.customer_id, po.order_description AS account_name, po.total_order_value AS amount_at_risk,
        'tmf_enterprise.product_order + tmf_enterprise.order' AS source_table,
        'cross_system_reconciliation' AS detection_method, TRUE AS known_leakage_flag,
        CAST(po.product_order_id AS STRING) AS reference_id
    FROM cdm_tmforum.tmf_enterprise.product_order po
    WHERE EXISTS (
        SELECT 1 FROM cdm_tmforum.tmf_enterprise.order o
        WHERE o.customer_id = po.customer_id AND o.sales_quote_id = po.sales_quote_id
          AND ((po.order_state = 'completed' AND o.status IN ('cancelled', 'failed', 'rejected'))
            OR (po.order_state = 'cancelled' AND o.status IN ('completed', 'in_fulfillment'))
            OR (po.order_state = 'approved' AND o.status IN ('cancelled', 'rejected')))
    )
),
inactive_service_billing AS (
    SELECT 'inactive_service_billing' AS check_type, 'critical' AS severity,
        s.party_id AS customer_id, s.name AS account_name, s.monthly_recurring_charge AS amount_at_risk,
        'tmf_service.service' AS source_table, 'rule_based' AS detection_method, TRUE AS known_leakage_flag,
        CAST(s.service_id AS STRING) AS reference_id
    FROM cdm_tmforum.tmf_service.service s
    WHERE s.status IN ('inactive', 'suspended', 'terminated', 'pending_termination') AND s.monthly_recurring_charge > 0
),
orphan_order_no_service AS (
    SELECT 'orphan_order_no_service' AS check_type, 'high' AS severity,
        po.customer_id, po.order_description AS account_name, po.total_order_value AS amount_at_risk,
        'tmf_enterprise.product_order' AS source_table, 'cross_system_reconciliation' AS detection_method, FALSE AS known_leakage_flag,
        CAST(po.product_order_id AS STRING) AS reference_id
    FROM cdm_tmforum.tmf_enterprise.product_order po
    LEFT JOIN customer_service_summary css ON po.customer_id = css.customer_id
    WHERE po.order_state IN ('completed', 'approved') AND po.approval_status IN ('approved', 'not_required') AND css.customer_id IS NULL
),
phantom_service_no_order AS (
    SELECT 'phantom_service_no_order' AS check_type, 'high' AS severity,
        s.party_id AS customer_id, s.name AS account_name, s.monthly_recurring_charge * 12 AS amount_at_risk,
        'tmf_service.service' AS source_table, 'cross_system_reconciliation' AS detection_method, FALSE AS known_leakage_flag,
        CAST(s.service_id AS STRING) AS reference_id
    FROM cdm_tmforum.tmf_service.service s
    LEFT JOIN cdm_tmforum.tmf_enterprise.product_order po
        ON s.party_id = po.customer_id AND po.order_state IN ('completed', 'approved', 'in_progress')
    WHERE s.status = 'active' AND s.operational_state = 'enabled' AND po.product_order_id IS NULL
),
sla_breach_revenue_impact AS (
    SELECT 'sla_breach_revenue_impact' AS check_type, 'high' AS severity,
        poi.order_id AS customer_id, poi.product_offering_name AS account_name, poi.item_total_amount AS amount_at_risk,
        'tmf_customer.product_order_item' AS source_table, 'rule_based' AS detection_method, TRUE AS known_leakage_flag,
        CAST(poi.product_order_item_id AS STRING) AS reference_id
    FROM cdm_tmforum.tmf_customer.product_order_item poi
    WHERE poi.sla_breach_indicator = TRUE AND poi.item_total_amount > 0
),
late_provisioning AS (
    SELECT 'late_provisioning' AS check_type, 'medium' AS severity,
        po.customer_id, po.order_description AS account_name, po.total_order_value AS amount_at_risk,
        'tmf_enterprise.product_order' AS source_table, 'rule_based' AS detection_method, FALSE AS known_leakage_flag,
        CAST(po.product_order_id AS STRING) AS reference_id
    FROM cdm_tmforum.tmf_enterprise.product_order po
    WHERE po.actual_completion_date > po.expected_completion_date
)
SELECT * FROM completed_rejected
UNION ALL SELECT * FROM approval_state_mismatch
UNION ALL SELECT * FROM dual_system_order_conflict
UNION ALL SELECT * FROM inactive_service_billing
UNION ALL SELECT * FROM orphan_order_no_service
UNION ALL SELECT * FROM phantom_service_no_order
UNION ALL SELECT * FROM sla_breach_revenue_impact
UNION ALL SELECT * FROM late_provisioning;
