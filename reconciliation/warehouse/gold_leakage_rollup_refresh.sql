-- =============================================================================
-- Gold Leakage Rollup (pre-aggregated snapshot) — warehouse-executed rebuild
--
-- Object: cdm_tmforum.revenue_assurance.mv_gold_leakage_rollup (MANAGED Delta)
--
-- Why a snapshot table and not a materialized view:
--   A real MV over v_gold_leakage_summary fails with
--   UNSUPPORTED_NESTED_ROW_OR_COLUMN_ACCESS_POLICY (the masked
--   gold_leakage_summary MV). Same root cause as RA-DE-PIPELINE-MASK-BLOCKER.
--   The mv_ prefix is kept for now (rename to gold_leakage_rollup is blocked).
--
-- Grain: check_type x severity x source_table x known_leakage_flag x is_monetary
--   (detection_method is excluded: free text, ~1 distinct value per row).
--   PII-free (no customer_id / account_name), so no column masks are needed.
--
-- Refresh contract (RA-DEVOPS-ROLLUP-REFRESH, @devops, 2026-10-28):
--   - Step 1 creates the table with full COMMENTs only if it does not exist
--     (fresh environments). It is a no-op on the live table.
--   - Step 2 rebuilds the rows with INSERT OVERWRITE. Unlike CREATE OR REPLACE,
--     this keeps the table/column COMMENTs and the domain=finance tag.
--   - Severity is already normalized to lowercase in v_gold_leakage_summary
--     (RA-DE-SEVERITY-CASE-NORMALIZE, #603), so it is selected as-is.
--   - Run after gold refresh and ML scoring (ra_e2e_orchestration task
--     leakage_rollup_refresh). It must also be re-run after upstream fixes such
--     as the order-provisioning fanout fix (#511).
--   - Validation: SUM(exception_count) and SUM(total_amount_at_risk) must equal
--     COUNT(*) and SUM(amount_at_risk) on v_gold_leakage_summary.
-- =============================================================================

-- Step 1: bootstrap (no-op when the table already exists)
CREATE TABLE IF NOT EXISTS cdm_tmforum.revenue_assurance.mv_gold_leakage_rollup (
  check_type           STRING    COMMENT 'Type classification of the revenue leakage check (60 types across 8 gold sources)',
  severity             STRING    COMMENT 'Severity level of the findings in this group (critical, high, medium, low)',
  source_table         STRING    COMMENT 'Originating source table of the exceptions',
  known_leakage_flag   BOOLEAN   COMMENT 'Whether the exceptions are known/confirmed leakage instances',
  is_monetary          BOOLEAN   COMMENT 'TRUE when amount_at_risk > 0; FALSE for non-monetary process/compliance exceptions ($0)',
  exception_count      BIGINT    COMMENT 'Number of exception rows in this group (sums to v_gold_leakage_summary row count)',
  total_amount_at_risk DOUBLE    COMMENT 'Sum of amount_at_risk (USD) for this group',
  avg_amount_at_risk   DOUBLE    COMMENT 'Average amount_at_risk (USD) per exception in this group',
  max_amount_at_risk   DOUBLE    COMMENT 'Largest single amount_at_risk (USD) in this group',
  snapshot_ts          TIMESTAMP COMMENT 'Timestamp when this snapshot was built (CREATE OR REPLACE)'
)
COMMENT 'Pre-aggregated, PII-free rollup of v_gold_leakage_summary (same 8 gold sources, 60 check types). One row per check_type/severity/source_table/known_leakage_flag/is_monetary (detection_method excluded: free text, ~1 value per row). Built for fast dashboard and Genie headline queries (sub-second vs ~13s on the detail view). Managed Delta snapshot (an MV is not possible: UNSUPPORTED_NESTED_ROW_OR_COLUMN_ACCESS_POLICY on masked gold_leakage_summary). Rebuild with CREATE OR REPLACE after gold refresh / scoring; upstream fixes (e.g. order-provisioning fanout #511) require a rebuild. snapshot_ts records build time. Contains no customer_id/account_name, so no masking is required. Use v_gold_leakage_summary for row-level drill-down.';

-- Step 2: rebuild rows (keeps comments and tags)
INSERT OVERWRITE cdm_tmforum.revenue_assurance.mv_gold_leakage_rollup
SELECT
  check_type,
  severity,
  source_table,
  known_leakage_flag,
  is_monetary,
  COUNT(*)            AS exception_count,
  SUM(amount_at_risk) AS total_amount_at_risk,
  AVG(amount_at_risk) AS avg_amount_at_risk,
  MAX(amount_at_risk) AS max_amount_at_risk,
  CURRENT_TIMESTAMP() AS snapshot_ts
FROM cdm_tmforum.revenue_assurance.v_gold_leakage_summary
GROUP BY check_type, severity, source_table, known_leakage_flag, is_monetary;
