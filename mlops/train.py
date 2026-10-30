"""Train, track, register, and promote the managed anomaly model.

RA-ML-DROP-ARPU-TIER-WEIGHT-1026 (2026-10-26): Logs fairness metrics and
gates champion promotion on them. Fairness gap = max - min share of rows
flagged HIGH (top 5% by raw IsolationForest score) across groups of
tmf_customer.customer.arpu_tier and .segment_classification. New versions
become champion only if both gaps are within the v64 baseline (0.0164 /
0.0317); otherwise they get the challenger alias and champion is left as is.
"""

from __future__ import annotations

import argparse
import time

import numpy as np
import pandas as pd

import mlflow
import mlflow.pyfunc
from mlflow.models import ModelSignature
from mlflow.tracking import MlflowClient
from mlflow.types.schema import ColSpec, Schema
from pyspark.sql import SparkSession
from sklearn.ensemble import IsolationForest

try:
    from features import FEATURE_COLUMNS, FEATURE_TABLE_NAME
    from modeling import IsolationForestPyfuncModel
    import modeling as _modeling_mod
except ModuleNotFoundError:
    from mlops.features import FEATURE_COLUMNS, FEATURE_TABLE_NAME
    from mlops.modeling import IsolationForestPyfuncModel
    import mlops.modeling as _modeling_mod


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--experiment-name", required=True)
    parser.add_argument("--contamination", type=float, default=0.05)
    # Fairness gates (v64 baseline 0.0164 / 0.0317, rounded up slightly).
    parser.add_argument("--max-arpu-gap", type=float, default=0.0165)
    parser.add_argument("--max-segment-gap", type=float, default=0.0320)
    parser.add_argument("--high-quantile", type=float, default=0.95)
    return parser.parse_args()


FAIRNESS_GROUPS = {"arpu": "arpu_tier", "segment": "segment_classification"}


def fairness_metrics(
    scores: np.ndarray, groups: pd.DataFrame, high_quantile: float
) -> tuple[dict[str, float], dict[str, dict[str, float]]]:
    """Return HIGH-rate gap metrics and per-group HIGH rates."""
    high = (scores >= np.quantile(scores, high_quantile)).astype(float)
    frame = groups.assign(high=high)
    metrics: dict[str, float] = {}
    rates_out: dict[str, dict[str, float]] = {}
    for short, column in FAIRNESS_GROUPS.items():
        rates = frame.dropna(subset=[column]).groupby(column)["high"].mean()
        gap = float(rates.max() - rates.min()) if len(rates) > 1 else 0.0
        metrics[f"fairness_{short}_high_gap"] = gap
        rates_out[column] = {str(k): float(v) for k, v in rates.items()}
        for key, value in rates.items():
            metrics[f"high_rate_{short}_{key}"] = float(value)
    return metrics, rates_out


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

    customer_table = f"`{args.catalog}`.`tmf_customer`.`customer`"
    joined = (
        spark.table(feature_table)
        .join(
            spark.table(customer_table).select(
                "customer_id", *FAIRNESS_GROUPS.values()
            ),
            "customer_id",
            "left",
        )
        .select("known_leakage_flag", *FAIRNESS_GROUPS.values(), *FEATURE_COLUMNS)
        .fillna(0.0, subset=FEATURE_COLUMNS)
        .toPandas()
    )
    training_pandas = joined[FEATURE_COLUMNS].astype(float)
    group_pandas = joined[list(FAIRNESS_GROUPS.values())]
    if len(training_pandas) < 20:
        raise RuntimeError("At least 20 exception rows are required to train IsolationForest")

    model = IsolationForest(
        n_estimators=300,
        contamination=args.contamination,
        max_samples="auto",
        random_state=42,
        n_jobs=-1,
    )

    with mlflow.start_run(run_name="ra_isolation_forest_training") as run:
        model.fit(training_pandas)
        predictions = -model.score_samples(training_pandas)
        signature = ModelSignature(
            inputs=Schema([ColSpec("double", column) for column in FEATURE_COLUMNS]),
            outputs=Schema([ColSpec("double")]),
        )
        if signature.inputs is None or signature.outputs is None:
            raise RuntimeError("Model signature must include both inputs and outputs")

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

        fair_metrics, group_rates = fairness_metrics(
            predictions, group_pandas, args.high_quantile
        )
        mlflow.log_metrics(fair_metrics)
        mlflow.log_dict(group_rates, "fairness_high_rates.json")
        labels = joined["known_leakage_flag"].fillna(0).astype(int)
        if labels.nunique() == 2:
            from sklearn.metrics import roc_auc_score

            mlflow.log_metric("roc_auc_known_leakage", float(roc_auc_score(labels, predictions)))
        fairness_pass = (
            fair_metrics["fairness_arpu_high_gap"] <= args.max_arpu_gap
            and fair_metrics["fairness_segment_high_gap"] <= args.max_segment_gap
        )
        mlflow.log_params(
            {
                "max_arpu_gap": args.max_arpu_gap,
                "max_segment_gap": args.max_segment_gap,
                "high_quantile": args.high_quantile,
            }
        )
        mlflow.set_tag("fairness_gate", "PASS" if fairness_pass else "FAIL")

        mlflow.pyfunc.log_model(
            artifact_path="model",
            python_model=IsolationForestPyfuncModel(model),
            signature=signature,
            input_example=training_pandas.head(5),
            code_paths=[_modeling_mod.__file__],
            registered_model_name=model_name,
        )

        registry_client = MlflowClient(registry_uri="databricks-uc")
        version = registered_version_for_run(registry_client, model_name, run.info.run_id)
        if fairness_pass:
            try:
                current = registry_client.get_model_version_by_alias(model_name, "champion").version
            except Exception:  # no champion yet
                current = None
            if current and current != version:
                registry_client.set_registered_model_alias(model_name, "previous_champion", current)
            registry_client.set_registered_model_alias(model_name, "champion", version)
            alias = "champion"
        else:
            # Fairness gate failed: keep the existing champion, park as challenger.
            registry_client.set_registered_model_alias(model_name, "challenger", version)
            alias = "challenger"
            print(
                f"Fairness gate FAILED for v{version}: {fair_metrics}. "
                "Champion alias unchanged."
            )
        mlflow.set_tag("registered_model_name", model_name)
        mlflow.set_tag("registered_model_version", version)
        mlflow.set_tag("registered_model_alias", alias)


if __name__ == "__main__":
    main()
