"""Train, track, register, and promote the managed anomaly model."""

from __future__ import annotations

import argparse
import os
import time

import mlflow
import mlflow.sklearn
from databricks.feature_engineering import FeatureEngineeringClient, FeatureLookup
from mlflow.models import infer_signature
from mlflow.tracking import MlflowClient
from pyspark.sql import SparkSession

try:
    from features import FEATURE_COLUMNS, FEATURE_TABLE_NAME
    from modeling import IsolationForestScoreModel
except ModuleNotFoundError:
    from mlops.features import FEATURE_COLUMNS, FEATURE_TABLE_NAME
    from mlops.modeling import IsolationForestScoreModel


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--experiment-name", required=True)
    parser.add_argument("--contamination", type=float, default=0.05)
    return parser.parse_args()


def registered_version_for_run(
    client: MlflowClient, model_name: str, run_id: str, timeout_seconds: int = 120
) -> str:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        versions = client.search_model_versions(f"name='{model_name}'")
        matches = [version for version in versions if version.run_id == run_id]
        if matches:
            return max(matches, key=lambda version: int(version.version)).version
        time.sleep(5)
    raise TimeoutError(f"Model version for run {run_id} was not registered in time")


def main() -> None:
    args = parse_args()
    spark = SparkSession.getActiveSession() or SparkSession.builder.getOrCreate()
    feature_table = f"{args.catalog}.{args.schema}.{FEATURE_TABLE_NAME}"
    model_name = f"{args.catalog}.{args.schema}.ra_anomaly_isolation_forest"

    mlflow.set_registry_uri("databricks-uc")
    mlflow.set_experiment(args.experiment_name)
    feature_client = FeatureEngineeringClient(model_registry_uri="databricks-uc")

    key_frame = spark.table(feature_table).select("exception_id")
    training_set = feature_client.create_training_set(
        df=key_frame,
        feature_lookups=[
            FeatureLookup(
                table_name=feature_table,
                lookup_key="exception_id",
                feature_names=FEATURE_COLUMNS,
            )
        ],
        exclude_columns=["exception_id"],
    )
    training_frame = training_set.load_df().select(*FEATURE_COLUMNS).fillna(0.0)
    training_pandas = training_frame.toPandas()
    if len(training_pandas) < 20:
        raise RuntimeError("At least 20 exception rows are required to train IsolationForest")

    model = IsolationForestScoreModel(
        n_estimators=300,
        contamination=args.contamination,
        max_samples="auto",
        random_state=42,
        n_jobs=-1,
    )

    with mlflow.start_run(run_name="ra_isolation_forest_training") as run:
        model.fit(training_pandas)
        predictions = model.predict(training_pandas)
        signature = infer_signature(training_pandas, predictions)

        mlflow.log_params(
            {
                "feature_table": feature_table,
                "training_rows": len(training_pandas),
                "feature_count": len(FEATURE_COLUMNS),
                "random_state": 42,
            }
        )
        mlflow.log_metrics(
            {
                "mean_anomaly_score": float(predictions.mean()),
                "std_anomaly_score": float(predictions.std()),
                "p95_anomaly_score": float(training_pandas.assign(score=predictions)["score"].quantile(0.95)),
            }
        )
        mlflow.log_dict({"feature_columns": FEATURE_COLUMNS}, "feature_columns.json")

        feature_client.log_model(
            model=model,
            artifact_path="model",
            flavor=mlflow.sklearn,
            training_set=training_set,
            registered_model_name=model_name,
            signature=signature,
            input_example=training_pandas.head(5),
            code_paths=[os.path.join(os.path.dirname(os.path.abspath(__file__)), "modeling.py")],
        )

        registry_client = MlflowClient(registry_uri="databricks-uc")
        version = registered_version_for_run(registry_client, model_name, run.info.run_id)
        registry_client.set_registered_model_alias(model_name, "champion", version)
        mlflow.set_tag("registered_model_name", model_name)
        mlflow.set_tag("registered_model_version", version)
        mlflow.set_tag("registered_model_alias", "champion")


if __name__ == "__main__":
    main()
