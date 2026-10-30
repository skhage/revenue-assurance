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
    # RA-ML-DROP-ARPU-TIER-WEIGHT-1026: train.py's fairness gate can keep an
    # older champion whose inputs differ from FEATURE_COLUMNS, so score with
    # the champion's own signature columns.
    model_columns = model.metadata.get_input_schema().input_names()
    missing = [col for col in model_columns if col not in spark.table(feature_table).columns]
    if missing:
        raise RuntimeError(f"Feature table is missing champion inputs: {missing}")

    # BUG-ANOMALY-DOUBLE-COUNT fix: Exclude order_to_bill_reconciliation from the
    # standard scoring pipeline — OTB has its own dedicated scorer
    # (score_order_to_bill notebook) which reads gold_order_to_bill_leakage.
    # Including OTB here creates 2x rows with disjoint exception_ids.
    feature_frame = (
        spark.table(feature_table)
        .filter("check_type != 'order_to_bill_reconciliation'")
        .fillna(0.0, subset=model_columns)
    )
    predict = mlflow.pyfunc.spark_udf(spark, model_uri, result_type="double")
    scored = feature_frame.withColumn(
        "isolation_forest_score",
        predict(
            functions.struct(
                *[functions.col(column) for column in model_columns]
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

    # RA-ML-WITHIN-CHECK-FAIRNESS / DEC-PM-CREDIT-PROXY-B4 (2026-10-29):
    # review_priority is stratified by check_type x segment_classification x
    # arpu_tier (top 5% = HIGH, next 15% = MEDIUM within each stratum). The
    # IsolationForest scores and the global anomaly_rank are unchanged; amount
    # at risk still drives ranking WITHIN each stratum. tmf_customer is read only.
    customer_dims = spark.table(f"{args.catalog}.tmf_customer.customer").select(
        "customer_id", "segment_classification", "arpu_tier"
    )
    stratum = Window.partitionBy("check_type", "segment_classification", "arpu_tier")
    stratified = (
        ranked.join(customer_dims, "customer_id", "left")
        .withColumn(
            "_stratum_rank",
            functions.rank().over(
                stratum.orderBy(
                    functions.col("composite_anomaly_score").desc(),
                    functions.col("isolation_forest_score").desc(),
                )
            ),
        )
        .withColumn(
            "_stratum_frac",
            functions.col("_stratum_rank") / functions.count(functions.lit(1)).over(stratum),
        )
    )

    result = stratified.withColumn(
        "review_priority",
        functions.when(functions.col("_stratum_frac") <= 0.05, "HIGH")
        .when(functions.col("_stratum_frac") <= 0.20, "MEDIUM")
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
        prune_orphans(spark, args.catalog, args.schema)


# RA-QA-BUG-ANOMALY-SCORES-STALE-ROWS / RA-ML-PAYMENT-DUP-RESCORE (2026-10-27):
# The scoped DELETE above only covers the core feature-table check types.
# Non-core types (e.g. payment_duplicate) are scored by rescore_per_check_fair
# and were never pruned when their source rows left v_gold_leakage_summary
# (710 stale payment_duplicate rows, -$16.1M). Prune every gold row whose
# (check_type, reference_id) is gone from v_gold_leakage_summary.
# A correlated DELETE against the masked view fails with
# UNSUPPORTED_NESTED_ROW_OR_COLUMN_ACCESS_POLICY, so collect the ids first
# and delete by id. A safety cap skips the prune if v_gold looks broken.
MAX_PRUNE_FRACTION = 0.01


def prune_orphans(spark: SparkSession, catalog: str, schema: str) -> int:
    gold = f"`{catalog}`.`{schema}`.`gold_anomaly_scores`"
    vgold = f"`{catalog}`.`{schema}`.`v_gold_leakage_summary`"
    if spark.table(vgold).limit(1).count() == 0:
        print("prune_orphans: v_gold_leakage_summary is empty; skipping prune")
        return 0
    total = spark.table(gold).count()
    stale_ids = [
        row.exception_id
        for row in spark.sql(f"""
            SELECT g.exception_id FROM {gold} g
            LEFT ANTI JOIN (SELECT DISTINCT check_type, reference_id FROM {vgold}) v
              ON g.check_type = v.check_type AND g.reference_id = v.reference_id
        """).collect()
    ]
    if not stale_ids:
        print("prune_orphans: 0 orphan rows")
        return 0
    if len(stale_ids) > max(1, int(total * MAX_PRUNE_FRACTION)):
        print(
            f"prune_orphans: {len(stale_ids):,} orphans exceeds {MAX_PRUNE_FRACTION:.0%} "
            f"of {total:,} rows; skipping prune for manual review"
        )
        return 0
    spark.createDataFrame([(i,) for i in stale_ids], "exception_id string") \
        .createOrReplaceTempView("_ml_orphan_ids")
    spark.sql(f"""
        MERGE INTO {gold} AS target
        USING _ml_orphan_ids AS source
        ON target.exception_id = source.exception_id
        WHEN MATCHED THEN DELETE
    """)
    print(f"prune_orphans: deleted {len(stale_ids):,} orphan rows")
    return len(stale_ids)


if __name__ == "__main__":
    main()
