-- reconcile_order_to_provisioning: UC table function (cdm_tmforum.revenue_assurance).
-- Exported from information_schema.routines on 2026-11-07 (live last_altered 2026-11-07 03:11 UTC).
-- Source control copy for RA-DEVOPS-ORDER-PROV-SLA-FN-DRIFT-1106. The live definition is canonical.
-- Live definition includes:
--   * RA-DE-ORDER-PROV-SLA-JOIN-BUG-1106 (2026-11-06): the sla subquery groups tmf_customer.product_order_item
--     by billing_account_id (= customer_id) and joins ON COALESCE(po.customer_id, s.party_id) = sla_customer_id.
--     Previously it joined customer_id = order_id, so sla_breached_items was attributed to unrelated orders.
--   * #728 B2 capped-tool totals (7 appended columns) and #757 all_tier_totals JSON column.
-- order_service_gap is an absolute order-value vs annualized-MRC gap, NOT a leakage figure.
-- Verified 2026-11-07: TEMP copy of this DDL vs live, default call and single-customer call,
--   EXCEPT ALL both ways = 0/0 (doubles at 2dp); population 10,000 customers / USD 55,021,149,575.24.
-- Agent-side DDL notes for this function stay in agents/ddl (gitignored); this file is the tracked copy.
-- Deploy as one literal statement on a SQL warehouse, then confirm grants are preserved (SHOW GRANTS).

CREATE OR REPLACE FUNCTION cdm_tmforum.revenue_assurance.reconcile_order_to_provisioning(
    p_customer_id BIGINT DEFAULT NULL
)
RETURNS TABLE (
    customer_id BIGINT,
    total_orders INT,
    completed_orders INT,
    cancelled_orders INT,
    failed_orders INT,
    total_order_value DOUBLE,
    active_services INT,
    inactive_services INT,
    total_service_mrc DOUBLE,
    annualized_service_revenue DOUBLE,
    order_service_gap DOUBLE,
    sla_breached_items INT,
    dual_system_conflicts INT,
    risk_category STRING,
    tier_total_count BIGINT,
    tier_total_amount DOUBLE,
    population_total_count BIGINT,
    population_total_amount DOUBLE,
    population_customer_count BIGINT,
    returned_row_count BIGINT,
    is_capped_sample BOOLEAN,
    all_tier_totals STRING
)
COMMENT 'Per-customer order vs provisioned service reconciliation (top 50 by order_service_gap). Tier = risk_category; amount = order_service_gap (absolute order value vs annualized MRC gap, NOT a leakage dollar figure). Default population 10,000 customers / USD 55.02B gap. sla_breached_items = count of tmf_customer.product_order_item rows with sla_breach_indicator TRUE for the customer, keyed on product_order_item.billing_account_id (= customer_id); fixed 2026-11-06 by RA-DE-ORDER-PROV-SLA-JOIN-BUG-1106 (previously joined customer_id = order_id). Returns a capped, prioritized sample (returned_row_count rows) plus UNCAPPED totals appended per #728 B2 (DEC-AI-CAPPED-TOOL-TOTALS): tier_total_count/tier_total_amount (whole tier), population_total_count/population_total_amount/population_customer_count (all qualifying rows), returned_row_count, is_capped_sample. Quote totals verbatim; never count or sum returned rows. all_tier_totals: JSON array [{tier,count,amount}] of EVERY tier (uncapped, amount desc), identical on every row; quote tiers from it, never from the sample rows.'
RETURN
WITH r AS (
SELECT 
        COALESCE(po.customer_id, s.party_id) AS customer_id,
        COALESCE(po.total_orders, 0) AS total_orders,
        COALESCE(po.completed_orders, 0) AS completed_orders,
        COALESCE(po.cancelled_orders, 0) AS cancelled_orders,
        COALESCE(po.failed_orders, 0) AS failed_orders,
        COALESCE(po.total_order_value, 0) AS total_order_value,
        COALESCE(s.active_services, 0) AS active_services,
        COALESCE(s.inactive_services, 0) AS inactive_services,
        COALESCE(s.total_service_mrc, 0) AS total_service_mrc,
        COALESCE(s.total_service_mrc * 12, 0) AS annualized_service_revenue,
        ABS(COALESCE(po.total_order_value, 0) - COALESCE(s.total_service_mrc * 12, 0)) AS order_service_gap,
        COALESCE(sla.breach_count, 0) AS sla_breached_items,
        COALESCE(conf.conflict_count, 0) AS dual_system_conflicts,
        CASE 
            WHEN ABS(COALESCE(po.total_order_value, 0) - COALESCE(s.total_service_mrc * 12, 0)) > 500000 
                 AND COALESCE(conf.conflict_count, 0) > 0 THEN 'CRITICAL'
            WHEN ABS(COALESCE(po.total_order_value, 0) - COALESCE(s.total_service_mrc * 12, 0)) > 100000 THEN 'HIGH'
            WHEN ABS(COALESCE(po.total_order_value, 0) - COALESCE(s.total_service_mrc * 12, 0)) > 0 THEN 'MEDIUM'
            ELSE 'LOW'
        END AS risk_category
    FROM (
        SELECT customer_id, COUNT(*) AS total_orders,
               SUM(CASE WHEN order_state = 'completed' THEN 1 ELSE 0 END) AS completed_orders,
               SUM(CASE WHEN order_state = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_orders,
               SUM(CASE WHEN order_state = 'failed' THEN 1 ELSE 0 END) AS failed_orders,
               SUM(total_order_value) AS total_order_value
        FROM cdm_tmforum.tmf_enterprise.product_order
        GROUP BY customer_id
    ) po
    FULL OUTER JOIN (
        SELECT party_id, 
               SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_services,
               SUM(CASE WHEN status != 'active' THEN 1 ELSE 0 END) AS inactive_services,
               SUM(monthly_recurring_charge) AS total_service_mrc
        FROM cdm_tmforum.tmf_service.service
        GROUP BY party_id
    ) s ON po.customer_id = s.party_id
    LEFT JOIN (
        SELECT billing_account_id AS sla_customer_id, SUM(CASE WHEN sla_breach_indicator THEN 1 ELSE 0 END) AS breach_count
        FROM cdm_tmforum.tmf_customer.product_order_item
        GROUP BY billing_account_id
    ) sla ON COALESCE(po.customer_id, s.party_id) = sla.sla_customer_id
    LEFT JOIN (
        SELECT po2.customer_id, COUNT(*) AS conflict_count
        FROM cdm_tmforum.tmf_enterprise.product_order po2
        INNER JOIN cdm_tmforum.tmf_enterprise.order o2 
            ON po2.customer_id = o2.customer_id AND po2.sales_quote_id = o2.sales_quote_id
        WHERE (po2.order_state = 'completed' AND o2.status IN ('cancelled', 'failed', 'rejected'))
           OR (po2.order_state = 'cancelled' AND o2.status IN ('completed', 'in_fulfillment'))
        GROUP BY po2.customer_id
    ) conf ON po.customer_id = conf.customer_id
    WHERE (p_customer_id IS NULL OR COALESCE(po.customer_id, s.party_id) = p_customer_id)
),
p AS (SELECT * FROM r ),
tr AS (SELECT risk_category AS tier_key, COUNT(*) AS tier_total_count, SUM(CAST(order_service_gap AS DOUBLE)) AS tier_total_amount FROM p GROUP BY risk_category),
tp AS (SELECT COUNT(*) AS population_total_count, SUM(CAST(order_service_gap AS DOUBLE)) AS population_total_amount, COUNT(DISTINCT customer_id) AS population_customer_count FROM p),
tn AS (SELECT COUNT(*) AS row_n FROM r),
ta AS (SELECT to_json(transform(sort_array(collect_list(named_struct('neg_amount', -COALESCE(CAST(tier_total_amount AS DOUBLE),0), 'tier', CAST(tier_key AS STRING), 'count', tier_total_count, 'amount', ROUND(CAST(tier_total_amount AS DOUBLE),2)))), x -> named_struct('tier', COALESCE(x.tier,'(null)'), 'count', x.count, 'amount', x.amount))) AS all_tier_totals FROM tr),
top AS (SELECT * FROM r ORDER BY order_service_gap DESC, customer_id LIMIT 50)
SELECT top.customer_id, top.total_orders, top.completed_orders, top.cancelled_orders, top.failed_orders, top.total_order_value, top.active_services, top.inactive_services, top.total_service_mrc, top.annualized_service_revenue, top.order_service_gap, top.sla_breached_items, top.dual_system_conflicts, top.risk_category, COALESCE(tr.tier_total_count, 0) AS tier_total_count, COALESCE(tr.tier_total_amount, 0) AS tier_total_amount, tp.population_total_count, tp.population_total_amount, tp.population_customer_count,
  CAST(LEAST(tn.row_n, 50) AS BIGINT) AS returned_row_count, tn.row_n > 50 AS is_capped_sample, ta.all_tier_totals
FROM top LEFT JOIN tr ON tr.tier_key <=> top.risk_category CROSS JOIN tp CROSS JOIN ta CROSS JOIN tn
ORDER BY top.order_service_gap DESC, top.customer_id;
