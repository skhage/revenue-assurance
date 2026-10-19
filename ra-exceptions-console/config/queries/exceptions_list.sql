-- Exception queue: the triage grid, ranked by dollars at risk.
-- Filters are optional; pass the 'ALL' / '' sentinels to disable a filter.
-- A stable exception_id is synthesized so case state (Lakebase) can key on it
-- without materializing all ~1.1M exceptions into Postgres.
--
-- Source: v_gold_leakage_summary (read-time UNION of 8 gold sources, 52 types,
-- ~1.1M rows / ~$41.8B). Includes PII masking via UC row-level security.
-- @param check_type STRING = ALL
-- @param severity STRING = ALL
-- @param search STRING
-- @param row_limit INT = 50
-- @param row_offset INT = 0
WITH all_exceptions AS (
  SELECT check_type, severity, customer_id, account_name, amount_at_risk,
         source_table, detection_method, known_leakage_flag, reference_id
  FROM cdm_tmforum.revenue_assurance.v_gold_leakage_summary
)
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
FROM all_exceptions
WHERE (:check_type = 'ALL' OR check_type = :check_type)
  AND (:severity = 'ALL'  OR severity = :severity)
  AND (
        :search = ''
     OR lower(coalesce(account_name, '')) LIKE '%' || lower(:search) || '%'
     OR lower(coalesce(reference_id, '')) LIKE '%' || lower(:search) || '%'
  )
ORDER BY amount_at_risk DESC
LIMIT :row_limit OFFSET :row_offset;
