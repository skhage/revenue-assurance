-- mv_order_provisioning
-- Source of truth export of the live metric view cdm_tmforum.revenue_assurance.mv_order_provisioning
-- Exported 2026-11-06 by @devops (RA-DEVOPS-COMMENT-SQL-DRIFT-1106) via SHOW CREATE TABLE.
-- Amounts in comments are written as USD N (no dollar signs) per RA-DE-FIX-STRIPPED-DOLLAR-COMMENTS-1105.
-- Table comment and YAML comment repaired here (live comment lost the leading digits of the USD figure and has a stale 241K+ count); MEASURE(total_provisioning_exposure) = USD 16,911,978,435.29 / 214,670 exceptions on 2026-11-06.
CREATE OR REPLACE VIEW cdm_tmforum.revenue_assurance.mv_order_provisioning (
  check_type COMMENT 'Order-provisioning sub-check: phantom_service_no_order, sla_breach_revenue_impact, late_provisioning, dual_system_order_conflict, inactive_service_billing, approval_state_mismatch, orphan_order_no_service, completed_rejected',
  severity COMMENT 'Exception severity tier: critical, high, medium — based on sub-check risk classification and process control failure type',
  detection_method COMMENT 'Detection approach: rule_based (single-table threshold) or cross_system_reconciliation (multi-table join mismatch)',
  source_table COMMENT 'Originating TMF table(s): tmf_enterprise.product_order, tmf_enterprise.order, tmf_service.service, or tmf_customer.product_order_item',
  known_leakage_flag COMMENT 'Boolean: TRUE if the exception matches a seeded or previously cataloged leakage pattern; FALSE for newly discovered anomalies',
  customer_id COMMENT 'TMF customer identifier (FK to tmf_customer.customer)',
  total_provisioning_exceptions COMMENT 'Total count of order-provisioning integrity exceptions (241K across 8 sub-checks)',
  total_provisioning_exposure COMMENT 'Total USD amount at risk from order-provisioning integrity violations (USD 16.91B as of 2026-11-06, post RA-BUG-ORDER-PROV-FANOUT fix)',
  avg_exposure_per_exception COMMENT 'Average dollar exposure per exception — useful for identifying high-value sub-checks',
  customer_count COMMENT 'Number of distinct customers with order-provisioning exceptions',
  known_leakage_count COMMENT 'Count of exceptions matching previously cataloged leakage patterns (152K of 241K)',
  new_anomaly_count COMMENT 'Count of newly discovered anomalies not in prior leakage catalog (89K of 241K)',
  phantom_service_count COMMENT 'Count of phantom services: active services billing with no originating order in the order management system (11K)',
  phantom_service_exposure COMMENT 'USD at risk from phantom services (USD 6.74B as of 2026-11-06)',
  sla_breach_revenue_impact_count COMMENT 'Count of SLA breach revenue impacts: provisioning delays exceeding SLA thresholds with quantified revenue loss (50K)',
  sla_breach_revenue_impact_exposure COMMENT 'USD at risk from SLA breach revenue impact (USD 2.51B as of 2026-11-06)',
  late_provisioning_count COMMENT 'Count of late provisioning: orders not provisioned within expected timeframes (50K)',
  late_provisioning_exposure COMMENT 'USD at risk from late provisioning (USD 2.49B as of 2026-11-06)',
  dual_system_conflict_count COMMENT 'Count of dual system order conflicts: same order in both product_order and order tables with conflicting states (49K)',
  dual_system_conflict_exposure COMMENT 'USD at risk from dual system order conflicts (USD 1.13B as of 2026-11-06, post fanout fix)',
  inactive_service_billing_count COMMENT 'Count of inactive service billing: services in inactive/terminated state still generating billing events (44K)',
  inactive_service_billing_exposure COMMENT 'USD at risk from inactive service billing (USD 2.23B as of 2026-11-06)',
  approval_state_mismatch_count COMMENT 'Count of approval state mismatches: orders proceeding despite non-approved states (18K)',
  approval_state_mismatch_exposure COMMENT 'USD at risk from approval state mismatches (USD 919.3M as of 2026-11-06)',
  orphan_order_count COMMENT 'Count of orphan orders: completed orders with no corresponding service activation (9K)',
  orphan_order_exposure COMMENT 'USD at risk from orphan orders (USD 454.6M as of 2026-11-06)',
  completed_rejected_count COMMENT 'Count of completed-but-rejected orders: orders reaching completion despite rejection flag (9K)',
  completed_rejected_exposure COMMENT 'USD at risk from completed-rejected orders (USD 451.8M as of 2026-11-06)',
  cross_system_exception_count COMMENT 'Exceptions detected via cross-system reconciliation (multi-table join mismatch): 70K',
  rule_based_exception_count COMMENT 'Exceptions detected via rule-based single-table thresholds: 172K',
  critical_severity_count COMMENT 'Exceptions at critical severity (94K of 241K)',
  high_severity_count COMMENT 'Exceptions at high severity (80K of 241K)',
  critical_exposure COMMENT 'USD at risk from critical-severity exceptions (USD 3.35B as of 2026-11-06)')
COMMENT 'Order-to-provisioning integrity KPIs (check type #28). Tracks 8 sub-checks across order-service-billing lifecycle: phantom services with no order, SLA breach revenue impact, late provisioning, dual system order conflicts, inactive service billing, approval state mismatches, orphan orders with no service, and completed-but-rejected orders. 214K+ exceptions / USD 16.91B exposure / 35,242 customers. Source: silver_order_provisioning_integrity. Owned by Revenue Assurance domain.'
WITH METRICS
LANGUAGE YAML
AS
$$
version: 1.1

source: cdm_tmforum.revenue_assurance.silver_order_provisioning_integrity

comment: "Order-to-provisioning integrity KPIs (check type #28). Tracks 8 sub-checks\
  \ across order-service-billing lifecycle: phantom services with no order, SLA breach\
  \ revenue impact, late provisioning, dual system order conflicts, inactive service\
  \ billing, approval state mismatches, orphan orders with no service, and completed-but-rejected\
  \ orders. 214K+ exceptions / USD 16.91B exposure / 35,242 customers. Source: silver_order_provisioning_integrity.\
  \ Owned by Revenue Assurance domain."

dimensions:
  - name: check_type
    expr: source.check_type
    comment: "Order-provisioning sub-check: phantom_service_no_order, sla_breach_revenue_impact,\
      \ late_provisioning, dual_system_order_conflict, inactive_service_billing, approval_state_mismatch,\
      \ orphan_order_no_service, completed_rejected"
    display_name: Sub-Check Type
    synonyms:
      - order check type
      - provisioning check
      - order anomaly type
      - sub check

  - name: severity
    expr: source.severity
    comment: "Exception severity tier: critical, high, medium — based on sub-check\
      \ risk classification and process control failure type"
    display_name: Severity
    synonyms:
      - risk level
      - priority
      - criticality
      - severity tier

  - name: detection_method
    expr: source.detection_method
    comment: "Detection approach: rule_based (single-table threshold) or cross_system_reconciliation\
      \ (multi-table join mismatch)"
    display_name: Detection Method
    synonyms:
      - method
      - detection type
      - how detected

  - name: source_table
    expr: source.source_table
    comment: "Originating TMF table(s): tmf_enterprise.product_order, tmf_enterprise.order,\
      \ tmf_service.service, or tmf_customer.product_order_item"
    display_name: Source Table
    synonyms:
      - data source
      - origin table
      - tmf source

  - name: known_leakage_flag
    expr: source.known_leakage_flag
    comment: "Boolean: TRUE if the exception matches a seeded or previously cataloged\
      \ leakage pattern; FALSE for newly discovered anomalies"
    display_name: Known Leakage
    synonyms:
      - known flag
      - seeded leakage
      - previously known
      - catalog match

  - name: customer_id
    expr: source.customer_id
    comment: TMF customer identifier (FK to tmf_customer.customer)
    display_name: Customer ID

measures:
  - name: total_provisioning_exceptions
    expr: COUNT(*)
    comment: Total count of order-provisioning integrity exceptions (241K across 8
      sub-checks)
    display_name: Total Provisioning Exceptions
    synonyms:
      - provisioning exception count
      - total order exceptions
      - order anomaly count
      - provisioning anomalies

  - name: total_provisioning_exposure
    expr: SUM(source.amount_at_risk)
    comment: "Total USD amount at risk from order-provisioning integrity violations\
      \ (USD 16.91B as of 2026-11-06, post RA-BUG-ORDER-PROV-FANOUT fix)"
    display_name: Total Provisioning Exposure
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - provisioning risk
      - order amount at risk
      - provisioning leakage
      - order exposure

  - name: avg_exposure_per_exception
    expr: "SUM(source.amount_at_risk) / NULLIF(COUNT(*), 0)"
    comment: Average dollar exposure per exception — useful for identifying high-value
      sub-checks
    display_name: Avg Exposure per Exception
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - average risk
      - mean exposure
      - per-exception amount

  - name: customer_count
    expr: COUNT(DISTINCT source.customer_id)
    comment: Number of distinct customers with order-provisioning exceptions
    display_name: Customer Count
    synonyms:
      - affected customers
      - unique customers
      - customer reach

  - name: known_leakage_count
    expr: COUNT(*) FILTER (WHERE source.known_leakage_flag = TRUE)
    comment: Count of exceptions matching previously cataloged leakage patterns (152K
      of 241K)
    display_name: Known Leakage Count
    synonyms:
      - seeded count
      - cataloged exceptions
      - known anomalies

  - name: new_anomaly_count
    expr: COUNT(*) FILTER (WHERE source.known_leakage_flag = FALSE)
    comment: Count of newly discovered anomalies not in prior leakage catalog (89K
      of 241K)
    display_name: New Anomaly Count
    synonyms:
      - unknown count
      - new discoveries
      - uncataloged exceptions

  - name: phantom_service_count
    expr: COUNT(*) FILTER (WHERE source.check_type = 'phantom_service_no_order')
    comment: "Count of phantom services: active services billing with no originating\
      \ order in the order management system (11K)"
    display_name: Phantom Services
    synonyms:
      - phantom count
      - unordered services
      - ghost services

  - name: phantom_service_exposure
    expr: SUM(source.amount_at_risk) FILTER (WHERE source.check_type = 'phantom_service_no_order')
    comment: USD at risk from phantom services (USD 6.74B as of 2026-11-06)
    display_name: Phantom Service Exposure
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - phantom risk
      - unordered service exposure

  - name: sla_breach_revenue_impact_count
    expr: COUNT(*) FILTER (WHERE source.check_type = 'sla_breach_revenue_impact')
    comment: "Count of SLA breach revenue impacts: provisioning delays exceeding SLA\
      \ thresholds with quantified revenue loss (50K)"
    display_name: SLA Breach Revenue Impacts
    synonyms:
      - sla breach count
      - provisioning sla breaches
      - sla revenue impacts

  - name: sla_breach_revenue_impact_exposure
    expr: SUM(source.amount_at_risk) FILTER (WHERE source.check_type = 'sla_breach_revenue_impact')
    comment: USD at risk from SLA breach revenue impact (USD 2.51B as of 2026-11-06)
    display_name: SLA Breach Revenue Exposure
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - sla breach risk
      - provisioning sla exposure

  - name: late_provisioning_count
    expr: COUNT(*) FILTER (WHERE source.check_type = 'late_provisioning')
    comment: "Count of late provisioning: orders not provisioned within expected timeframes\
      \ (50K)"
    display_name: Late Provisioning
    synonyms:
      - late count
      - delayed provisioning
      - overdue orders

  - name: late_provisioning_exposure
    expr: SUM(source.amount_at_risk) FILTER (WHERE source.check_type = 'late_provisioning')
    comment: USD at risk from late provisioning (USD 2.49B as of 2026-11-06)
    display_name: Late Provisioning Exposure
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - late provisioning risk
      - delayed order exposure

  - name: dual_system_conflict_count
    expr: COUNT(*) FILTER (WHERE source.check_type = 'dual_system_order_conflict')
    comment: "Count of dual system order conflicts: same order in both product_order\
      \ and order tables with conflicting states (49K)"
    display_name: Dual System Conflicts
    synonyms:
      - dual system count
      - order conflicts
      - system discrepancies

  - name: dual_system_conflict_exposure
    expr: SUM(source.amount_at_risk) FILTER (WHERE source.check_type = 'dual_system_order_conflict')
    comment: "USD at risk from dual system order conflicts (USD 1.13B as of 2026-11-06,\
      \ post fanout fix)"
    display_name: Dual System Conflict Exposure
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - dual system risk
      - order conflict exposure

  - name: inactive_service_billing_count
    expr: COUNT(*) FILTER (WHERE source.check_type = 'inactive_service_billing')
    comment: "Count of inactive service billing: services in inactive/terminated state\
      \ still generating billing events (44K)"
    display_name: Inactive Service Billing
    synonyms:
      - inactive billing count
      - zombie billing
      - terminated service billing

  - name: inactive_service_billing_exposure
    expr: SUM(source.amount_at_risk) FILTER (WHERE source.check_type = 'inactive_service_billing')
    comment: USD at risk from inactive service billing (USD 2.23B as of 2026-11-06)
    display_name: Inactive Billing Exposure
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - inactive billing risk
      - zombie billing exposure

  - name: approval_state_mismatch_count
    expr: COUNT(*) FILTER (WHERE source.check_type = 'approval_state_mismatch')
    comment: "Count of approval state mismatches: orders proceeding despite non-approved\
      \ states (18K)"
    display_name: Approval Mismatches
    synonyms:
      - approval mismatch count
      - unapproved orders
      - state mismatches

  - name: approval_state_mismatch_exposure
    expr: SUM(source.amount_at_risk) FILTER (WHERE source.check_type = 'approval_state_mismatch')
    comment: USD at risk from approval state mismatches (USD 919.3M as of 2026-11-06)
    display_name: Approval Mismatch Exposure
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - approval mismatch risk
      - unapproved order exposure

  - name: orphan_order_count
    expr: COUNT(*) FILTER (WHERE source.check_type = 'orphan_order_no_service')
    comment: "Count of orphan orders: completed orders with no corresponding service\
      \ activation (9K)"
    display_name: Orphan Orders
    synonyms:
      - orphan count
      - unprovisioned orders
      - missing service orders

  - name: orphan_order_exposure
    expr: SUM(source.amount_at_risk) FILTER (WHERE source.check_type = 'orphan_order_no_service')
    comment: USD at risk from orphan orders (USD 454.6M as of 2026-11-06)
    display_name: Orphan Order Exposure
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - orphan order risk
      - unprovisioned order exposure

  - name: completed_rejected_count
    expr: COUNT(*) FILTER (WHERE source.check_type = 'completed_rejected')
    comment: "Count of completed-but-rejected orders: orders reaching completion despite\
      \ rejection flag (9K)"
    display_name: Completed Rejected
    synonyms:
      - rejected completed count
      - completed despite rejection
      - rejection override count

  - name: completed_rejected_exposure
    expr: SUM(source.amount_at_risk) FILTER (WHERE source.check_type = 'completed_rejected')
    comment: USD at risk from completed-rejected orders (USD 451.8M as of 2026-11-06)
    display_name: Completed Rejected Exposure
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - completed rejected risk
      - rejection override exposure

  - name: cross_system_exception_count
    expr: COUNT(*) FILTER (WHERE source.detection_method = 'cross_system_reconciliation')
    comment: "Exceptions detected via cross-system reconciliation (multi-table join\
      \ mismatch): 70K"
    display_name: Cross-System Exceptions
    synonyms:
      - cross system count
      - reconciliation exceptions
      - join mismatch count

  - name: rule_based_exception_count
    expr: COUNT(*) FILTER (WHERE source.detection_method = 'rule_based')
    comment: "Exceptions detected via rule-based single-table thresholds: 172K"
    display_name: Rule-Based Exceptions
    synonyms:
      - rule based count
      - threshold exceptions
      - single table exceptions

  - name: critical_severity_count
    expr: COUNT(*) FILTER (WHERE source.severity = 'critical')
    comment: Exceptions at critical severity (94K of 241K)
    display_name: Critical Exceptions
    synonyms:
      - critical count
      - p1 exceptions

  - name: high_severity_count
    expr: COUNT(*) FILTER (WHERE source.severity = 'high')
    comment: Exceptions at high severity (80K of 241K)
    display_name: High Severity Exceptions
    synonyms:
      - high count
      - p2 exceptions

  - name: critical_exposure
    expr: SUM(source.amount_at_risk) FILTER (WHERE source.severity = 'critical')
    comment: USD at risk from critical-severity exceptions (USD 3.35B as of 2026-11-06)
    display_name: Critical Exposure
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - critical risk
      - p1 exposure
$$;
