-- =============================================================================
-- Data Quality Audit
-- Lakeflow Declarative Pipeline source (ADR-004). Part of `ra_medallion_pipeline`.
--
-- The pipeline publishes its event log as the unqualified table
-- `pipeline_event_log` in the pipeline's default catalog/schema. This audit MV
-- uses the same bare-name convention as the other pipeline datasets.
--
-- Inline expectations cover row-level rules. This MV makes their latest
-- pass/fail counts queryable alongside the set-level checks that expectations
-- cannot express: DQ-1 source row-count ranges and DQ-5 scorecard PK
-- uniqueness.
--
-- DQ-6 lives with the warehouse forecast SQL because `ai_forecast` is not
-- executed in this pipeline DAG. Keeping that audit there avoids a first-run
-- dependency from the pipeline onto a warehouse-created object.
-- =============================================================================

CREATE OR REFRESH MATERIALIZED VIEW dq_audit
COMMENT 'Unified pipeline DQ audit: latest expectation metrics plus DQ-1 source volume and DQ-5 scorecard uniqueness checks.'
AS
WITH per_update AS (
  SELECT
    origin.update_id AS update_id,
    MAX(timestamp) AS last_ts
  FROM pipeline_event_log
  WHERE event_type = 'flow_progress'
    AND details:flow_progress.data_quality.expectations IS NOT NULL
  GROUP BY origin.update_id
),
latest_expectation_update AS (
  SELECT
    update_id
  FROM per_update
  QUALIFY ROW_NUMBER() OVER (ORDER BY last_ts DESC) = 1
),
exploded_expectations AS (
  SELECT
    event.origin.update_id AS update_id,
    event.timestamp AS observed_at,
    expectation.dataset AS dataset,
    expectation.name AS expectation_name,
    expectation.passed_records AS passed_records,
    expectation.failed_records AS failed_records
  FROM pipeline_event_log event
  INNER JOIN latest_expectation_update latest
    ON event.origin.update_id = latest.update_id
  LATERAL VIEW EXPLODE(
    FROM_JSON(
      event.details:flow_progress.data_quality.expectations,
      'ARRAY<STRUCT<name: STRING, dataset: STRING, passed_records: BIGINT, failed_records: BIGINT>>'
    )
  ) exploded AS expectation
  WHERE event.event_type = 'flow_progress'
    AND event.details:flow_progress.data_quality.expectations IS NOT NULL
),
inline_expectation_checks AS (
  SELECT
    'INLINE' AS check_type,
    dataset,
    expectation_name,
    update_id,
    MAX(observed_at) AS observed_at,
    SUM(passed_records + failed_records) AS observed_records,
    SUM(passed_records) AS passed_records,
    SUM(failed_records) AS failed_records,
    CASE WHEN SUM(failed_records) = 0 THEN 'GREEN' ELSE 'RED' END AS status,
    'failed_records = 0' AS expected_condition
  FROM exploded_expectations
  GROUP BY dataset, expectation_name, update_id
),
source_counts AS (
  SELECT 'salesforce_source.account' AS dataset, COUNT(*) AS observed_records, 9000 AS minimum_rows, 11000 AS maximum_rows FROM salesforce_source.account
  UNION ALL
  SELECT 'salesforce_source.contract', COUNT(*), 10000, 100000 FROM salesforce_source.contract
  UNION ALL
  SELECT 'salesforce_source.contract_line_item', COUNT(*), 50000, 150000 FROM salesforce_source.contract_line_item
  UNION ALL
  SELECT 'salesforce_source.sbqq__quote__c', COUNT(*), 1000, 10000 FROM salesforce_source.sbqq__quote__c
  UNION ALL
  SELECT 'salesforce_source.sbqq__quoteline__c', COUNT(*), 5000, 50000 FROM salesforce_source.sbqq__quoteline__c
  UNION ALL
  SELECT 'oracle_erp_source.ra_billed_circuit_rates', COUNT(*), 50000, 150000 FROM oracle_erp_source.ra_billed_circuit_rates
  UNION ALL
  SELECT 'oracle_erp_source.ra_customer_trx_all', COUNT(*), 10000, CAST(NULL AS BIGINT) FROM oracle_erp_source.ra_customer_trx_all
  UNION ALL
  SELECT 'oracle_erp_source.ra_customer_trx_lines_all', COUNT(*), 100000, CAST(NULL AS BIGINT) FROM oracle_erp_source.ra_customer_trx_lines_all
  UNION ALL
  SELECT 'oracle_erp_source.gl_je_lines', COUNT(*), 100000, CAST(NULL AS BIGINT) FROM oracle_erp_source.gl_je_lines
  UNION ALL
  SELECT 'oracle_erp_source.gl_je_headers', COUNT(*), 10000, CAST(NULL AS BIGINT) FROM oracle_erp_source.gl_je_headers
  UNION ALL
  SELECT 'oracle_erp_source.gl_budgets', COUNT(*), 1000, 5000 FROM oracle_erp_source.gl_budgets
  UNION ALL
  SELECT 'oracle_erp_source.revenue_recognition_schedule', COUNT(*), 50000, CAST(NULL AS BIGINT) FROM oracle_erp_source.revenue_recognition_schedule
  UNION ALL
  SELECT 'oracle_erp_source.ar_payment_schedules_all', COUNT(*), 10000, CAST(NULL AS BIGINT) FROM oracle_erp_source.ar_payment_schedules_all
  UNION ALL
  SELECT 'refinitiv_fx_source.gl_daily_rates', COUNT(*), 500, 1000 FROM refinitiv_fx_source.gl_daily_rates
  UNION ALL
  SELECT 'mdm_source.customer_crosswalk', COUNT(*), 9000, 11000 FROM mdm_source.customer_crosswalk
),
source_volume_checks AS (
  SELECT
    'DQ-1' AS check_type,
    dataset,
    'dq1_source_row_count_in_expected_range' AS expectation_name,
    CAST(NULL AS STRING) AS update_id,
    CAST(NULL AS TIMESTAMP) AS observed_at,
    observed_records,
    CASE
      WHEN observed_records >= minimum_rows
        AND (maximum_rows IS NULL OR observed_records <= maximum_rows)
      THEN observed_records ELSE 0
    END AS passed_records,
    CASE
      WHEN observed_records >= minimum_rows
        AND (maximum_rows IS NULL OR observed_records <= maximum_rows)
      THEN 0 ELSE observed_records
    END AS failed_records,
    CASE
      WHEN observed_records >= minimum_rows
        AND (maximum_rows IS NULL OR observed_records <= maximum_rows)
      THEN 'GREEN' ELSE 'RED'
    END AS status,
    CONCAT(
      'row_count >= ', minimum_rows,
      CASE WHEN maximum_rows IS NULL THEN '' ELSE CONCAT(' AND row_count <= ', maximum_rows) END
    ) AS expected_condition
  FROM source_counts
),
scorecard_counts AS (
  SELECT
    COUNT(*) AS observed_records,
    COUNT(DISTINCT customer_id) AS unique_records
  FROM gold_reconciliation_scorecard
),
scorecard_uniqueness_check AS (
  SELECT
    'DQ-5' AS check_type,
    'gold_reconciliation_scorecard' AS dataset,
    'dq5_customer_id_unique' AS expectation_name,
    CAST(NULL AS STRING) AS update_id,
    CAST(NULL AS TIMESTAMP) AS observed_at,
    observed_records,
    unique_records AS passed_records,
    observed_records - unique_records AS failed_records,
    CASE WHEN observed_records = unique_records THEN 'GREEN' ELSE 'RED' END AS status,
    'row_count = count(distinct customer_id)' AS expected_condition
  FROM scorecard_counts
),
scorecard_unattributed_totals AS (
  SELECT
    COUNT(*) AS scorecard_rows,
    MIN(unattributed_missing_salesforce_exceptions) AS min_exception_count,
    MAX(unattributed_missing_salesforce_exceptions) AS max_exception_count,
    MIN(unattributed_missing_salesforce_amount_at_risk) AS min_risk_amount,
    MAX(unattributed_missing_salesforce_amount_at_risk) AS max_risk_amount,
    (
      SELECT COUNT(*)
      FROM gold_leakage_summary
      WHERE check_type = 'contract_price_missing_salesforce' AND customer_id IS NULL
    ) AS leakage_exception_count,
    (
      SELECT COALESCE(SUM(amount_at_risk), 0)
      FROM gold_leakage_summary
      WHERE check_type = 'contract_price_missing_salesforce' AND customer_id IS NULL
    ) AS leakage_risk_amount
  FROM gold_reconciliation_scorecard
),
scorecard_unattributed_check AS (
  SELECT
    'DQ-5' AS check_type,
    'gold_reconciliation_scorecard' AS dataset,
    'dq5_unattributed_missing_salesforce_totals_match_gold_drilldown' AS expectation_name,
    CAST(NULL AS STRING) AS update_id,
    CAST(NULL AS TIMESTAMP) AS observed_at,
    scorecard_rows AS observed_records,
    CASE WHEN min_exception_count = max_exception_count
           AND min_risk_amount = max_risk_amount
           AND max_exception_count = leakage_exception_count
           AND ABS(max_risk_amount - leakage_risk_amount) < 0.01
      THEN scorecard_rows ELSE 0 END AS passed_records,
    CASE WHEN min_exception_count = max_exception_count
           AND min_risk_amount = max_risk_amount
           AND max_exception_count = leakage_exception_count
           AND ABS(max_risk_amount - leakage_risk_amount) < 0.01
      THEN 0 ELSE scorecard_rows END AS failed_records,
    CASE WHEN min_exception_count = max_exception_count
           AND min_risk_amount = max_risk_amount
           AND max_exception_count = leakage_exception_count
           AND ABS(max_risk_amount - leakage_risk_amount) < 0.01
      THEN 'GREEN' ELSE 'RED' END AS status,
    'scorecard unattributed totals are constant and equal gold_leakage_summary drill-down totals' AS expected_condition
  FROM scorecard_unattributed_totals
),
-- DQ-2 (set-level half): SOURCE_LINE_ITEM_ID must be a genuine primary key on
-- ra_billed_circuit_rates, or the 1:1 join in silver_contract_price_reconciliation
-- degrades back into a many-to-many fan-out. Row-level EXPECT clauses cannot
-- express uniqueness (no aggregates), so this lives here alongside DQ-5.
billed_rate_key_counts AS (
  SELECT
    COUNT(*) AS observed_records,
    COUNT(DISTINCT SOURCE_LINE_ITEM_ID) AS unique_records
  FROM oracle_erp_source.ra_billed_circuit_rates
),
billed_rate_key_uniqueness_check AS (
  SELECT
    'DQ-2' AS check_type,
    'oracle_erp_source.ra_billed_circuit_rates' AS dataset,
    'dq2_source_line_item_id_unique' AS expectation_name,
    CAST(NULL AS STRING) AS update_id,
    CAST(NULL AS TIMESTAMP) AS observed_at,
    observed_records,
    unique_records AS passed_records,
    observed_records - unique_records AS failed_records,
    CASE WHEN observed_records = unique_records THEN 'GREEN' ELSE 'RED' END AS status,
    'row_count = count(distinct SOURCE_LINE_ITEM_ID)' AS expected_condition
  FROM billed_rate_key_counts
),
-- DQ-2 (set-level half): silver_contract_price_reconciliation is a FULL
-- OUTER JOIN, so its row count is NOT simply contract_line_item's row
-- count -- it is contract_line_item's count PLUS the ERP-only
-- (MISSING_SALESFORCE) rows that have no matching contract line at all.
-- The prior version asserted observed_records = contract_line_item_count,
-- which is only true for a LEFT/INNER join; it would incorrectly fail (RED)
-- every time the simulator's missing_side_rate injects any
-- MISSING_SALESFORCE rows (which it always does by default -- see
-- data-sim/config.yaml). Fixed to independently compute the expected total
-- as contract_line_item's count plus the count of ra_billed_circuit_rates
-- rows whose SOURCE_LINE_ITEM_ID has no match in contract_line_item (a
-- direct, join-based count of the ERP-only rows, not a guess at the
-- simulator's injection rate). The row-level line_item_match_count/
-- billed_rate_match_count expectations catch true fan-out; this
-- independently proves nothing was dropped OR silently duplicated beyond
-- the expected ERP-only additions.
price_recon_grain_counts AS (
  SELECT
    (SELECT COUNT(*) FROM silver_contract_price_reconciliation) AS observed_records,
    (SELECT COUNT(DISTINCT line_item_id) FROM silver_contract_price_reconciliation) AS unique_line_items,
    (SELECT COUNT(*) FROM salesforce_source.contract_line_item) AS contract_line_item_count,
    (
      SELECT COUNT(*)
      FROM oracle_erp_source.ra_billed_circuit_rates billed
      LEFT ANTI JOIN salesforce_source.contract_line_item cli
        ON cli.Id = billed.SOURCE_LINE_ITEM_ID
    ) AS erp_only_row_count
),
price_recon_grain_check AS (
  SELECT
    'DQ-2' AS check_type,
    'silver_contract_price_reconciliation' AS dataset,
    'dq2_full_outer_row_count_accounts_for_erp_only_rows' AS expectation_name,
    CAST(NULL AS STRING) AS update_id,
    CAST(NULL AS TIMESTAMP) AS observed_at,
    observed_records,
    unique_line_items AS passed_records,
    observed_records - unique_line_items AS failed_records,
    CASE
      WHEN observed_records = unique_line_items
       AND observed_records = contract_line_item_count + erp_only_row_count
      THEN 'GREEN' ELSE 'RED'
    END AS status,
    'row_count = count(distinct line_item_id) = contract_line_item row_count + erp_only_row_count' AS expected_condition
  FROM price_recon_grain_counts
)
SELECT * FROM inline_expectation_checks
UNION ALL
SELECT * FROM source_volume_checks
UNION ALL
SELECT * FROM scorecard_uniqueness_check
UNION ALL
SELECT * FROM scorecard_unattributed_check
UNION ALL
SELECT * FROM billed_rate_key_uniqueness_check
UNION ALL
SELECT * FROM price_recon_grain_check;
