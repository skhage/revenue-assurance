-- mv_billing_dispute
-- Source of truth export of the live metric view cdm_tmforum.revenue_assurance.mv_billing_dispute
-- Exported 2026-11-06 by @devops (RA-DEVOPS-COMMENT-SQL-DRIFT-1106) via SHOW CREATE TABLE.
-- Amounts in comments are written as USD N (no dollar signs) per RA-DE-FIX-STRIPPED-DOLLAR-COMMENTS-1105.
-- Table comment and YAML comment repaired here (live comment lost the leading digit of the USD figure); MEASURE(total_dispute_risk) = USD 9,846,925,659.29 / 291,857 exceptions on 2026-11-06.
CREATE OR REPLACE VIEW cdm_tmforum.revenue_assurance.mv_billing_dispute (
  sub_check_type COMMENT 'Billing dispute sub-check: over_credit, fraud_pattern, sla_breach, stale_dispute, regulatory_escalation, reopened_dispute, unauthorized_waiver',
  severity COMMENT 'Risk severity tier: CRITICAL (stale/reopened/regulatory/SLA/unauthorized), HIGH (fraud/over-credit), MEDIUM (smaller variances), LOW (minor over-credits)',
  dispute_category COMMENT 'Dispute category classification (9 distinct values)',
  dispute_type COMMENT 'Dispute type classification (13 distinct values)',
  dispute_state COMMENT 'Dispute lifecycle state (10 distinct values: open, investigating, resolved, etc.)',
  dispute_priority COMMENT 'Priority level of the billing dispute (4 tiers)',
  resolution_type COMMENT 'Resolution type: credit_applied, write_off, partial_credit, etc. (9 distinct values)',
  channel COMMENT 'Dispute origination channel (10 distinct values)',
  raised_date COMMENT 'Date dispute was raised — primary time grain for billing dispute trending',
  customer_id COMMENT 'TMF customer identifier (FK to tmf_customer.customer)',
  bill_id COMMENT 'FK to tmf_customer.bill — associated billing record',
  total_dispute_exceptions COMMENT 'Total count of billing dispute exceptions',
  total_dispute_risk COMMENT 'Total USD amount at risk from billing dispute violations (USD 9.85B across 291,857 exceptions, as of 2026-11-06)',
  over_credit_amount COMMENT 'Total USD at risk from dispute over-credits, where adjusted amount exceeds disputed amount (USD 1.66B as of 2026-11-06)',
  fraud_pattern_amount COMMENT 'Total USD at risk from disputes matching fraud patterns: suspicious timing, amounts, or duplication (USD 1.03B as of 2026-11-06)',
  sla_breach_amount COMMENT 'Total USD at risk from disputes breaching resolution SLA deadlines (USD 376.0M as of 2026-11-06)',
  stale_dispute_amount COMMENT 'Total USD at risk from disputes open beyond acceptable aging thresholds (USD 3.06B as of 2026-11-06)',
  regulatory_escalation_amount COMMENT 'Total USD at risk from disputes escalated to regulatory bodies (USD 626.7M as of 2026-11-06)',
  reopened_dispute_amount COMMENT 'Total USD at risk from previously resolved disputes that were reopened (USD 2.51B as of 2026-11-06)',
  unauthorized_waiver_amount COMMENT 'Total USD at risk from dispute waivers applied without proper authorization (USD 584.2M as of 2026-11-06)',
  customer_count COMMENT 'Number of distinct customers with billing dispute exceptions',
  sla_breach_count COMMENT 'Count of exceptions with SLA breach flags',
  escalation_count COMMENT 'Count of exceptions with escalation flags',
  regulatory_escalation_count COMMENT 'Count of exceptions with regulatory escalation flags',
  reopened_count COMMENT 'Count of exceptions flagged as reopened disputes',
  avg_disputed_amount COMMENT 'Average disputed amount across all exceptions (USD)',
  avg_amount_at_risk COMMENT 'Average amount at risk per exception (USD)')
COMMENT 'Billing dispute leakage KPIs (check type #26). Tracks over-credits, fraud patterns, SLA breaches, stale disputes, regulatory escalations, reopened disputes, and unauthorized waivers across 291K+ exceptions / USD 9.85B exposure. Source: silver_billing_dispute_reconciliation. Owned by Revenue Assurance domain.'
WITH METRICS
LANGUAGE YAML
AS
$$
version: 1.1

source: cdm_tmforum.revenue_assurance.silver_billing_dispute_reconciliation

comment: "Billing dispute leakage KPIs (check type #26). Tracks over-credits, fraud\
  \ patterns, SLA breaches, stale disputes, regulatory escalations, reopened disputes,\
  \ and unauthorized waivers across 291K+ exceptions / USD 9.85B exposure. Source: silver_billing_dispute_reconciliation.\
  \ Owned by Revenue Assurance domain."

dimensions:
  - name: sub_check_type
    expr: source.sub_check_type
    comment: "Billing dispute sub-check: over_credit, fraud_pattern, sla_breach, stale_dispute,\
      \ regulatory_escalation, reopened_dispute, unauthorized_waiver"
    display_name: Sub-Check Type
    synonyms:
      - dispute check type
      - leakage category
      - dispute anomaly type
      - check category

  - name: severity
    expr: source.severity
    comment: "Risk severity tier: CRITICAL (stale/reopened/regulatory/SLA/unauthorized),\
      \ HIGH (fraud/over-credit), MEDIUM (smaller variances), LOW (minor over-credits)"
    display_name: Severity
    synonyms:
      - risk level
      - priority
      - criticality
      - severity tier

  - name: dispute_category
    expr: source.dispute_category
    comment: Dispute category classification (9 distinct values)
    display_name: Dispute Category
    synonyms:
      - category
      - dispute class
      - billing dispute category

  - name: dispute_type
    expr: source.dispute_type
    comment: Dispute type classification (13 distinct values)
    display_name: Dispute Type
    synonyms:
      - type
      - dispute classification
      - billing dispute type

  - name: dispute_state
    expr: source.dispute_state
    comment: "Dispute lifecycle state (10 distinct values: open, investigating, resolved,\
      \ etc.)"
    display_name: Dispute State
    synonyms:
      - state
      - dispute status
      - lifecycle state
      - resolution state

  - name: dispute_priority
    expr: source.dispute_priority
    comment: Priority level of the billing dispute (4 tiers)
    display_name: Dispute Priority
    synonyms:
      - priority level
      - urgency
      - dispute urgency

  - name: resolution_type
    expr: source.resolution_type
    comment: "Resolution type: credit_applied, write_off, partial_credit, etc. (9\
      \ distinct values)"
    display_name: Resolution Type
    synonyms:
      - resolution
      - resolution method
      - outcome type
      - disposition

  - name: channel
    expr: source.channel
    comment: Dispute origination channel (10 distinct values)
    display_name: Channel
    synonyms:
      - dispute channel
      - origination channel
      - intake channel
      - submission channel

  - name: raised_date
    expr: CAST(source.raised_date AS DATE)
    comment: Date dispute was raised — primary time grain for billing dispute trending
    display_name: Raised Date
    format:
      type: date
      date_format: year_month_day
    synonyms:
      - dispute date
      - filing date
      - date raised
      - date

  - name: customer_id
    expr: source.customer_id
    comment: TMF customer identifier (FK to tmf_customer.customer)
    display_name: Customer ID

  - name: bill_id
    expr: source.bill_id
    comment: FK to tmf_customer.bill — associated billing record
    display_name: Bill ID
    synonyms:
      - billing id
      - invoice id

measures:
  - name: total_dispute_exceptions
    expr: COUNT(*)
    comment: Total count of billing dispute exceptions
    display_name: Total Dispute Exceptions
    synonyms:
      - dispute exception count
      - total exceptions
      - dispute anomaly count
      - billing dispute count

  - name: total_dispute_risk
    expr: SUM(source.amount_at_risk)
    comment: "Total USD amount at risk from billing dispute violations (USD 9.85B\
      \ across 291,857 exceptions, as of 2026-11-06)"
    display_name: Total Dispute Risk
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - dispute exposure
      - amount at risk
      - billing dispute leakage
      - total risk

  - name: over_credit_amount
    expr: SUM(source.amount_at_risk) FILTER (WHERE source.sub_check_type = 'over_credit')
    comment: "Total USD at risk from dispute over-credits, where adjusted amount exceeds\
      \ disputed amount (USD 1.66B as of 2026-11-06)"
    display_name: Over-Credit Amount
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - over credit exposure
      - excess credit amount
      - over-adjustment amount

  - name: fraud_pattern_amount
    expr: SUM(source.amount_at_risk) FILTER (WHERE source.sub_check_type = 'fraud_pattern')
    comment: "Total USD at risk from disputes matching fraud patterns: suspicious\
      \ timing, amounts, or duplication (USD 1.03B as of 2026-11-06)"
    display_name: Fraud Pattern Amount
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - fraud exposure
      - fraudulent dispute amount
      - suspicious dispute amount

  - name: sla_breach_amount
    expr: SUM(source.amount_at_risk) FILTER (WHERE source.sub_check_type = 'sla_breach')
    comment: Total USD at risk from disputes breaching resolution SLA deadlines (USD
      376.0M as of 2026-11-06)
    display_name: SLA Breach Amount
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - SLA exposure
      - breach amount
      - SLA violation amount

  - name: stale_dispute_amount
    expr: SUM(source.amount_at_risk) FILTER (WHERE source.sub_check_type = 'stale_dispute')
    comment: Total USD at risk from disputes open beyond acceptable aging thresholds
      (USD 3.06B as of 2026-11-06)
    display_name: Stale Dispute Amount
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - stale exposure
      - aged dispute amount
      - aging dispute amount

  - name: regulatory_escalation_amount
    expr: SUM(source.amount_at_risk) FILTER (WHERE source.sub_check_type = 'regulatory_escalation')
    comment: Total USD at risk from disputes escalated to regulatory bodies (USD 626.7M
      as of 2026-11-06)
    display_name: Regulatory Escalation Amount
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - regulatory exposure
      - escalation amount
      - regulatory risk

  - name: reopened_dispute_amount
    expr: SUM(source.amount_at_risk) FILTER (WHERE source.sub_check_type = 'reopened_dispute')
    comment: Total USD at risk from previously resolved disputes that were reopened
      (USD 2.51B as of 2026-11-06)
    display_name: Reopened Dispute Amount
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - reopened exposure
      - reopened amount
      - recurrence amount

  - name: unauthorized_waiver_amount
    expr: SUM(source.amount_at_risk) FILTER (WHERE source.sub_check_type = 'unauthorized_waiver')
    comment: Total USD at risk from dispute waivers applied without proper authorization
      (USD 584.2M as of 2026-11-06)
    display_name: Unauthorized Waiver Amount
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - unauthorized waiver exposure
      - unapproved waivers
      - waiver leakage

  - name: customer_count
    expr: COUNT(DISTINCT source.customer_id)
    comment: Number of distinct customers with billing dispute exceptions
    display_name: Customer Count
    synonyms:
      - affected customers
      - impacted accounts
      - customer impact

  - name: sla_breach_count
    expr: COUNT(*) FILTER (WHERE source.sla_breach_flag = true)
    comment: Count of exceptions with SLA breach flags
    display_name: SLA Breach Count
    synonyms:
      - SLA breaches
      - SLA violations
      - breached disputes

  - name: escalation_count
    expr: COUNT(*) FILTER (WHERE source.escalation_flag = true)
    comment: Count of exceptions with escalation flags
    display_name: Escalation Count
    synonyms:
      - escalations
      - escalated disputes
      - escalated cases

  - name: regulatory_escalation_count
    expr: COUNT(*) FILTER (WHERE source.regulatory_escalation_flag = true)
    comment: Count of exceptions with regulatory escalation flags
    display_name: Regulatory Escalation Count
    synonyms:
      - regulatory escalations
      - regulatory cases
      - regulator disputes

  - name: reopened_count
    expr: COUNT(*) FILTER (WHERE source.reopened_flag = true)
    comment: Count of exceptions flagged as reopened disputes
    display_name: Reopened Count
    synonyms:
      - reopened disputes
      - recurrences
      - reopened cases

  - name: avg_disputed_amount
    expr: AVG(source.disputed_amount)
    comment: Average disputed amount across all exceptions (USD)
    display_name: Avg Disputed Amount
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - average dispute
      - mean disputed amount
      - typical dispute amount

  - name: avg_amount_at_risk
    expr: AVG(source.amount_at_risk)
    comment: Average amount at risk per exception (USD)
    display_name: Avg Amount at Risk
    format:
      type: currency
      currency_code: USD
      decimal_places:
        type: exact
        places: 2
      abbreviation: compact
    synonyms:
      - average risk
      - mean risk per exception
      - typical risk amount
$$;
