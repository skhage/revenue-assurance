"""Score current exceptions with the champion model and publish dashboard gold."""

from __future__ import annotations

import argparse

from databricks.feature_engineering import FeatureEngineeringClient
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

    feature_client = FeatureEngineeringClient(model_registry_uri="databricks-uc")
    feature_frame = spark.table(feature_table).fillna(0.0, subset=FEATURE_COLUMNS)
    key_frame = feature_frame.select("exception_id")
    predictions = feature_client.score_batch(
        model_uri=model_uri,
        df=key_frame,
        result_type="double",
    ).select(
        "exception_id",
        functions.col("prediction").cast("double").alias("isolation_forest_score"),
    )

    scored = predictions.join(feature_frame, "exception_id", "inner")
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

    result.write.format("delta").mode("overwrite").option(
        "overwriteSchema", "true"
    ).saveAsTable(output_table)
    spark.sql(
        f"COMMENT ON TABLE `{args.catalog}`.`{args.schema}`.`gold_anomaly_scores` IS "
        "'Managed batch anomaly scores produced from the champion Unity Catalog model.'"
    )


if __name__ == "__main__":
    main()
