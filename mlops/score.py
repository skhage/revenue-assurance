"""Score current exceptions with the champion model and publish dashboard gold."""

from __future__ import annotations

import argparse

import mlflow
import mlflow.pyfunc
from pyspark.sql import SparkSession, Window, functions as functions

try:
    from features import FEATURE_COLUMNS, FEATURE_TABLE_NAME
except ModuleNotFoundError:
    from mlops.features import FEATURE_COLUMNS, FEATURE_TABLE_NAME


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--schema", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    spark = SparkSession.getActiveSession() or SparkSession.builder.getOrCreate()
    feature_table = f"{args.catalog}.{args.schema}.{FEATURE_TABLE_NAME}"
    output_table = f"{args.catalog}.{args.schema}.gold_anomaly_scores"
    model_name = f"{args.catalog}.{args.schema}.ra_anomaly_isolation_forest"
    model_uri = f"models:/{model_name}@champion"

    mlflow.set_registry_uri("databricks-uc")
    model = mlflow.pyfunc.load_model(model_uri)
    if model.metadata.signature is None or model.metadata.signature.outputs is None:
        raise RuntimeError("Champion model signature must include outputs")

    # BUG-ANOMALY-DOUBLE-COUNT fix: Exclude order_to_bill_reconciliation from the
    # standard scoring pipeline — OTB has its own dedicated scorer
    # (score_order_to_bill notebook) which reads gold_order_to_bill_leakage.
    # Including OTB here creates 2x rows with disjoint exception_ids.
    feature_frame = (
        spark.table(feature_table)
        .filter("check_type != 'order_to_bill_reconciliation'")
        .fillna(0.0, subset=FEATURE_COLUMNS)
    )
    predict = mlflow.pyfunc.spark_udf(spark, model_uri, result_type="double")
    scored = feature_frame.withColumn(
        "isolation_forest_score",
        predict(
            functions.struct(
                *[functions.col(column) for column in FEATURE_COLUMNS]
            )
        ).cast("double"),
    )

    score_stats = scored.agg(
        functions.avg("isolation_forest_score").alias("score_mean"),
        functions.stddev_pop("isolation_forest_score").alias("score_stddev"),
        functions.avg("amount_at_risk_log").alias("amount_mean"),
        functions.stddev_pop("amount_at_risk_log").alias("amount_stddev"),
    )

    standardized = scored.crossJoin(score_stats).withColumn(
        "zscore",
        functions.when(
            functions.col("score_stddev").isNull() | (functions.col("score_stddev") == 0),
            functions.lit(0.0),
        ).otherwise(
            (functions.col("isolation_forest_score") - functions.col("score_mean"))
            / functions.col("score_stddev")
        ),
    ).withColumn(
        "amount_zscore",
        functions.when(
            functions.col("amount_stddev").isNull() | (functions.col("amount_stddev") == 0),
            functions.lit(0.0),
        ).otherwise(
            (functions.col("amount_at_risk_log") - functions.col("amount_mean"))
            / functions.col("amount_stddev")
        ),
    )

    ranked = standardized.withColumn(
        "composite_anomaly_score",
        functions.round(
            0.75 * functions.greatest(functions.col("zscore"), functions.lit(0.0))
            + 0.25 * functions.greatest(functions.col("amount_zscore"), functions.lit(0.0)),
            6,
        ),
    ).withColumn(
        "anomaly_rank",
        functions.rank().over(
            Window.orderBy(
                functions.col("composite_anomaly_score").desc(),
                functions.col("isolation_forest_score").desc(),
            )
        ),
    )

    row_count = ranked.count()
    if row_count == 0:
        raise RuntimeError("Feature table contains no rows to score")

    result = ranked.withColumn(
        "review_priority",
        functions.when(functions.col("anomaly_rank") <= functions.lit(max(1, int(row_count * 0.05))), "HIGH")
        .when(functions.col("anomaly_rank") <= functions.lit(max(1, int(row_count * 0.20))), "MEDIUM")
        .otherwise("LOW"),
    ).select(
        "exception_id",
        functions.col("exception_id").alias("item_id"),
        "check_type",
        "customer_id",
        "account_name",
        "reference_id",
        "source_table",
        "detection_method",
        "known_leakage_flag",
        "amount_at_risk",
        "isolation_forest_score",
        functions.round("zscore", 6).alias("zscore"),
        "composite_anomaly_score",
        "anomaly_rank",
        "review_priority",
        functions.lit(model_name).alias("registered_model_name"),
        functions.lit("champion").alias("registered_model_alias"),
        functions.current_timestamp().alias("scored_at"),
    )

    # ── MERGE instead of overwrite to preserve column-level COMMENT ON metadata ──
    # BUG-CTAS-STRIPS-COMMENTS: saveAsTable(mode=overwrite) is a CTAS that destroys
    # column comments added by @data-engineer, violating CEO directive #2.
    # MERGE INTO preserves table/column metadata while achieving full-refresh semantics.
    #
    # BUG-OTB-DELETE-REGRESSION (2026-10-13): The previous DELETE clause
    # (`WHEN NOT MATCHED BY SOURCE THEN DELETE`) was unscoped — it purged
    # order-to-bill rows scored via the separate score_order_to_bill pipeline.
    # Fix: scope the DELETE to only remove rows whose check_type is in the
    # feature_account_anomaly source (i.e., the standard 14 check types).
    # Order-to-bill rows (check_type = 'order_to_bill_reconciliation') are
    # managed by score_order_to_bill and must not be deleted here.
    result.createOrReplaceTempView("_ml_scored_anomalies")

    output_table_sql = f"`{args.catalog}`.`{args.schema}`.`gold_anomaly_scores`"

    # Collect check_types present in the standard feature pipeline
    # FIX: replaced .rdd.flatMap() with DataFrame collect() for serverless compatibility
    # (JVM_ATTRIBUTE_NOT_SUPPORTED: PySpark RDDs not allowed on serverless compute)
    source_check_types = [
        row.check_type for row in result.select("check_type").distinct().collect()
    ]

    # If the table doesn't exist yet, create it from the scored DataFrame
    if not spark.catalog.tableExists(output_table):
        result.write.format("delta").saveAsTable(output_table)
    else:
        spark.sql(f"""
            MERGE INTO {output_table_sql} AS target
            USING _ml_scored_anomalies AS source
            ON target.exception_id = source.exception_id
            WHEN MATCHED THEN UPDATE SET *
            WHEN NOT MATCHED BY TARGET THEN INSERT *
            WHEN NOT MATCHED BY SOURCE
                AND target.check_type IN ({','.join(repr(ct) for ct in source_check_types)})
                THEN DELETE
        """)


if __name__ == "__main__":
    main()
