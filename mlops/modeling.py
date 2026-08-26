"""Model and scoring helpers shared by training, batch scoring, and local tests."""

from __future__ import annotations

import numpy as np
import pandas as pd
from mlflow.pyfunc import PythonModel
from sklearn.ensemble import IsolationForest


class IsolationForestScoreModel(IsolationForest):
    """Isolation Forest whose prediction is a continuous anomaly score."""

    def predict(self, features):
        return -self.score_samples(features)


class IsolationForestPyfuncModel(PythonModel):
    """MLflow pyfunc wrapper returning continuous Isolation Forest scores."""

    def __init__(self, model: IsolationForest):
        self.model = model

    def predict(
        self, context, model_input: pd.DataFrame, params=None
    ) -> np.ndarray:
        return -self.model.score_samples(model_input)


def add_composite_scores(
    frame: pd.DataFrame,
    score_column: str = "isolation_forest_score",
    amount_column: str = "amount_at_risk",
) -> pd.DataFrame:
    """Add deterministic z-score, composite score, rank, and review priority."""
    result = frame.copy()
    scores = result[score_column].astype(float)
    score_std = float(scores.std(ddof=0))
    if not np.isfinite(score_std) or score_std == 0.0:
        result["zscore"] = 0.0
    else:
        result["zscore"] = (scores - float(scores.mean())) / score_std

    log_amount = np.log1p(result[amount_column].fillna(0.0).clip(lower=0.0).astype(float))
    amount_std = float(log_amount.std(ddof=0))
    if not np.isfinite(amount_std) or amount_std == 0.0:
        amount_zscore = pd.Series(0.0, index=result.index)
    else:
        amount_zscore = (log_amount - float(log_amount.mean())) / amount_std

    result["composite_anomaly_score"] = (
        0.75 * result["zscore"].clip(lower=0.0)
        + 0.25 * amount_zscore.clip(lower=0.0)
    )
    result["anomaly_rank"] = (
        result["composite_anomaly_score"]
        .rank(method="min", ascending=False)
        .astype("int64")
    )

    row_count = max(len(result), 1)
    rank_fraction = result["anomaly_rank"] / row_count
    result["review_priority"] = np.select(
        [rank_fraction <= 0.05, rank_fraction <= 0.20],
        ["HIGH", "MEDIUM"],
        default="LOW",
    )
    return result
