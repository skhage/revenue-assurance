"""Shared feature-table contract for anomaly training and scoring.

RA-AI-ML-RECALIBRATION (2026-10-06): Added 13 recovery-feedback features
to improve outcome differentiation (RECOVERED vs WRITTEN_OFF vs PARTIALLY_RECOVERED).
Model v40 trained on 28 features; gap improved 8.9x (0.03 → 0.22).
"""

FEATURE_TABLE_NAME = "feature_account_anomaly"

# --- Original exception + scorecard + customer features (15) ---
_ORIGINAL_FEATURE_COLUMNS = [
    "amount_at_risk",
    "amount_at_risk_log",
    "severity_weight",
    "missing_customer_flag",
    "ai_extracted_flag",
    "check_type_frequency",
    "customer_exception_count",
    "customer_total_amount_at_risk",
    "customer_avg_amount_at_risk",
    "composite_health_score",
    "scorecard_total_exceptions",
    "scorecard_total_amount_at_risk",
    "risk_tier_weight",
    "credit_risk_weight",
    "arpu_tier_weight",
]

# --- Recovery-feedback features (13) — RA-AI-ML-RECALIBRATION ---
_RECOVERY_FEATURE_COLUMNS = [
    "ct_feedback_count",
    "ct_recovery_rate",
    "ct_writeoff_rate",
    "ct_false_positive_rate",
    "ct_avg_recovery_pct",
    "ct_avg_investigation_hours",
    "ct_triage_accuracy",
    "cust_feedback_count",
    "cust_recovery_rate",
    "cust_writeoff_rate",
    "cust_avg_recovery_pct",
    "cust_avg_investigation_hours",
    "recovery_difficulty_score",
]

FEATURE_COLUMNS = _ORIGINAL_FEATURE_COLUMNS + _RECOVERY_FEATURE_COLUMNS
