-- Exception queue: the triage grid, ranked by dollars at risk.
-- Filters are optional; pass the 'ALL' / '' sentinels to disable a filter.
-- A stable exception_id is synthesized so case state (Lakebase) can key on it
-- without materializing all ~48K exceptions into Postgres.
-- @param check_type STRING = ALL
-- @param severity STRING = ALL
-- @param search STRING
-- @param row_limit INT = 50
-- @param row_offset INT = 0
SELECT
  md5(concat_ws('|', check_type, coalesce(reference_id, ''),
       coalesce(cast(customer_id AS string), ''), cast(amount_at_risk AS string))) AS exception_id,
  reference_id,
  account_name,
  check_type,
  severity,
  amount_at_risk,
  detection_method,
  source_table,
  customer_id,
  known_leakage_flag
FROM cdm_tmforum.revenue_assurance.gold_leakage_summary
WHERE (:check_type = 'ALL' OR check_type = :check_type)
  AND (:severity = 'ALL'  OR severity = :severity)
  AND (
        :search = ''
     OR lower(coalesce(account_name, '')) LIKE '%' || lower(:search) || '%'
     OR lower(coalesce(reference_id, '')) LIKE '%' || lower(:search) || '%'
  )
ORDER BY amount_at_risk DESC
LIMIT :row_limit OFFSET :row_offset;
