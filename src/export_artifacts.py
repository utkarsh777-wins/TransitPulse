from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor, RandomForestClassifier, RandomForestRegressor
from sklearn.metrics import accuracy_score, classification_report, f1_score, mean_absolute_error, mean_squared_error, r2_score

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = PROJECT_ROOT / "models"
DATA_DIR = PROJECT_ROOT / "data" / "processed"
RAW_DATA_PATH = PROJECT_ROOT / "data" / "raw" / "phase1_raw_gps_telemetry.csv"
CLEAN_DATA_PATH = DATA_DIR / "phase1_cleaned_transit_dataset.csv"
METADATA_PATH = MODELS_DIR / "model_metadata.json"
AUDIT_PATH = MODELS_DIR / "dq_audit_report.json"

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

ARTIFACTS = {
    "regressor": "delay_regressor.joblib",
    "classifier": "delay_classifier.joblib",
    "quantile_lower": "quantile_lower_10.joblib",
    "quantile_upper": "quantile_upper_90.joblib",
    "metadata": "model_metadata.json",
}

CORRIDOR_LAT_BOUNDS = [31.20, 31.35]
CORRIDOR_LON_BOUNDS = [75.55, 75.80]
SPEED_BOUNDS = [2.0, 95.0]
EXPECTED_COUNTS = {
    "raw_records": 4800,
    "geofence_dropped": 57,
    "speed_dropped": 48,
    "dwell_imputed": 48,
    "clean_records": 4695,
    "retention_rate_pct": 97.81,
}


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_quality_audit() -> dict:
    raw = pd.read_csv(RAW_DATA_PATH)
    clean = pd.read_csv(CLEAN_DATA_PATH)

    mask_bad_gps = (
        (raw["lat"] < CORRIDOR_LAT_BOUNDS[0])
        | (raw["lat"] > CORRIDOR_LAT_BOUNDS[1])
        | (raw["lon"] < CORRIDOR_LON_BOUNDS[0])
        | (raw["lon"] > CORRIDOR_LON_BOUNDS[1])
    )
    mask_bad_speed = (raw["gps_speed_kmh"] < SPEED_BOUNDS[0]) | (raw["gps_speed_kmh"] > SPEED_BOUNDS[1])

    geofence_dropped = int(mask_bad_gps.sum())
    speed_dropped = int(mask_bad_speed.sum())
    dwell_imputed = int(raw["prev_stop_dwell_sec"].isna().sum())
    filtered = raw[~(mask_bad_gps | mask_bad_speed)].copy()
    duplicates_dropped = int(filtered.duplicated(subset=["trip_id", "segment_id"]).sum())
    expected_clean = len(raw) - geofence_dropped - speed_dropped - duplicates_dropped

    if len(clean) != expected_clean:
        raise ValueError(f"Clean dataset row validation failed: expected {expected_clean}, found {len(clean)}")
    if clean[FEATURES].isna().any().any():
        raise ValueError("Clean dataset contains missing model features")
    if int(clean["prev_stop_dwell_sec"].isna().sum()) != 0:
        raise ValueError("Dwell imputation gate did not complete")

    retention = round(len(clean) / len(raw) * 100, 2)
    summary = {
        "raw_records": int(len(raw)),
        "geofence_dropped": geofence_dropped,
        "speed_dropped": speed_dropped,
        "dwell_imputed": dwell_imputed,
        "duplicates_dropped": duplicates_dropped,
        "clean_records": int(len(clean)),
        "retention_rate_pct": retention,
    }

    observed = {
        "raw_records": summary["raw_records"],
        "geofence_dropped": geofence_dropped,
        "speed_dropped": speed_dropped,
        "dwell_imputed": dwell_imputed,
        "clean_records": int(len(clean)),
        "retention_rate_pct": retention,
    }
    mismatches = {
        key: {"expected": EXPECTED_COUNTS[key], "observed": observed[key]}
        for key in EXPECTED_COUNTS
        if observed[key] != EXPECTED_COUNTS[key]
    }

    gates = [
        {
            "id": "geofence",
            "name": "Corridor Geofence Bounding Box",
            "description": "Rejects GPS pings outside the NH-44 corridor bounding box.",
            "input_records": int(len(raw)),
            "dropped_records": geofence_dropped,
            "output_records": int(len(raw) - geofence_dropped),
            "status": "passed",
        },
        {
            "id": "speed",
            "name": "Speed Sanity Filter",
            "description": "Removes telemetry below 2 km/h or above 95 km/h.",
            "input_records": int(len(raw) - geofence_dropped),
            "dropped_records": speed_dropped,
            "output_records": expected_clean,
            "status": "passed",
        },
        {
            "id": "dwell",
            "name": "Missing Dwell Imputation",
            "description": "Median-imputes dwell packets by segment and peak state.",
            "input_records": expected_clean,
            "dropped_records": 0,
            "imputed_records": dwell_imputed,
            "output_records": expected_clean,
            "status": "passed",
        },
        {
            "id": "duplicates",
            "name": "Duplicate Ping Removal",
            "description": "Drops duplicate trip/segment telemetry and sorts timestamps.",
            "input_records": expected_clean,
            "dropped_records": duplicates_dropped,
            "output_records": int(len(clean)),
            "status": "passed",
        },
    ]

    return {
        "dataset": "NH-44 Phase 1 Transit Telemetry",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "corridor_bounds": {"lat": CORRIDOR_LAT_BOUNDS, "lon": CORRIDOR_LON_BOUNDS},
        "valid_speed_bounds_kmh": SPEED_BOUNDS,
        "summary": summary,
        "gates": gates,
        "cleaning_funnel": [
            {"stage": "Raw GPS Telemetry", "records": int(len(raw)), "delta": 0},
            {"stage": "Geofence Filter", "records": int(len(raw) - geofence_dropped), "delta": -geofence_dropped},
            {"stage": "Speed Sanity Filter", "records": expected_clean, "delta": -speed_dropped},
            {"stage": "Dwell Imputation", "records": expected_clean, "delta": 0, "imputed": dwell_imputed},
            {"stage": "Duplicate Removal", "records": int(len(clean)), "delta": -duplicates_dropped},
        ],
        "validation": {
            "expected_counts": EXPECTED_COUNTS,
            "observed_counts": observed,
            "mismatches": mismatches,
            "passed": not mismatches,
            "feature_nulls": int(clean[FEATURES].isna().sum().sum()),
        },
    }


def train_models() -> dict:
    df = pd.read_csv(CLEAN_DATA_PATH)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df = df.sort_values("timestamp").reset_index(drop=True)

    train_mask = df["day_index"] <= 24
    test_mask = df["day_index"] > 24
    X_train = df.loc[train_mask, FEATURES]
    X_test = df.loc[test_mask, FEATURES]
    y_train_reg = df.loc[train_mask, "delay_minutes"]
    y_test_reg = df.loc[test_mask, "delay_minutes"]
    y_train_clf = df.loc[train_mask, "delay_status"]
    y_test_clf = df.loc[test_mask, "delay_status"]

    regressor = RandomForestRegressor(n_estimators=100, max_depth=12, random_state=42, n_jobs=-1)
    regressor.fit(X_train, y_train_reg)

    classifier = RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42, n_jobs=-1)
    classifier.fit(X_train, y_train_clf)

    quantile_lower = GradientBoostingRegressor(loss="quantile", alpha=0.10, random_state=42)
    quantile_upper = GradientBoostingRegressor(loss="quantile", alpha=0.90, random_state=42)
    quantile_lower.fit(X_train, y_train_reg)
    quantile_upper.fit(X_train, y_train_reg)

    y_pred_reg = regressor.predict(X_test)
    y_pred_lower = quantile_lower.predict(X_test)
    y_pred_upper = quantile_upper.predict(X_test)
    y_pred_clf = classifier.predict(X_test)

    naive_pred = X_test["historical_segment_avg_min"] - X_test["scheduled_time_min"]
    baseline_mae = mean_absolute_error(y_test_reg, naive_pred)
    reg_mae = mean_absolute_error(y_test_reg, y_pred_reg)
    reg_rmse = float(np.sqrt(mean_squared_error(y_test_reg, y_pred_reg)))
    reg_r2 = float(r2_score(y_test_reg, y_pred_reg))
    error_reduction = ((baseline_mae - reg_mae) / baseline_mae) * 100

    test_df = X_test.copy()
    test_df["actual_delay"] = y_test_reg
    test_df["predicted_delay"] = y_pred_reg
    test_df["uncertainty_spread"] = y_pred_upper - y_pred_lower
    uncertainty_summary = test_df.groupby("is_peak_hour")[["uncertainty_spread"]].mean()

    importances = pd.Series(regressor.feature_importances_, index=FEATURES).sort_values(ascending=False)
    metadata = {
        "metrics": {
            "reg_mae": round(float(reg_mae), 3),
            "reg_rmse": round(reg_rmse, 3),
            "reg_r2": round(reg_r2, 3),
            "baseline_mae": round(float(baseline_mae), 3),
            "error_reduction_pct": round(float(error_reduction), 2),
            "clf_accuracy": round(float(accuracy_score(y_test_clf, y_pred_clf)), 3),
            "clf_macro_f1": round(float(f1_score(y_test_clf, y_pred_clf, average="macro")), 3),
        },
        "uncertainty": {
            "off_peak_interval_width": round(float(uncertainty_summary.loc[0, "uncertainty_spread"]), 3),
            "peak_hour_interval_width": round(float(uncertainty_summary.loc[1, "uncertainty_spread"]), 3),
        },
        "feature_importances": {key: float(value) for key, value in importances.to_dict().items()},
        "training_window": {"train_days": "1-24", "test_days": "25-30", "features": FEATURES},
        "classification_report": classification_report(
            y_test_clf,
            y_pred_clf,
            target_names=["On-Time", "Moderate Delay", "Severe Delay"],
            output_dict=True,
            zero_division=0,
        ),
    }

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(regressor, MODELS_DIR / ARTIFACTS["regressor"])
    joblib.dump(classifier, MODELS_DIR / ARTIFACTS["classifier"])
    joblib.dump(quantile_lower, MODELS_DIR / ARTIFACTS["quantile_lower"])
    joblib.dump(quantile_upper, MODELS_DIR / ARTIFACTS["quantile_upper"])
    METADATA_PATH.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


def ensure_artifacts() -> dict:
    missing = [filename for filename in ARTIFACTS.values() if not (MODELS_DIR / filename).is_file()]
    if missing:
        print(f"Missing artifacts detected: {', '.join(missing)}. Training the full model suite.")
        train_models()
    return json.loads(METADATA_PATH.read_text(encoding="utf-8"))


def verify_artifacts(metadata: dict, clean: pd.DataFrame) -> dict:
    regressor = joblib.load(MODELS_DIR / ARTIFACTS["regressor"])
    classifier = joblib.load(MODELS_DIR / ARTIFACTS["classifier"])
    quantile_lower = joblib.load(MODELS_DIR / ARTIFACTS["quantile_lower"])
    quantile_upper = joblib.load(MODELS_DIR / ARTIFACTS["quantile_upper"])

    expected_classes = np.array([0, 1, 2])
    feature_checks = {
        "regressor": list(regressor.feature_names_in_) == FEATURES,
        "classifier": list(classifier.feature_names_in_) == FEATURES,
        "quantile_lower": list(quantile_lower.feature_names_in_) == FEATURES,
        "quantile_upper": list(quantile_upper.feature_names_in_) == FEATURES,
    }
    if not all(feature_checks.values()):
        raise ValueError(f"Feature schema mismatch: {feature_checks}")
    if not np.array_equal(classifier.classes_, expected_classes):
        raise ValueError(f"Classifier class mismatch: {classifier.classes_}")

    sample = clean.iloc[[0]][FEATURES]
    prediction = float(regressor.predict(sample)[0])
    lower = float(quantile_lower.predict(sample)[0])
    upper = float(quantile_upper.predict(sample)[0])
    status = int(classifier.predict(sample)[0])
    if not all(np.isfinite([prediction, lower, upper])):
        raise ValueError("Model inference returned a non-finite value")

    inventory = []
    for name, filename in ARTIFACTS.items():
        path = MODELS_DIR / filename
        inventory.append(
            {
                "name": name,
                "file": filename,
                "size_bytes": path.stat().st_size,
                "sha256": file_sha256(path),
                "exists": True,
            }
        )

    return {
        "passed": True,
        "feature_schema": FEATURES,
        "feature_checks": feature_checks,
        "classifier_classes": [int(value) for value in classifier.classes_],
        "classifier_accuracy": metadata["metrics"]["clf_accuracy"],
        "smoke_test": {
            "predicted_delay_min": round(prediction, 4),
            "lower_bound_min": round(lower, 4),
            "upper_bound_min": round(upper, 4),
            "delay_status": ["On-Time", "Moderate Delay", "Severe Delay"][status],
        },
        "artifact_inventory": inventory,
    }


def main() -> int:
    if not RAW_DATA_PATH.is_file():
        raise FileNotFoundError(f"Raw dataset missing at {RAW_DATA_PATH}")
    if not CLEAN_DATA_PATH.is_file():
        raise FileNotFoundError(f"Clean dataset missing at {CLEAN_DATA_PATH}")

    audit = build_quality_audit()
    metadata = ensure_artifacts()
    clean = pd.read_csv(CLEAN_DATA_PATH)
    audit["verification"] = verify_artifacts(metadata, clean)
    audit["model_metrics"] = metadata["metrics"]
    audit["uncertainty"] = metadata["uncertainty"]

    audit["passed"] = bool(audit["validation"]["passed"] and audit["verification"]["passed"])
    AUDIT_PATH.write_text(json.dumps(audit, indent=2), encoding="utf-8")

    summary = audit["summary"]
    print("TransitPulse AI artifact freeze complete")
    print(f"Raw rows: {summary['raw_records']}")
    print(f"Geofence dropped: {summary['geofence_dropped']}")
    print(f"Speed glitches dropped: {summary['speed_dropped']}")
    print(f"Dwell packets imputed: {summary['dwell_imputed']}")
    print(f"Clean rows: {summary['clean_records']} ({summary['retention_rate_pct']}% retention)")
    print(f"Artifacts verified: {len(audit['verification']['artifact_inventory'])}")
    print(f"Audit report: {AUDIT_PATH}")
    return 0 if audit["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
