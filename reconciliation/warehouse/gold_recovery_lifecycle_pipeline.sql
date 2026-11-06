-- gold_recovery_lifecycle_pipeline
-- Source of truth export of the live view cdm_tmforum.revenue_assurance.gold_recovery_lifecycle_pipeline
-- Exported 2026-11-06 by @devops (RA-DEVOPS-COMMENT-SQL-DRIFT-1106, RA-DEVOPS-LIFECYCLE-SQL-DRIFT-1105) via SHOW CREATE TABLE.
-- Amounts in comments are written as USD N (no dollar signs) per RA-DE-FIX-STRIPPED-DOLLAR-COMMENTS-1105.
-- Verified 2026-11-06: 117,751 rows, exception_id unique, sum(amount_at_risk) USD 4,303,695,775.28.
CREATE OR REPLACE VIEW cdm_tmforum.revenue_assurance.gold_recovery_lifecycle_pipeline (
  reference_id COMMENT 'FK to the reference record',
  exception_id COMMENT 'MD5 hash row identifier from gold_anomaly_scores (identical to item_id). Unique in this view (one row per exception). Use reference_id + check_type for joins to gold_leakage_summary.',
  check_type COMMENT 'Type classification for check',
  severity COMMENT 'Severity level of the finding',
  customer_id COMMENT 'MDM crosswalk to golden customer_id.',
  account_name COMMENT 'Account name; sourced from the golden customer name.',
  amount_at_risk COMMENT 'Amount at risk attribute of the gold-layer revenue leakage summary findings',
  detection_method COMMENT 'Detection method attribute of the gold-layer revenue leakage summary findings',
  known_leakage_flag COMMENT 'Boolean flag indicating known leakage status',
  lifecycle_stage COMMENT 'Recovery pipeline stage code (e.g., 3_CORRECTION_GENERATED, 5_PARTIAL_RECOVERY, 6_RECOVERED). Values: 3_CORRECTION_GENERATED, 5_FALSE_POSITIVE, 5_PARTIAL_RECOVERY, 5_WRITTEN_OFF, 6_RECOVERED. Derived from the LATEST recovery_feedback row per exception_id.',
  isolation_forest_score COMMENT 'Raw IsolationForest anomaly score (lower = more anomalous, range -1 to 1).',
  composite_anomaly_score COMMENT 'Weighted blend of isolation_forest_score and zscore for unified anomaly ranking.',
  anomaly_rank COMMENT 'Rank of this exception by composite_anomaly_score within its check_type (1 = most anomalous).',
  ml_review_priority COMMENT 'Triage priority bucket derived from anomaly_rank: Critical, High, Medium, or Low.',
  work_category COMMENT 'Work category classification for analyst routing: AUTO_CORRECT, BATCH_PROCESS, HIGH_VALUE_QUICK_WIN, STANDARD_INVESTIGATION, HIGH_VALUE_COMPLEX, LOW_PRIORITY_BACKLOG.',
  best_analyst COMMENT 'Analyst or system that resolved',
  triage_urgency_score COMMENT 'Composite urgency score: recovery_probability * log10(amount_at_risk) * risk_tier_multiplier (1.3x for CRITICAL/HIGH). Drives queue position ranking.',
  pareto_tier COMMENT 'Pareto concentration tier: TOP_20PCT_RECOVERY (first 50% of total), NEXT_30PCT_RECOVERY (50-80%), NEXT_15PCT_RECOVERY (80-95%), TAIL_5PCT_RECOVERY (95-100%). Focus on top tiers for maximum ROI.',
  optimal_queue_position COMMENT 'Global queue rank ordered by urgency_score DESC then optimized_roi_per_hour DESC. Position 1 is the highest-priority exception to work.',
  correction_type COMMENT 'ERP correction action mapped from check_type: RATE_ADJUSTMENT, DISCOUNT_REVERSAL, REVENUE_RECLASSIFICATION, FX_REVALUATION, COLLECTION_ACTION, USAGE_REBILLING, INVOICE_CORRECTION, SETTLEMENT_DISPUTE, or MANUAL_REVIEW.',
  gl_debit_account COMMENT 'Oracle ERP GL debit account code for the correcting journal entry (e.g., 1200=AR, 2400=Deferred Revenue, 5000=Network COGS, 6100=Partner Settlement).',
  gl_credit_account COMMENT 'Oracle ERP GL credit account code for the correcting journal entry (e.g., 4000=Recurring Revenue, 4010=Usage Revenue, 1200=AR).',
  auto_correctable COMMENT 'Boolean flag (from gold_billing_correction_queue): TRUE if correction can be auto-applied without human approval: amount_at_risk below USD 1,000 and recovery_probability at least 0.80, or known_leakage_flag = 1 and recovery_probability at least 0.90, or check_type = fx_rate_deviation and amount_at_risk below USD 5,000.',
  correction_status COMMENT 'Current lifecycle status of the correction item. All new queue entries start as PENDING.',
  correction_sla COMMENT 'SLA deadline mapped from recovery_priority_tier: WITHIN_4_HOURS (P1), WITHIN_24_HOURS (P2), WITHIN_7_DAYS (P3), WITHIN_30_DAYS (P4).',
  recovery_roi_per_hour COMMENT 'Expected recovery dollars per hour of analyst effort: expected_recovery_amount divided by estimated processing hours.',
  recovery_probability COMMENT 'Final calibrated recovery probability (0.01-0.99): product of base_rate and all 7 modifier factors.',
  expected_recovery_amount COMMENT 'Estimated recoverable dollars: amount_at_risk * recovery_probability.',
  recovery_priority_tier COMMENT 'Combined probability + amount tier: PRIORITY_1 through PRIORITY_4.',
  compound_risk_tier COMMENT 'Risk classification: CRITICAL (4+ checks), HIGH (3+ checks or >100K), ELEVATED (2 checks), STANDARD (1 check)',
  check_types_affected COMMENT 'Number of distinct RA check types (1-8) with exceptions for this customer',
  recovery_outcome COMMENT 'RECOVERED, PARTIALLY_RECOVERED, WRITTEN_OFF, FALSE_POSITIVE, DUPLICATE, ESCALATED, AUTO_RESOLVED (latest feedback row per exception_id)',
  amount_recovered COMMENT 'Actual dollar amount recovered',
  recovery_pct COMMENT 'amount_recovered / amount_at_risk',
  resolution_method COMMENT 'MANUAL_INVESTIGATION, AUTO_TRIAGE, CONTRACT_RENEGOTIATION, BILLING_CORRECTION, CREDIT_MEMO, SYSTEM_FIX',
  recovery_root_cause COMMENT 'BILLING_ERROR, RATE_CARD_DRIFT, EXPIRED_DISCOUNT, FX_MISMATCH, TIMING_DIFFERENCE, DATA_QUALITY, OTHER',
  investigation_hours COMMENT 'Hours spent investigating',
  triage_was_accurate COMMENT 'Did triage priority match actual urgency?',
  resolved_by COMMENT 'Analyst or system that resolved',
  resolved_at COMMENT 'When outcome was recorded',
  remaining_at_risk COMMENT 'Dollar amount still at risk for this exception.',
  unrecovered_expected COMMENT 'Expected unrecoverable amount based on probability model.',
  next_action COMMENT 'Recommended next action for this exception. Values: AUTO_CORRECT_READY, CLOSED_NO_ACTION, ESCALATE_REMAINING_BALANCE, SUBMIT_ERP_PRIORITY, SUBMIT_ERP_STANDARD.',
  sla_status COMMENT 'SLA commitment status for this exception. Values: NO_SLA_ASSIGNED, SLA_CLOSED.')
COMMENT 'Recovery lifecycle pipeline: exactly one row per exception (grain = gold_leakage_summary row; exception_id unique). Tracks detection through ML scoring, triage, correction generation, and case resolution: lifecycle stage, next action, SLA status, recovery gap. gold_anomaly_scores is joined on reference_id AND check_type (reference_id alone collides across check types); gold_recovery_probability_scores joined on exception_id; recovery_feedback reduced to its latest row per exception_id. Fanout fix RA-DE-LIFECYCLE-PIPELINE-FANOUT-1105 (2026-11-05).'
WITH SCHEMA COMPENSATION
AS WITH rf_latest AS (
    SELECT * FROM cdm_tmforum.revenue_assurance.recovery_feedback
    QUALIFY ROW_NUMBER() OVER (PARTITION BY exception_id ORDER BY resolved_at DESC NULLS LAST, created_at DESC NULLS LAST, feedback_id DESC) = 1
)
SELECT
    g.reference_id,
    a.exception_id,
    g.check_type,
    g.severity,
    g.customer_id,
    g.account_name,
    g.amount_at_risk,
    g.detection_method,
    g.known_leakage_flag,
    CASE
        WHEN rf.outcome = 'RECOVERED' THEN '6_RECOVERED'
        WHEN rf.outcome = 'PARTIALLY_RECOVERED' THEN '5_PARTIAL_RECOVERY'
        WHEN rf.outcome = 'WRITTEN_OFF' THEN '5_WRITTEN_OFF'
        WHEN rf.outcome = 'FALSE_POSITIVE' THEN '5_FALSE_POSITIVE'
        WHEN rf.outcome IS NOT NULL THEN '5_FEEDBACK_LOGGED'
        WHEN bc.correction_status = 'SUBMITTED' THEN '4_CORRECTION_SUBMITTED'
        WHEN bc.correction_type IS NOT NULL THEN '3_CORRECTION_GENERATED'
        WHEN roq.work_category IS NOT NULL THEN '2_WORK_QUEUED'
        WHEN a.composite_anomaly_score IS NOT NULL THEN '1_ML_SCORED'
        ELSE '0_DETECTED_ONLY'
    END AS lifecycle_stage,
    a.isolation_forest_score,
    a.composite_anomaly_score,
    a.anomaly_rank,
    a.review_priority AS ml_review_priority,
    roq.work_category,
    roq.best_analyst,
    roq.urgency_score AS triage_urgency_score,
    roq.pareto_tier,
    roq.optimal_queue_position,
    bc.correction_type,
    bc.gl_debit_account,
    bc.gl_credit_account,
    bc.auto_correctable,
    bc.correction_status,
    bc.correction_sla,
    bc.recovery_roi_per_hour,
    rp.recovery_probability,
    rp.expected_recovery_amount,
    rp.recovery_priority_tier,
    rp.compound_risk_tier,
    rp.check_types_affected,
    rf.outcome AS recovery_outcome,
    rf.amount_recovered,
    rf.recovery_pct,
    rf.resolution_method,
    rf.root_cause AS recovery_root_cause,
    rf.investigation_hours,
    rf.triage_was_accurate,
    rf.resolved_by,
    rf.resolved_at,
    g.amount_at_risk - COALESCE(rf.amount_recovered, 0) AS remaining_at_risk,
    COALESCE(rp.expected_recovery_amount, 0) - COALESCE(rf.amount_recovered, 0) AS unrecovered_expected,
    CASE
        WHEN rf.outcome IN ('RECOVERED', 'WRITTEN_OFF', 'FALSE_POSITIVE') THEN 'CLOSED_NO_ACTION'
        WHEN rf.outcome = 'PARTIALLY_RECOVERED' THEN 'ESCALATE_REMAINING_BALANCE'
        WHEN bc.auto_correctable = TRUE AND bc.correction_status = 'PENDING' THEN 'AUTO_CORRECT_READY'
        WHEN bc.correction_type IS NOT NULL AND bc.correction_status = 'PENDING'
             AND rp.recovery_priority_tier = 'PRIORITY_1_HIGH_VALUE_HIGH_PROB' THEN 'SUBMIT_ERP_PRIORITY'
        WHEN bc.correction_type IS NOT NULL AND bc.correction_status = 'PENDING' THEN 'SUBMIT_ERP_STANDARD'
        WHEN roq.work_category = 'HIGH_VALUE_QUICK_WIN' THEN 'INVESTIGATE_QUICK_WIN'
        WHEN roq.work_category = 'BATCH_EFFICIENCY_PLAY' THEN 'BATCH_PROCESS'
        WHEN a.review_priority = 'HIGH' THEN 'URGENT_ML_REVIEW'
        WHEN a.composite_anomaly_score IS NOT NULL THEN 'STANDARD_REVIEW'
        ELSE 'INITIAL_TRIAGE_NEEDED'
    END AS next_action,
    CASE
        WHEN bc.correction_sla = '24h' AND bc.correction_status = 'PENDING' THEN 'SLA_BREACH_RISK'
        WHEN bc.correction_sla = '72h' AND bc.correction_status = 'PENDING' THEN 'SLA_MONITOR'
        WHEN rf.outcome IS NOT NULL THEN 'SLA_CLOSED'
        ELSE 'NO_SLA_ASSIGNED'
    END AS sla_status
FROM cdm_tmforum.revenue_assurance.gold_leakage_summary g
LEFT JOIN cdm_tmforum.revenue_assurance.gold_anomaly_scores a
    ON g.reference_id = a.reference_id AND g.check_type = a.check_type
LEFT JOIN cdm_tmforum.revenue_assurance.gold_billing_correction_queue bc
    ON a.exception_id = bc.exception_id
LEFT JOIN cdm_tmforum.revenue_assurance.gold_recovery_optimization_queue roq
    ON a.exception_id = roq.exception_id
LEFT JOIN cdm_tmforum.revenue_assurance.gold_recovery_probability_scores rp
    ON a.exception_id = rp.exception_id
LEFT JOIN rf_latest rf
    ON a.exception_id = rf.exception_id;
