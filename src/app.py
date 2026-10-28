from __future__ import annotations

import json
import math
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import pandas as pd
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = PROJECT_ROOT / "models"
WEB_DIR = PROJECT_ROOT / "web"
ASSETS_DIR = PROJECT_ROOT / "assets"

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

DELAY_LABELS = ["On-Time", "Moderate Delay", "Severe Delay"]
WEATHER_LABELS = ["Clear", "Light Rain / Fog", "Heavy Downpour"]
STATUS_COLORS = {"On-Time": "#3fb950", "Moderate Delay": "#d29922", "Severe Delay": "#f85149"}

STOPS = [
    {"stop_id": 0, "name": "Jalandhar Bus Stand", "lat": 31.3156, "lon": 75.5920},
    {"stop_id": 1, "name": "PAP Chowk", "lat": 31.3090, "lon": 75.6195},
    {"stop_id": 2, "name": "Rama Mandi", "lat": 31.3015, "lon": 75.6375},
    {"stop_id": 3, "name": "Haveli Corridor", "lat": 31.2720, "lon": 75.6780},
    {"stop_id": 4, "name": "LPU Main Gate", "lat": 31.2554, "lon": 75.7049},
    {"stop_id": 5, "name": "Phagwara Bus Stand", "lat": 31.2240, "lon": 75.7708},
]

SEGMENTS = [
    {
        "segment_id": 1,
        "name": "Jalandhar BS -> PAP Chowk",
        "start_stop_id": 0,
        "end_stop_id": 1,
        "distance_km": 3.4,
        "scheduled_time_min": 6.5,
    },
    {
        "segment_id": 2,
        "name": "PAP Chowk -> Rama Mandi",
        "start_stop_id": 1,
        "end_stop_id": 2,
        "distance_km": 2.2,
        "scheduled_time_min": 5.0,
    },
    {
        "segment_id": 3,
        "name": "Rama Mandi -> Haveli Corridor",
        "start_stop_id": 2,
        "end_stop_id": 3,
        "distance_km": 5.1,
        "scheduled_time_min": 7.5,
    },
    {
        "segment_id": 4,
        "name": "Haveli Corridor -> LPU Gate",
        "start_stop_id": 3,
        "end_stop_id": 4,
        "distance_km": 3.3,
        "scheduled_time_min": 5.5,
    },
    {
        "segment_id": 5,
        "name": "LPU Gate -> Phagwara BS",
        "start_stop_id": 4,
        "end_stop_id": 5,
        "distance_km": 7.2,
        "scheduled_time_min": 11.0,
    },
]

BUS_ID = "PB08-BUS-101"
ROUTE_NAME = "NH-44 GT Road Corridor"
CORRIDOR_DISTANCE_KM = round(sum(segment["distance_km"] for segment in SEGMENTS), 2)
CORRIDOR_SCHEDULED_MIN = round(sum(segment["scheduled_time_min"] for segment in SEGMENTS), 2)


class SimulationRequest(BaseModel):
    hour_of_day: int = Field(default=13, ge=0, le=23)
    is_weekend: bool = False
    weather_severity: int = Field(default=0, ge=0, le=2)
    rolling_3trip_delay_min: float = Field(default=0.5, ge=0.0, le=15.0)
    prev_stop_dwell_sec: float = Field(default=30.0, ge=15.0, le=120.0)
    gps_speed_kmh: float = Field(default=30.0, ge=2.0, le=95.0)
    day_of_week: int | None = Field(default=None, ge=0, le=6)


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def is_peak(hour_of_day: int) -> bool:
    return 8 <= hour_of_day <= 10 or 17 <= hour_of_day <= 19


def historical_average(segment: dict[str, Any], peak: bool) -> float:
    factor = 1.38 if peak else 1.05
    if peak and segment["segment_id"] in (2, 4):
        factor += 0.25
    return round(segment["scheduled_time_min"] * factor, 2)


def build_segment_record(segment: dict[str, Any]) -> dict[str, Any]:
    start = STOPS[segment["start_stop_id"]]
    end = STOPS[segment["end_stop_id"]]
    return {
        **segment,
        "start_stop": start["name"],
        "end_stop": end["name"],
        "start_lat": start["lat"],
        "start_lon": start["lon"],
        "end_lat": end["lat"],
        "end_lon": end["lon"],
        "scheduled_start_offset_min": 0.0,
        "scheduled_arrival_offset_min": 0.0,
    }


def corridor_payload() -> dict[str, Any]:
    stops = []
    segments = []
    cursor = 0.0
    for stop in STOPS:
        stops.append({**stop, "scheduled_offset_min": round(cursor, 2)})
        if stop["stop_id"] < len(SEGMENTS):
            segment = build_segment_record(SEGMENTS[stop["stop_id"]])
            segment["scheduled_start_offset_min"] = round(cursor, 2)
            cursor += segment["scheduled_time_min"]
            segment["scheduled_arrival_offset_min"] = round(cursor, 2)
            segments.append(segment)
    return {
        "route_name": ROUTE_NAME,
        "bus_id": BUS_ID,
        "distance_km": CORRIDOR_DISTANCE_KM,
        "scheduled_time_min": CORRIDOR_SCHEDULED_MIN,
        "stops": stops,
        "segments": segments,
        "peak_windows": ["08:00-10:00", "17:00-19:00"],
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def load_artifacts() -> dict[str, Any]:
    regressor = joblib.load(MODELS_DIR / "delay_regressor.joblib")
    classifier = joblib.load(MODELS_DIR / "delay_classifier.joblib")
    quantile_lower = joblib.load(MODELS_DIR / "quantile_lower_10.joblib")
    quantile_upper = joblib.load(MODELS_DIR / "quantile_upper_90.joblib")
    metadata = json.loads((MODELS_DIR / "model_metadata.json").read_text(encoding="utf-8"))
    audit = json.loads((MODELS_DIR / "dq_audit_report.json").read_text(encoding="utf-8"))
    return {
        "regressor": regressor,
        "classifier": classifier,
        "quantile_lower": quantile_lower,
        "quantile_upper": quantile_upper,
        "metadata": metadata,
        "audit": audit,
    }


def feature_row(
    segment: dict[str, Any],
    request: SimulationRequest,
    peak: bool,
    rolling_delay: float | None = None,
    dwell: float | None = None,
    weather: int | None = None,
    peak_override: bool | None = None,
) -> dict[str, float]:
    effective_peak = peak if peak_override is None else peak_override
    effective_rolling = request.rolling_3trip_delay_min if rolling_delay is None else rolling_delay
    effective_dwell = request.prev_stop_dwell_sec if dwell is None else dwell
    effective_weather = request.weather_severity if weather is None else weather
    return {
        "hour_of_day": request.hour_of_day,
        "day_of_week": request.day_of_week if request.day_of_week is not None else (6 if request.is_weekend else 2),
        "is_weekend": int(request.is_weekend),
        "is_peak_hour": int(effective_peak),
        "segment_id": segment["segment_id"],
        "segment_distance_km": segment["distance_km"],
        "scheduled_time_min": segment["scheduled_time_min"],
        "historical_segment_avg_min": historical_average(segment, effective_peak),
        "rolling_3trip_delay_min": effective_rolling,
        "prev_stop_dwell_sec": effective_dwell,
        "weather_severity": effective_weather,
        "gps_speed_kmh": request.gps_speed_kmh,
    }


def predict_rows(models: dict[str, Any], rows: list[dict[str, float]]) -> dict[str, list[float]]:
    frame = pd.DataFrame(rows, columns=FEATURES)
    return {
        "regression": [float(value) for value in models["regressor"].predict(frame)],
        "lower": [float(value) for value in models["quantile_lower"].predict(frame)],
        "upper": [float(value) for value in models["quantile_upper"].predict(frame)],
        "classifier": [int(value) for value in models["classifier"].predict(frame)],
        "probabilities": models["classifier"].predict_proba(frame).tolist(),
    }


def confidence_from_width(width: float, peak: bool) -> float:
    confidence = 100.0 - 8.2 * width - (4.0 if peak else 0.0)
    if peak:
        confidence = min(confidence, 69.0)
    return round(clamp(confidence, 35.0, 96.0), 1)


def rider_recommendation(status: str, peak: bool, weather: int, lower: float, upper: float) -> str:
    if status == "Severe Delay":
        return "Allow 15+ extra minutes or board the next service. Live arrival window is widening."
    if status == "Moderate Delay":
        if weather > 0:
            return "Carry buffer time and monitor the live window; wet-weather boarding is slowing the corridor."
        if peak:
            return "Prefer the next departure if connecting; peak demand is extending the arrival window."
        return "Service is running slightly behind schedule. The current arrival window remains usable."
    if weather > 0:
        return "Bus is close to schedule. Keep a small weather buffer for the final approach."
    if peak:
        return "Board now; the bus is tracking within the on-time band despite peak volumes."
    return f"On-time service. Predicted arrival window is {lower:+.1f} to {upper:+.1f} minutes."


def segment_inference(models: dict[str, Any], request: SimulationRequest) -> dict[str, Any]:
    peak = is_peak(request.hour_of_day)
    rows = [feature_row(segment, request, peak) for segment in SEGMENTS]
    predictions = predict_rows(models, rows)

    neutral_rows = [
        feature_row(segment, request, peak, rolling_delay=0.0, dwell=30.0, weather=0, peak_override=False)
        for segment in SEGMENTS
    ]
    neutral_predictions = predict_rows(models, neutral_rows)["regression"]

    lag_rows = [
        feature_row(segment, request, peak, rolling_delay=request.rolling_3trip_delay_min, dwell=30.0, weather=0, peak_override=False)
        for segment in SEGMENTS
    ]
    lag_predictions = predict_rows(models, lag_rows)["regression"]

    peak_rows = [
        feature_row(segment, request, peak, rolling_delay=request.rolling_3trip_delay_min, dwell=30.0, weather=0, peak_override=peak)
        for segment in SEGMENTS
    ]
    peak_predictions = predict_rows(models, peak_rows)["regression"]

    weather_rows = [
        feature_row(
            segment,
            request,
            peak,
            rolling_delay=request.rolling_3trip_delay_min,
            dwell=30.0,
            weather=request.weather_severity,
            peak_override=peak,
        )
        for segment in SEGMENTS
    ]
    weather_predictions = predict_rows(models, weather_rows)["regression"]

    segments_payload = []
    cumulative_delay = 0.0
    cumulative_scheduled = 0.0
    total_confidence_weight = 0.0
    worst_status_index = 0

    for index, segment in enumerate(SEGMENTS):
        predicted = predictions["regression"][index]
        raw_lower = predictions["lower"][index]
        raw_upper = predictions["upper"][index]
        lower = min(raw_lower, predicted)
        upper = max(raw_upper, predicted)
        width = round(max(upper - lower, 0.1), 3)
        confidence = confidence_from_width(width, peak)
        low_confidence = peak or confidence < 70.0
        status_index = predictions["classifier"][index]
        status = DELAY_LABELS[status_index]
        worst_status_index = max(worst_status_index, status_index)
        probability = predictions["probabilities"][index][status_index]
        segment_speed = segment["distance_km"] / max((segment["scheduled_time_min"] + max(predicted, 0.0)) / 60.0, 0.1)
        simulated_speed = round(clamp(0.65 * request.gps_speed_kmh + 0.35 * segment_speed, 5.0, 85.0), 1)

        baseline = neutral_predictions[index]
        lag_delta = lag_predictions[index] - baseline
        peak_delta = peak_predictions[index] - lag_predictions[index]
        weather_delta = weather_predictions[index] - peak_predictions[index]
        dwell_delta = predicted - weather_predictions[index]

        xai_drivers = [
            {
                "key": "rolling_lag",
                "label": "Cascading 3-Trip Lag",
                "minutes": round(lag_delta, 2),
                "direction": "increase" if lag_delta >= 0 else "decrease",
            },
            {
                "key": "peak_hour",
                "label": "Peak Hour Surge",
                "minutes": round(peak_delta, 2),
                "direction": "increase" if peak_delta >= 0 else "decrease",
            },
            {
                "key": "weather",
                "label": "Weather Impact",
                "minutes": round(weather_delta, 2),
                "direction": "increase" if weather_delta >= 0 else "decrease",
            },
            {
                "key": "dwell",
                "label": "Stop Dwell Time",
                "minutes": round(dwell_delta, 2),
                "direction": "increase" if dwell_delta >= 0 else "decrease",
            },
        ]

        cumulative_delay += predicted
        segment_payload = {
            **build_segment_record(segment),
            "predicted_delay_min": round(predicted, 2),
            "lower_bound_min": round(lower, 2),
            "upper_bound_min": round(upper, 2),
            "interval_width_min": width,
            "delay_status": status,
            "status_color": STATUS_COLORS[status],
            "status_probability_pct": round(probability * 100.0, 1),
            "is_peak_hour": peak,
            "confidence_pct": confidence,
            "is_low_confidence": low_confidence,
            "xai_drivers": xai_drivers,
            "xai_baseline_min": round(baseline, 2),
            "simulated_speed_kmh": simulated_speed,
            "estimated_segment_time_min": round(segment["scheduled_time_min"] + max(predicted, 0.0), 2),
            "scheduled_start_offset_min": round(cumulative_scheduled, 2),
            "cumulative_delay_min": round(cumulative_delay, 2),
        }
        cumulative_scheduled += segment["scheduled_time_min"]
        segment_payload["scheduled_arrival_offset_min"] = round(cumulative_scheduled, 2)
        segment_payload["estimated_arrival_offset_min"] = round(cumulative_scheduled + cumulative_delay, 2)
        total_confidence_weight += confidence * segment["scheduled_time_min"]
        segments_payload.append(segment_payload)

    corridor_confidence = round(total_confidence_weight / CORRIDOR_SCHEDULED_MIN, 1)
    total_delay = round(sum(item["predicted_delay_min"] for item in segments_payload), 2)
    overall_status = DELAY_LABELS[worst_status_index]
    low_confidence_count = sum(1 for item in segments_payload if item["is_low_confidence"])

    stops_payload = []
    for stop in STOPS:
        if stop["stop_id"] == 0:
            delay_at_stop = 0.0
            estimated_offset = 0.0
        else:
            segment = segments_payload[stop["stop_id"] - 1]
            delay_at_stop = segment["cumulative_delay_min"]
            estimated_offset = segment["estimated_arrival_offset_min"]
        stops_payload.append(
            {
                **stop,
                "predicted_delay_min": round(delay_at_stop, 2),
                "estimated_arrival_offset_min": round(estimated_offset, 2),
            }
        )

    return {
        "simulation": {
            **request.model_dump(),
            "weather_label": WEATHER_LABELS[request.weather_severity],
            "clock": f"{request.hour_of_day:02d}:00",
        },
        "peak": {
            "is_peak_hour": peak,
            "window": "08:00-10:00 / 17:00-19:00",
            "banner": "PEAK TRAFFIC VOLATILITY - LOWER PREDICTION CONFIDENCE" if peak else None,
            "message": (
                "Peak demand is inflating the 80% prediction interval. Rider guidance now uses the quantile range."
                if peak
                else "Off-peak conditions are stable. Point ETA confidence is high."
            ),
        },
        "segments": segments_payload,
        "stops": stops_payload,
        "corridor": {
            "route_name": ROUTE_NAME,
            "bus_id": BUS_ID,
            "distance_km": CORRIDOR_DISTANCE_KM,
            "scheduled_time_min": CORRIDOR_SCHEDULED_MIN,
            "total_predicted_delay_min": total_delay,
            "estimated_trip_time_min": round(CORRIDOR_SCHEDULED_MIN + total_delay, 2),
            "delay_status": overall_status,
            "status_color": STATUS_COLORS[overall_status],
            "confidence_pct": corridor_confidence,
            "is_low_confidence": peak or corridor_confidence < 70.0,
            "low_confidence_segments": low_confidence_count,
            "rider_recommendation": rider_recommendation(
                overall_status,
                peak,
                request.weather_severity,
                min(item["lower_bound_min"] for item in segments_payload),
                max(item["upper_bound_min"] for item in segments_payload),
            ),
        },
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.models = load_artifacts()
    yield


app = FastAPI(title="TransitPulse AI", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, Any]:
    models = app.state.models
    return {
        "status": "ok",
        "service": "TransitPulse AI",
        "models_loaded": all(
            name in models
            for name in ("regressor", "classifier", "quantile_lower", "quantile_upper", "metadata", "audit")
        ),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/corridor")
def get_corridor() -> dict[str, Any]:
    return corridor_payload()


@app.post("/api/simulate")
def simulate(request: SimulationRequest) -> dict[str, Any]:
    return segment_inference(app.state.models, request)


@app.get("/api/diagnostics")
def diagnostics() -> dict[str, Any]:
    models = app.state.models
    audit = models["audit"]
    metadata = models["metadata"]
    return {
        "model_metadata": metadata,
        "dq_audit_report": audit,
        "artifacts": audit.get("verification", {}).get("artifact_inventory", []),
        "verification": audit.get("verification", {}),
        "plots": [
            {
                "name": "Phase 1 Pipeline Diagnostics",
                "url": "/assets/phase1_pipeline_diagnostics.png",
                "caption": "Data-quality gates, corridor telemetry distributions, and cleaning funnel.",
            }
        ],
        "runtime": {
            "status": "online",
            "backend": "FastAPI",
            "regressor": "RandomForestRegressor",
            "classifier": "RandomForestClassifier",
            "uncertainty": "GradientBoosting quantile regressors (alpha 0.10 / 0.90)",
            "feature_count": len(FEATURES),
            "features": FEATURES,
            "artifacts_passed": bool(audit.get("verification", {}).get("passed")),
            "quality_gates_passed": bool(audit.get("validation", {}).get("passed")),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
    }


if ASSETS_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")
if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="dashboard")
