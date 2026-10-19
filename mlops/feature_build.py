"""Build the exception-grain Unity Catalog feature table.

RA-AI-ML-RECALIBRATION (2026-10-06): Enhanced with recovery-feedback
aggregate features at check_type and customer_id grains.
"""

from __future__ import annotations

import argparse

from databricks.feature_engineering import FeatureEngineeringClient
from pyspark.sql import DataFrame, SparkSession

try:
    from features import FEATURE_COLUMNS, FEATURE_TABLE_NAME
except ModuleNotFoundError:
    from mlops.features import FEATURE_COLUMNS, FEATURE_TABLE_NAME



def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--schema", required=True)
    return parser.parse_args()


def build_feature_frame(spark: SparkSession, catalog: str, schema: str) -> DataFrame:
    leakage_table = f"`{catalog}`.`{schema}`.`gold_leakage_summary`"
    scorecard_table = f"`{catalog}`.`{schema}`.`gold_reconciliation_scorecard`"
    customer_table = f"`{catalog}`.`tmf_customer`.`customer`"
    feedback_table = f"`{catalog}`.`{schema}`.`recovery_feedback`"

    return spark.sql(
        f"""
        WITH exception_base AS (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY
                check_type,
                COALESCE(CAST(customer_id AS STRING), '__NULL__'),
                COALESCE(reference_id, '__NULL__'),
                COALESCE(source_table, '__NULL__'),
                CAST(amount_at_risk AS STRING)
              ORDER BY COALESCE(account_name, ''), COALESCE(detection_method, '')
            ) AS duplicate_ordinal
          FROM {leakage_table}
          -- RA-ML-FEATURE-EXCLUDE-OTB: OTB has its own dedicated scorer
          -- (score_order_to_bill) that builds features directly from
          -- gold_order_to_bill_leakage. Exclude from general feature table.
          WHERE check_type != 'order_to_bill_reconciliation'
        ),
        exception_enriched AS (
          SELECT
            SHA2(CONCAT_WS(
              '||',
              e.check_type,
              COALESCE(CAST(e.customer_id AS STRING), '__NULL__'),
              COALESCE(e.reference_id, '__NULL__'),
              COALESCE(e.source_table, '__NULL__'),
              CAST(e.amount_at_risk AS STRING),
              CAST(e.duplicate_ordinal AS STRING)
            ), 256) AS exception_id,
            e.check_type,
            e.severity,
            e.customer_id,
            e.account_name,
            e.reference_id,
            e.source_table,
            e.detection_method,
            CAST(e.known_leakage_flag AS INT) AS known_leakage_flag,
            CAST(e.amount_at_risk AS DOUBLE) AS amount_at_risk,
            CAST(LOG1P(GREATEST(e.amount_at_risk, 0.0)) AS DOUBLE) AS amount_at_risk_log,
            CAST(CASE e.severity WHEN 'HIGH' THEN 2.0 ELSE 1.0 END AS DOUBLE) AS severity_weight,
            CAST(CASE WHEN e.customer_id IS NULL THEN 1.0 ELSE 0.0 END AS DOUBLE) AS missing_customer_flag,
            CAST(CASE WHEN e.detection_method = 'ai_extracted' THEN 1.0 ELSE 0.0 END AS DOUBLE) AS ai_extracted_flag,
            CAST(COUNT(*) OVER (PARTITION BY e.check_type) AS DOUBLE) AS check_type_frequency,
            CAST(COUNT(*) OVER (PARTITION BY e.customer_id) AS DOUBLE) AS customer_exception_count,
            CAST(SUM(e.amount_at_risk) OVER (PARTITION BY e.customer_id) AS DOUBLE) AS customer_total_amount_at_risk,
            CAST(AVG(e.amount_at_risk) OVER (PARTITION BY e.customer_id) AS DOUBLE) AS customer_avg_amount_at_risk,
            CAST(COALESCE(s.composite_health_score, 100.0) AS DOUBLE) AS composite_health_score,
            CAST(COALESCE(s.total_exceptions, 0.0) AS DOUBLE) AS scorecard_total_exceptions,
            CAST(COALESCE(s.total_amount_at_risk, 0.0) AS DOUBLE) AS scorecard_total_amount_at_risk,
            CAST(CASE COALESCE(s.risk_tier, 'GREEN') WHEN 'RED' THEN 2.0 WHEN 'AMBER' THEN 1.0 ELSE 0.0 END AS DOUBLE) AS risk_tier_weight,
            CAST(CASE
              WHEN COALESCE(c.credit_class, '') IN ('d', 'unrated') THEN 2.0
              WHEN COALESCE(c.credit_class, '') IN ('c', 'cc', 'ccc') THEN 1.5
              WHEN COALESCE(c.credit_class, '') IN ('b', 'bb', 'bbb') THEN 1.0
              ELSE 0.0
            END AS DOUBLE) AS credit_risk_weight,
            CAST(CASE COALESCE(c.arpu_tier, s.arpu_tier, '')
              WHEN 'tier_1_high' THEN 2.0
              WHEN 'tier_2_medium' THEN 1.0
              WHEN 'tier_3_low' THEN 0.5
              ELSE 0.0
            END AS DOUBLE) AS arpu_tier_weight,
            CURRENT_TIMESTAMP() AS feature_updated_at
          FROM exception_base e
          LEFT JOIN {scorecard_table} s
            ON e.customer_id = s.customer_id
          LEFT JOIN {customer_table} c
            ON e.customer_id = c.customer_id
        ),
        -- RA-AI-ML-RECALIBRATION: Recovery feedback aggregates
        check_type_recovery AS (
          SELECT
            check_type,
            CAST(COUNT(*) AS DOUBLE) AS ct_feedback_count,
            CAST(SUM(CASE WHEN outcome = 'RECOVERED' THEN 1 ELSE 0 END) / GREATEST(COUNT(*), 1) AS DOUBLE) AS ct_recovery_rate,
            CAST(SUM(CASE WHEN outcome = 'WRITTEN_OFF' THEN 1 ELSE 0 END) / GREATEST(COUNT(*), 1) AS DOUBLE) AS ct_writeoff_rate,
            CAST(SUM(CASE WHEN outcome = 'FALSE_POSITIVE' THEN 1 ELSE 0 END) / GREATEST(COUNT(*), 1) AS DOUBLE) AS ct_false_positive_rate,
            CAST(AVG(recovery_pct) AS DOUBLE) AS ct_avg_recovery_pct,
            CAST(AVG(investigation_hours) AS DOUBLE) AS ct_avg_investigation_hours,
            CAST(AVG(CAST(triage_was_accurate AS INT)) AS DOUBLE) AS ct_triage_accuracy
          FROM {feedback_table}
          GROUP BY check_type
        ),
        customer_recovery AS (
          SELECT
            customer_id,
            CAST(COUNT(*) AS DOUBLE) AS cust_feedback_count,
            CAST(SUM(CASE WHEN outcome = 'RECOVERED' THEN 1 ELSE 0 END) / GREATEST(COUNT(*), 1) AS DOUBLE) AS cust_recovery_rate,
            CAST(SUM(CASE WHEN outcome = 'WRITTEN_OFF' THEN 1 ELSE 0 END) / GREATEST(COUNT(*), 1) AS DOUBLE) AS cust_writeoff_rate,
            CAST(AVG(recovery_pct) AS DOUBLE) AS cust_avg_recovery_pct,
            CAST(AVG(investigation_hours) AS DOUBLE) AS cust_avg_investigation_hours
          FROM {feedback_table}
          WHERE customer_id IS NOT NULL
          GROUP BY customer_id
        )
        SELECT
          ee.*,
          CAST(COALESCE(ctr.ct_feedback_count, 0.0) AS DOUBLE) AS ct_feedback_count,
          CAST(COALESCE(ctr.ct_recovery_rate, 0.5) AS DOUBLE) AS ct_recovery_rate,
          CAST(COALESCE(ctr.ct_writeoff_rate, 0.0) AS DOUBLE) AS ct_writeoff_rate,
          CAST(COALESCE(ctr.ct_false_positive_rate, 0.0) AS DOUBLE) AS ct_false_positive_rate,
          CAST(COALESCE(ctr.ct_avg_recovery_pct, 0.5) AS DOUBLE) AS ct_avg_recovery_pct,
          CAST(COALESCE(ctr.ct_avg_investigation_hours, 8.0) AS DOUBLE) AS ct_avg_investigation_hours,
          CAST(COALESCE(ctr.ct_triage_accuracy, 0.5) AS DOUBLE) AS ct_triage_accuracy,
          CAST(COALESCE(cr.cust_feedback_count, 0.0) AS DOUBLE) AS cust_feedback_count,
          CAST(COALESCE(cr.cust_recovery_rate, 0.5) AS DOUBLE) AS cust_recovery_rate,
          CAST(COALESCE(cr.cust_writeoff_rate, 0.0) AS DOUBLE) AS cust_writeoff_rate,
          CAST(COALESCE(cr.cust_avg_recovery_pct, 0.5) AS DOUBLE) AS cust_avg_recovery_pct,
          CAST(COALESCE(cr.cust_avg_investigation_hours, 8.0) AS DOUBLE) AS cust_avg_investigation_hours,
          CAST(
            0.4 * COALESCE(1.0 - ctr.ct_recovery_rate, 0.5)
            + 0.3 * COALESCE(ctr.ct_writeoff_rate, 0.0) * 3.0
            + 0.2 * COALESCE(cr.cust_writeoff_rate, 0.0) * 3.0
            + 0.1 * LEAST(COALESCE(ctr.ct_avg_investigation_hours, 8.0) / 15.0, 1.0)
          AS DOUBLE) AS recovery_difficulty_score
        FROM exception_enriched ee
        LEFT JOIN check_type_recovery ctr ON ee.check_type = ctr.check_type
        LEFT JOIN customer_recovery cr ON ee.customer_id = cr.customer_id
        """
    )


def main() -> None:
    args = parse_args()
    spark = SparkSession.getActiveSession() or SparkSession.builder.getOrCreate()
    feature_table = f"{args.catalog}.{args.schema}.{FEATURE_TABLE_NAME}"
    feature_frame = build_feature_frame(spark, args.catalog, args.schema).fillna(
        0.0, subset=FEATURE_COLUMNS
    )

    if feature_frame.limit(1).count() == 0:
        raise RuntimeError("gold_leakage_summary contains no exceptions to feature-engineer")

    feature_client = FeatureEngineeringClient(model_registry_uri="databricks-uc")
    if spark.catalog.tableExists(feature_table):
        # ── MERGE instead of DELETE-then-write to prevent data loss ──
        # BUG-FEATURE-TABLE-EMPTY: The old pattern (DELETE all → write_table)
        # left the table empty when write_table failed after the DELETE.
        # MERGE INTO is transactional: either the full swap succeeds or
        # the table retains its prior state.  Also preserves column-level
        # COMMENT ON metadata per CEO directive #2.
        feature_frame.createOrReplaceTempView("_rebuilt_features")
        feature_table_sql = f"`{args.catalog}`.`{args.schema}`.`{FEATURE_TABLE_NAME}`"
        spark.sql(f"""
            MERGE INTO {feature_table_sql} AS target
            USING _rebuilt_features AS source
            ON target.exception_id = source.exception_id
            WHEN MATCHED THEN UPDATE SET *
            WHEN NOT MATCHED BY TARGET THEN INSERT *
            WHEN NOT MATCHED BY SOURCE THEN DELETE
        """)
    else:
        feature_client.create_table(
            name=feature_table,
            primary_keys=["exception_id"],
            df=feature_frame,
            description=(
                "Exception-grain revenue assurance features sourced from reconciliation "
                "outputs and read-only TM Forum customer attributes."
            ),
        )


if __name__ == "__main__":
    main()
