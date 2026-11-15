-- Root-cause breakdown for the Overview bar chart and the queue filter chips.
-- One row per reconciliation check type, ranked by dollars at risk.
-- Source: v_gold_leakage_summary (22 sources, 60 types).
-- @param severity STRING = ALL
SELECT
  check_type,
  COUNT(*)                          AS exception_count,
  COALESCE(SUM(amount_at_risk), 0)  AS amount_at_risk
FROM cdm_tmforum.revenue_assurance.v_gold_leakage_summary
WHERE (UPPER(:severity) = 'ALL' OR UPPER(severity) = UPPER(:severity))  -- case-safe: view emits lowercase
GROUP BY check_type
ORDER BY amount_at_risk DESC;
