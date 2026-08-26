"""Local sanity checks for deterministic anomaly scoring helpers."""

from __future__ import annotations

import numpy as np
import pandas as pd

from mlops.modeling import IsolationForestScoreModel, add_composite_scores


def main() -> None:
    random = np.random.default_rng(42)
    normal = random.normal(0.0, 1.0, size=(200, 3))
    outliers = np.array([[9.0, 9.0, 9.0], [-9.0, -8.0, -10.0]])
    features = np.vstack([normal, outliers])

    model = IsolationForestScoreModel(
        n_estimators=100,
        contamination=0.02,
        random_state=42,
    ).fit(features)
    scores = model.predict(features)
    frame = add_composite_scores(
        pd.DataFrame(
            {
                "isolation_forest_score": scores,
                "amount_at_risk": np.concatenate([np.full(200, 100.0), [10000.0, 12000.0]]),
            }
        )
    )

    assert set(frame["review_priority"]) == {"HIGH", "MEDIUM", "LOW"}
    assert frame.iloc[-2:]["isolation_forest_score"].min() > np.quantile(scores, 0.90)
    assert frame.iloc[-2:]["anomaly_rank"].max() <= 2


if __name__ == "__main__":
    main()
