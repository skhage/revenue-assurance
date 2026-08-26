"""Shared feature-table contract for anomaly training and scoring."""

FEATURE_TABLE_NAME = "feature_account_anomaly"
FEATURE_COLUMNS = [
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
