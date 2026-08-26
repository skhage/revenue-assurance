"""Build the exception-grain Unity Catalog feature table."""

from __future__ import annotations

import argparse

from databricks.feature_engineering import FeatureEngineeringClient
from pyspark.sql import DataFrame, SparkSession


FEATURE_TABLE_NAME = "feature_account_anomaly"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--schema", required=True)
    return parser.parse_args()


def build_feature_frame(spark: SparkSession, catalog: str, schema: str) -> DataFrame:
    leakage_table = f"`{catalog}`.`{schema}`.`gold_leakage_summary`"
    scorecard_table = f"`{catalog}`.`{schema}`.`gold_reconciliation_scorecard`"
    customer_table = f"`{catalog}`.`tmf_customer`.`customer`"

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
            CAST(CASE COALESCE(c.credit_class, '') WHEN 'HIGH_RISK' THEN 2.0 WHEN 'MEDIUM_RISK' THEN 1.0 ELSE 0.0 END AS DOUBLE) AS credit_risk_weight,
            CAST(CASE COALESCE(c.arpu_tier, s.arpu_tier, '') WHEN 'HIGH' THEN 2.0 WHEN 'MEDIUM' THEN 1.0 ELSE 0.0 END AS DOUBLE) AS arpu_tier_weight,
            CURRENT_TIMESTAMP() AS feature_updated_at
          FROM exception_base e
          LEFT JOIN {scorecard_table} s
            ON e.customer_id = s.customer_id
          LEFT JOIN {customer_table} c
            ON e.customer_id = c.customer_id
        )
        SELECT * FROM exception_enriched
        """
    )


def main() -> None:
    args = parse_args()
    spark = SparkSession.getActiveSession() or SparkSession.builder.getOrCreate()
    feature_table = f"{args.catalog}.{args.schema}.{FEATURE_TABLE_NAME}"
    feature_frame = build_feature_frame(spark, args.catalog, args.schema)

    if feature_frame.limit(1).count() == 0:
        raise RuntimeError("gold_leakage_summary contains no exceptions to feature-engineer")

    feature_client = FeatureEngineeringClient(model_registry_uri="databricks-uc")
    if spark.catalog.tableExists(feature_table):
        feature_client.write_table(name=feature_table, df=feature_frame, mode="overwrite")
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
