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
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
    mean_absolute_error,
    mean_squared_error,
    r2_score,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = PROJECT_ROOT / "models"
DATA_DIR = PROJECT_ROOT / "data" / "processed"
ASSETS_DIR = PROJECT_ROOT / "assets"
RAW_DATA_PATH = PROJECT_ROOT / "data" / "raw" / "phase1_raw_gps_telemetry.csv"
CLEAN_DATA_PATH = DATA_DIR / "phase1_cleaned_transit_dataset.csv"
METADATA_PATH = MODELS_DIR / "model_metadata.json"
AUDIT_PATH = MODELS_DIR / "dq_audit_report.json"
PHASE2_PLOT_PATH = ASSETS_DIR / "phase2_model_evaluation.png"

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


def build_phase2_plot(metadata: dict) -> Path:
    """Render held-out tracking, confusion matrix, and XAI evidence for Objective 2."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import LinearSegmentedColormap

    df = pd.read_csv(CLEAN_DATA_PATH)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df = df.sort_values("timestamp").reset_index(drop=True)
    test = df[df["day_index"] > 24].copy()
    X_test = test[FEATURES]
    y_true_reg = test["delay_minutes"].to_numpy(dtype=float)
    y_true_clf = test["delay_status"].to_numpy(dtype=int)

    regressor = joblib.load(MODELS_DIR / ARTIFACTS["regressor"])
    classifier = joblib.load(MODELS_DIR / ARTIFACTS["classifier"])
    quantile_lower = joblib.load(MODELS_DIR / ARTIFACTS["quantile_lower"])
    quantile_upper = joblib.load(MODELS_DIR / ARTIFACTS["quantile_upper"])

    y_pred = regressor.predict(X_test)
    y_pred_clf = classifier.predict(X_test)
    raw_lower = quantile_lower.predict(X_test)
    raw_upper = quantile_upper.predict(X_test)

    # Mirror the public interval rule: centered on the point forecast, widened
    # by 35% during peak hours, and floored at -1.0 minutes.
    peak = test["is_peak_hour"].to_numpy(dtype=int)
    half_spread = np.maximum(0.6, (raw_upper - raw_lower) / 2.0) * np.where(peak == 1, 1.35, 1.0)
    band_low = np.maximum(-1.0, y_pred - half_spread)
    band_high = y_pred + half_spread

    test["actual"] = y_true_reg
    test["predicted"] = y_pred
    test["band_low"] = band_low
    test["band_high"] = band_high
    trip = (
        test.groupby("trip_id", as_index=False)
        .agg(
            timestamp=("timestamp", "min"),
            actual=("actual", "mean"),
            predicted=("predicted", "mean"),
            band_low=("band_low", "mean"),
            band_high=("band_high", "mean"),
        )
        .sort_values("timestamp")
        .reset_index(drop=True)
    )

    plt.style.use("dark_background")
    fig, axes = plt.subplots(1, 3, figsize=(16.5, 5.15))
    fig.patch.set_facecolor("#0d1117")
    for ax in axes:
        ax.set_facecolor("#161b22")
        ax.tick_params(colors="#c9d1d9", labelsize=8.5)
        ax.grid(color="#30363d", alpha=0.45, linewidth=0.7)
        for spine in ax.spines.values():
            spine.set_color("#30363d")
    fig.suptitle(
        "TransitPulse AI · Phase 2 Model Evaluation — Held-Out Future Window (Days 25–30)",
        color="#e6edf3",
        fontsize=14.5,
        fontweight="bold",
        y=0.995,
    )

    # Panel 1: time-series tracking of actual vs predicted trip-level delay.
    x = np.arange(len(trip))
    axes[0].fill_between(
        x,
        trip["band_low"].to_numpy(),
        trip["band_high"].to_numpy(),
        color="#d29922",
        alpha=0.2,
        linewidth=0,
        label="80% quantile interval",
    )
    axes[0].plot(x, trip["actual"].to_numpy(), color="#3fb950", linewidth=1.6, label="Actual delay")
    axes[0].plot(x, trip["predicted"].to_numpy(), color="#58a6ff", linewidth=1.6, label="Predicted delay")
    axes[0].axhline(2.0, color="#d29922", linewidth=0.9, linestyle="--", alpha=0.7)
    axes[0].axhline(6.0, color="#f85149", linewidth=0.9, linestyle="--", alpha=0.7)
    axes[0].set_title("Time-Series Tracking · Trip-Level Delay", color="#e6edf3", fontsize=11, fontweight="bold", pad=9)
    axes[0].set_xlabel("Held-out trips (chronological)", color="#8b949e", fontsize=9)
    axes[0].set_ylabel("Mean segment delay (min)", color="#8b949e", fontsize=9)
    axes[0].legend(
        loc="upper left",
        frameon=True,
        facecolor="#0d1117",
        edgecolor="#30363d",
        fontsize=8,
        labelcolor="#c9d1d9",
    )

    dates = trip["timestamp"].dt.date
    day_changes = [0] + [i for i in range(1, len(trip)) if dates.iloc[i] != dates.iloc[i - 1]]
    tick_positions = day_changes[:: max(1, len(day_changes) // 6)][:6]
    axes[0].set_xticks(tick_positions)
    axes[0].set_xticklabels([dates.iloc[position].strftime("%b %d") for position in tick_positions])

    metrics = metadata.get("metrics", {})
    axes[0].text(
        0.98,
        0.97,
        (
            f"MAE {float(metrics.get('reg_mae', 0.0)):.3f} min · R² {float(metrics.get('reg_r2', 0.0)):.3f}\n"
            f"Naive MAE {float(metrics.get('baseline_mae', 0.0)):.3f} min · Error ↓ {float(metrics.get('error_reduction_pct', 0.0)):.1f}%"
        ),
        transform=axes[0].transAxes,
        ha="right",
        va="top",
        fontsize=8,
        color="#c9d1d9",
        bbox={"boxstyle": "round,pad=0.35", "facecolor": "#0d1117", "edgecolor": "#30363d", "alpha": 0.9},
    )

    # Panel 2: held-out confusion matrix with row-normalized percentages.
    labels = ["On-Time", "Moderate", "Severe"]
    matrix = confusion_matrix(y_true_clf, y_pred_clf, labels=[0, 1, 2])
    normalized = matrix / np.maximum(matrix.sum(axis=1, keepdims=True), 1) * 100.0
    cmap = LinearSegmentedColormap.from_list("transitpulse_blue", ["#0d1117", "#1f6feb", "#79c0ff"])
    axes[1].imshow(normalized, cmap=cmap, vmin=0, vmax=100)
    axes[1].grid(False)
    for row in range(matrix.shape[0]):
        for column in range(matrix.shape[1]):
            color = "#0f172a" if normalized[row, column] > 62 else "#e6edf3"
            axes[1].text(
                column,
                row,
                f"{matrix[row, column]}\n{normalized[row, column]:.0f}%",
                ha="center",
                va="center",
                color=color,
                fontsize=9,
                fontweight="bold",
            )
    axes[1].set_xticks(range(3))
    axes[1].set_yticks(range(3))
    axes[1].set_xticklabels(labels, fontsize=8.5)
    axes[1].set_yticklabels(labels, fontsize=8.5)
    axes[1].set_xlabel("Predicted class", color="#8b949e", fontsize=9)
    axes[1].set_ylabel("Actual class", color="#8b949e", fontsize=9)
    axes[1].set_title(
        (
            "Confusion Matrix · "
            f"Accuracy {float(metrics.get('clf_accuracy', 0.0)) * 100:.1f}% · "
            f"Macro F1 {float(metrics.get('clf_macro_f1', 0.0)) * 100:.1f}%"
        ),
        color="#e6edf3",
        fontsize=11,
        fontweight="bold",
        pad=9,
    )

    # Panel 3: global feature attribution backing the XAI panel.
    importances = pd.Series(regressor.feature_importances_, index=FEATURES).sort_values().tail(8)
    colors = plt.cm.cool(np.linspace(0.35, 0.85, len(importances)))
    axes[2].barh(importances.index, importances.to_numpy(), color=colors, height=0.62)
    axes[2].set_title("XAI · Global Feature Importance", color="#e6edf3", fontsize=11, fontweight="bold", pad=9)
    axes[2].set_xlabel("Relative importance", color="#8b949e", fontsize=9)
    axes[2].tick_params(axis="y", labelsize=8.5)
    for position, value in enumerate(importances.to_numpy()):
        axes[2].text(value + 0.006, position, f"{value * 100:.1f}%", va="center", color="#c9d1d9", fontsize=8)
    axes[2].set_xlim(0, max(float(importances.max()) * 1.18, 0.1))

    fig.text(
        0.5,
        0.012,
        "Frozen scikit-learn artifacts · time-respecting split (Days 1–24 train / Days 25–30 test) · no future leakage",
        ha="center",
        color="#8b949e",
        fontsize=8,
    )
    fig.tight_layout(rect=(0, 0.03, 1, 0.94))

    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    fig.savefig(PHASE2_PLOT_PATH, dpi=150, facecolor="#0d1117", bbox_inches="tight")
    plt.close(fig)
    return PHASE2_PLOT_PATH


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

    phase2_plot = build_phase2_plot(metadata)

    summary = audit["summary"]
    print("TransitPulse AI artifact freeze complete")
    print(f"Raw rows: {summary['raw_records']}")
    print(f"Geofence dropped: {summary['geofence_dropped']}")
    print(f"Speed glitches dropped: {summary['speed_dropped']}")
    print(f"Dwell packets imputed: {summary['dwell_imputed']}")
    print(f"Clean rows: {summary['clean_records']} ({summary['retention_rate_pct']}% retention)")
    print(f"Artifacts verified: {len(audit['verification']['artifact_inventory'])}")
    print(f"Audit report: {AUDIT_PATH}")
    print(f"Phase 2 evaluation plot: {phase2_plot}")
    return 0 if audit["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
