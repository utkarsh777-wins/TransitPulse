"""Retrain the delay regressor without gps_speed_kmh and measure interval coverage.

Same rows, split, and seed as src/export_artifacts.py. Writes:

- models/ablation.json
- models/model_metadata.json key interval_coverage
- the model_metadata.json size and SHA-256 inside models/dq_audit_report.json

Does not replace the shipped regressor. The service does not run this on boot.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.peak import is_peak

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, r2_score

MODELS_DIR = PROJECT_ROOT / "models"
CLEAN_DATA_PATH = PROJECT_ROOT / "data" / "processed" / "phase1_cleaned_transit_dataset.csv"
METADATA_PATH = MODELS_DIR / "model_metadata.json"
AUDIT_PATH = MODELS_DIR / "dq_audit_report.json"
ABLATION_PATH = MODELS_DIR / "ablation.json"

FEATURES = [
    "hour_of_day",
    "day_of_week",
    "is_weekend",
    "is_peak_hour",
    "segment_id",
    "segment_distance_km",
    "scheduled_time_min",
    "historical_segment_avg_min",
    "rolling_3trip_delay_min",
    "prev_stop_dwell_sec",
    "weather_severity",
    "gps_speed_kmh",
]
DROPPED_FEATURE = "gps_speed_kmh"
SEED = 42


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_split() -> tuple[pd.DataFrame, pd.DataFrame]:
    frame = pd.read_csv(CLEAN_DATA_PATH)
    frame["timestamp"] = pd.to_datetime(frame["timestamp"])
    frame = frame.sort_values("timestamp").reset_index(drop=True)
    train = frame.loc[frame["day_index"] <= 24].copy()
    test = frame.loc[frame["day_index"] > 24].copy()
    if train.empty or test.empty:
        raise RuntimeError("Time split produced an empty train or test window")
    return train, test


def published_interval(point: np.ndarray, raw_lower: np.ndarray, raw_upper: np.ndarray, peak: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Match src/app.py: centre on the rounded point delay, floor the lower bound, round to 0.1."""
    point_delay = np.round(point.astype(float), 2)
    half_spread = np.maximum(0.6, (raw_upper - raw_lower) / 2.0) * np.where(peak == 1, 1.35, 1.0)
    lower = np.round(np.maximum(-1.0, point_delay - half_spread), 1)
    upper = np.round(point_delay + half_spread, 1)
    return lower, upper


def coverage_block(actual: np.ndarray, lower: np.ndarray, upper: np.ndarray) -> float | None:
    if len(actual) == 0:
        return None
    inside = (actual >= lower) & (actual <= upper)
    return round(float(inside.mean()), 4)


def measure_coverage(test: pd.DataFrame) -> dict:
    import joblib

    regressor = joblib.load(MODELS_DIR / "delay_regressor.joblib")
    lower_model = joblib.load(MODELS_DIR / "quantile_lower_10.joblib")
    upper_model = joblib.load(MODELS_DIR / "quantile_upper_90.joblib")
    features = test[FEATURES]
    point = regressor.predict(features)
    raw_lower = lower_model.predict(features)
    raw_upper = upper_model.predict(features)
    peak = np.fromiter(
        (
            is_peak(int(hour), is_weekend=bool(weekend))
            for hour, weekend in zip(test["hour_of_day"].to_numpy(), test["is_weekend"].to_numpy(), strict=True)
        ),
        dtype=int,
        count=len(test),
    )
    lower, upper = published_interval(point, raw_lower, raw_upper, peak)
    actual = test["delay_minutes"].to_numpy(dtype=float)
    peak_mask = peak == 1
    return {
        "test_days": "25-30",
        "n_test": int(len(test)),
        "n_peak": int(peak_mask.sum()),
        "n_off_peak": int((~peak_mask).sum()),
        "overall": coverage_block(actual, lower, upper),
        "peak": coverage_block(actual[peak_mask], lower[peak_mask], upper[peak_mask]),
        "off_peak": coverage_block(actual[~peak_mask], lower[~peak_mask], upper[~peak_mask]),
        "definition": (
            "Share of held-out rows whose actual delay falls inside the published interval: "
            "centred on the point prediction, half-width max(0.6, (q90-q10)/2) times 1.35 at peak, "
            "lower bound floored at -1.0, then rounded to 0.1 min."
        ),
    }


def train_ablation(train: pd.DataFrame, test: pd.DataFrame, full_metrics: dict) -> dict:
    features = [name for name in FEATURES if name != DROPPED_FEATURE]
    regressor = RandomForestRegressor(n_estimators=100, max_depth=12, random_state=SEED, n_jobs=-1)
    regressor.fit(train[features], train["delay_minutes"])
    predicted = regressor.predict(test[features])
    actual = test["delay_minutes"]
    return {
        "dropped_feature": DROPPED_FEATURE,
        "seed": SEED,
        "split": {"train_days": "1-24", "test_days": "25-30"},
        "estimator": "RandomForestRegressor",
        "hyperparameters": {"n_estimators": 100, "max_depth": 12, "random_state": SEED},
        "features": features,
        "n_train": int(len(train)),
        "n_test": int(len(test)),
        "metrics": {
            "reg_mae": round(float(mean_absolute_error(actual, predicted)), 3),
            "reg_r2": round(float(r2_score(actual, predicted)), 3),
        },
        "full_model_metrics_ref": {
            "reg_mae": full_metrics.get("reg_mae"),
            "reg_r2": full_metrics.get("reg_r2"),
        },
        "data": {
            "source": "notebooks/01_phase1_data_pipeline.ipynb",
            "seed": SEED,
            "synthetic": True,
        },
        "note": (
            "Same split and seed as the shipped regressor, with gps_speed_kmh removed. "
            "gps_speed_kmh can leak the target because a slower ping is partly the delay itself. "
            "Scores are on synthetic held-out days, not real-world accuracy."
        ),
    }


def refresh_metadata_hash(audit: dict) -> None:
    path = METADATA_PATH
    inventory = audit.get("verification", {}).get("artifact_inventory", [])
    for item in inventory:
        if item.get("file") == "model_metadata.json":
            item["size_bytes"] = path.stat().st_size
            item["sha256"] = file_sha256(path)


def main() -> int:
    if not CLEAN_DATA_PATH.is_file():
        raise FileNotFoundError(CLEAN_DATA_PATH)
    train, test = load_split()
    metadata = json.loads(METADATA_PATH.read_text(encoding="utf-8"))
    ablation = train_ablation(train, test, metadata.get("metrics", {}))
    coverage = measure_coverage(test)

    ABLATION_PATH.write_text(json.dumps(ablation, indent=2) + "\n", encoding="utf-8")

    metadata["interval_coverage"] = coverage
    METADATA_PATH.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

    if AUDIT_PATH.is_file():
        audit = json.loads(AUDIT_PATH.read_text(encoding="utf-8"))
        refresh_metadata_hash(audit)
        AUDIT_PATH.write_text(json.dumps(audit, indent=2) + "\n", encoding="utf-8")

    print(
        f"ablation MAE {ablation['metrics']['reg_mae']}  R2 {ablation['metrics']['reg_r2']}  "
        f"coverage overall {coverage['overall']} peak {coverage['peak']} off-peak {coverage['off_peak']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
