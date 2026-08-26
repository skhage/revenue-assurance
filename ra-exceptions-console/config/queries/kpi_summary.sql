-- KPI tiles for the Overview page.
-- Aggregates the unified leakage register (all silver reconciliation checks).
SELECT
  COUNT(*)                                      AS open_exceptions,
  COALESCE(SUM(amount_at_risk), 0)              AS total_at_risk,
  COUNT(*) FILTER (WHERE severity = 'HIGH')     AS high_severity,
  COUNT(DISTINCT account_name)                  AS accounts_affected
FROM cdm_tmforum.revenue_assurance.gold_leakage_summary;
