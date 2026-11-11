-- Base KPI aggregates over the unified leakage register.
-- The Overview page uses /api/analytics/kpis, which excludes Lakebase cases in
-- Recovered/WrittenOff state before presenting total_exceptions as "open".
-- Source: v_gold_leakage_summary (22 sources, 60 types, ~1.35M rows, ~$60B).
SELECT
  COUNT(*)                                      AS total_exceptions,
  COALESCE(SUM(amount_at_risk), 0)              AS total_at_risk,
  COUNT(*) FILTER (WHERE UPPER(severity) = 'HIGH') AS high_severity,  -- view emits lowercase since 2026-10-28; UPPER keeps this case-safe
  COUNT(DISTINCT account_name)                  AS accounts_affected
FROM cdm_tmforum.revenue_assurance.v_gold_leakage_summary;
