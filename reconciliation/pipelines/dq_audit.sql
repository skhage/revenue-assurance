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
)
SELECT * FROM inline_expectation_checks
UNION ALL
SELECT * FROM source_volume_checks
UNION ALL
SELECT * FROM scorecard_uniqueness_check;
