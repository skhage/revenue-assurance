-- Root-cause breakdown for the Overview bar chart and the queue filter chips.
-- One row per reconciliation check type, ranked by dollars at risk.
-- @param severity STRING = ALL
SELECT
  check_type,
  COUNT(*)                          AS exception_count,
  COALESCE(SUM(amount_at_risk), 0)  AS amount_at_risk
FROM cdm_tmforum.revenue_assurance.gold_leakage_summary
WHERE (:severity = 'ALL' OR severity = :severity)
GROUP BY check_type
ORDER BY amount_at_risk DESC;
