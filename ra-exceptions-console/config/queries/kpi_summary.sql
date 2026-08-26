-- Base KPI aggregates over the unified leakage register.
-- The Overview page uses /api/analytics/kpis, which excludes Lakebase cases in
-- Recovered/WrittenOff state before presenting total_exceptions as "open".
SELECT
  COUNT(*)                                      AS total_exceptions,
  COALESCE(SUM(amount_at_risk), 0)              AS total_at_risk,
  COUNT(*) FILTER (WHERE severity = 'HIGH')     AS high_severity,
  COUNT(DISTINCT account_name)                  AS accounts_affected
FROM cdm_tmforum.revenue_assurance.gold_leakage_summary;
