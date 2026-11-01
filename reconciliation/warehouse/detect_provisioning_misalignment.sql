-- detect_provisioning_misalignment: UC table function (cdm_tmforum.revenue_assurance).
-- Exported from information_schema.routines on 2026-11-01. Live definition includes the
-- RA-QA-BUG-PROV-MISALIGN-RETRY-CAST fix (2026-10-29): retry_count is TRY_CAST to INT because
-- upstream tmf_service.service_order_item.retry_count holds non-numeric IDs.
-- Source control copy for RA-DEVOPS-PROV-MISALIGN-FN-DRIFT. Reads gold_order_to_bill_leakage.
-- Run on a SQL warehouse.

CREATE OR REPLACE FUNCTION cdm_tmforum.revenue_assurance.detect_provisioning_misalignment(
    p_customer_id BIGINT DEFAULT NULL,
    p_fallout_category STRING DEFAULT NULL,
    p_provisioning_system STRING DEFAULT NULL,
    p_min_days_stale INT DEFAULT 30
)
RETURNS TABLE (
    exception_id BIGINT,
    customer_id BIGINT,
    billing_account_id BIGINT,
    order_status STRING,
    provisioning_status STRING,
    service_state STRING,
    service_type STRING,
    service_category STRING,
    fallout_category STRING,
    provisioning_system STRING,
    service_error_code STRING,
    retry_count INT,
    is_sla_breached STRING,
    amount_at_risk DOUBLE,
    days_since_order INT,
    has_service_order BOOLEAN,
    service_order_count INT,
    misalignment_type STRING,
    root_cause_hypothesis STRING,
    remediation_steps STRING
)
COMMENT 'Provisioning misalignment detector (Check Type #13 drill-down). Identifies orders stuck in provisioning with detailed root cause analysis. Filters by customer, fallout category (resource_unavailable, capacity_exceeded, timeout, data_validation), provisioning system, and staleness threshold. Returns misalignment type + root cause hypothesis + remediation steps. Use for: (1) Provisioning team escalation, (2) System-level failure pattern analysis, (3) SLA breach investigation. Built by @ai-engineer 2026-10-12. [2026-10-29 @data-engineer] retry_count is TRY_CAST to INT: upstream tmf_service.service_order_item.retry_count holds non-numeric IDs, so it is NULL (0 in root_cause_hypothesis).'
RETURN
    SELECT
        g.exception_id,
        g.customer_id,
        g.billing_account_id,
        g.order_status,
        g.provisioning_status,
        g.service_state,
        g.service_type,
        g.service_category,
        g.fallout_category,
        g.provisioning_system,
        g.service_error_code,
        TRY_CAST(g.retry_count AS INT) AS retry_count,
        g.is_sla_breached,
        g.amount_at_risk,
        g.days_since_order,
        g.has_service_order,
        g.service_order_count,
        -- Misalignment type classification
        CASE
            WHEN g.order_status IN ('completed') AND g.service_state IN ('failed', 'rejected')
                THEN 'ORDER_COMPLETE_SERVICE_FAILED'
            WHEN g.order_status IN ('cancelled', 'rejected') AND g.service_state IN ('completed', 'inProgress')
                THEN 'ORDER_CANCELLED_SERVICE_ACTIVE'
            WHEN g.order_status IN ('in_progress', 'acknowledged') AND g.provisioning_status = 'not_started' AND g.days_since_order > p_min_days_stale
                THEN 'PROVISIONING_STALLED'
            WHEN g.provisioning_status = 'activated' AND g.order_status = 'failed'
                THEN 'PHANTOM_ACTIVATION'
            WHEN g.provisioning_status = 'provisioned' AND g.order_status IN ('held', 'pending')
                THEN 'BILLING_DELAYED'
            WHEN g.has_service_order = FALSE
                THEN 'ORPHANED_ORDER'
            ELSE 'GENERAL_MISALIGNMENT'
        END AS misalignment_type,
        -- Root cause hypothesis based on fallout + error patterns
        CASE
            WHEN g.fallout_category = 'resource_unavailable'
                THEN 'Network resource shortage. Check port/bandwidth availability on provisioning system ' || COALESCE(g.provisioning_system, 'UNKNOWN')
            WHEN g.fallout_category = 'capacity_exceeded'
                THEN 'Capacity limit hit. Review capacity planning for service type ' || COALESCE(g.service_type, 'UNKNOWN')
            WHEN g.fallout_category = 'timeout'
                THEN 'Provisioning timeout. Check system health for ' || COALESCE(g.provisioning_system, 'UNKNOWN') || '. Retry count: ' || CAST(COALESCE(TRY_CAST(g.retry_count AS INT), 0) AS STRING)
            WHEN g.fallout_category = 'data_validation'
                THEN 'Data validation failure. Check customer/service data integrity. Error: ' || COALESCE(g.service_error_code, 'UNKNOWN')
            WHEN g.provisioning_status = 'activated' AND g.order_status IN ('cancelled', 'failed')
                THEN 'Rollback failure: service activated but order terminal. Immediate deactivation required'
            WHEN g.has_service_order = FALSE
                THEN 'No service order created for product order. Check order-to-service handoff workflow'
            ELSE 'Review order/service state pair for system-specific root cause'
        END AS root_cause_hypothesis,
        -- Remediation steps
        CASE
            WHEN g.provisioning_status = 'activated' AND g.order_status IN ('cancelled', 'failed', 'rejected')
                THEN '1. Verify service is still active on network. 2. Issue deactivation request. 3. Generate credit memo for billed period. 4. Update billing system.'
            WHEN g.provisioning_status IN ('provisioned', 'activated') AND g.order_status IN ('held', 'pending')
                THEN '1. Release held order in OSS/BSS. 2. Start billing from original provision date. 3. Generate backdated invoice if applicable.'
            WHEN g.order_status IN ('in_progress', 'acknowledged') AND g.days_since_order > 90
                THEN '1. Escalate to provisioning manager. 2. Determine if customer still wants service. 3. Cancel or expedite. 4. Issue goodwill credit if delayed.'
            WHEN g.fallout_category IS NOT NULL
                THEN '1. Address ' || g.fallout_category || ' root cause. 2. Retry provisioning. 3. Update order status. 4. Notify customer of resolution.'
            ELSE '1. Investigate state mismatch. 2. Align order and service statuses. 3. Verify billing accuracy. 4. Document resolution.'
        END AS remediation_steps
    FROM cdm_tmforum.revenue_assurance.gold_order_to_bill_leakage g
    WHERE (p_customer_id IS NULL OR g.customer_id = p_customer_id)
      AND (NULLIF(NULLIF(UPPER(TRIM(p_fallout_category)),'NULL'),'') IS NULL OR UPPER(g.fallout_category) = NULLIF(NULLIF(UPPER(TRIM(p_fallout_category)),'NULL'),''))
      AND (NULLIF(NULLIF(UPPER(TRIM(p_provisioning_system)),'NULL'),'') IS NULL OR UPPER(g.provisioning_system) = NULLIF(NULLIF(UPPER(TRIM(p_provisioning_system)),'NULL'),''))
      AND g.days_since_order >= p_min_days_stale
    ORDER BY g.amount_at_risk DESC
    LIMIT 200;
