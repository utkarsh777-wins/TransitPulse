"""Import the app, load the frozen models, and hit the public API."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from src.app import app, server_host, server_port

ROOT = Path(__file__).resolve().parents[1]
SIMULATION = {
    "hour_of_day": 8,
    "is_weekend": False,
    "weather_severity": 1,
    "rolling_3trip_delay_min": 6.5,
    "prev_stop_dwell_sec": 85,
    "gps_speed_kmh": 20,
}


def test_server_bind_reads_host_and_port(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOST", "127.0.0.1")
    monkeypatch.setenv("PORT", "8123")
    assert server_host() == "127.0.0.1"
    assert server_port() == 8123


def test_server_bind_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HOST", raising=False)
    monkeypatch.delenv("PORT", raising=False)
    assert server_host() == "0.0.0.0"
    assert server_port() == 8000


def test_server_port_rejects_garbage(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PORT", "not-a-port")
    with pytest.raises(RuntimeError):
        server_port()


def test_health_and_simulate_use_frozen_models() -> None:
    artifact_times = {path: path.stat().st_mtime_ns for path in (ROOT / "models").glob("*.joblib")}
    assert artifact_times, "committed joblib artifacts are required at startup"

    with TestClient(app) as client:
        health = client.get("/api/health")
        assert health.status_code == 200
        body = health.json()
        assert body["status"] == "ok"
        assert body["service"] == "TransitPulse AI"
        assert body["models_loaded"] is True

        corridor = client.get("/api/corridor")
        assert corridor.status_code == 200
        corridor_body = corridor.json()
        assert len(corridor_body["stops"]) == 6
        assert len(corridor_body["segments"]) == 5
        assert corridor_body["peak_windows"] == ["08:00-10:00", "17:00-19:00"]

        diagnostics = client.get("/api/diagnostics")
        assert diagnostics.status_code == 200
        diag = diagnostics.json()
        assert diag["runtime"]["artifacts_passed"] is True
        assert diag["verification"]["passed"] is True
        assert len(diag["artifacts"]) >= 4

        simulated = client.post("/api/simulate", json=SIMULATION)
        assert simulated.status_code == 200
        payload = simulated.json()
        assert payload["peak"]["is_peak_hour"] is True
        assert len(payload["segments"]) == 5
        segment = payload["segments"][0]
        assert "predicted_delay_min" in segment
        assert segment["delay_status"] in {"On-Time", "Moderate Delay", "Severe Delay"}
        assert "xai_drivers" in segment

        page = client.get("/")
        assert page.status_code == 200
        assert "TransitPulse" in page.text

    assert {path: path.stat().st_mtime_ns for path in artifact_times} == artifact_times


def test_frontend_api_urls_are_relative() -> None:
    script = (ROOT / "web" / "app.js").read_text(encoding="utf-8")
    assert "localhost" not in script
    assert "127.0.0.1" not in script
    for path in ("/api/corridor", "/api/simulate", "/api/diagnostics"):
        assert path in script
    assert "API calls must be relative" in script


def test_standin_fallback_is_labeled() -> None:
    page = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    script = (ROOT / "web" / "app.js").read_text(encoding="utf-8")
    assert "Stand-in fallback" in page
    assert "not the trained model" in page
    assert "Stand-in fallback" in script
    assert "not the trained model" in script


def test_runtime_requirements_are_pinned_and_lean() -> None:
    requirements = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    assert "seaborn" not in requirements.lower()
    pinned = [
        line.strip()
        for line in requirements.splitlines()
        if line.strip() and not line.strip().startswith("#") and not line.strip().startswith("-r ")
    ]
    assert pinned
    assert all("==" in line for line in pinned)
    notebooks = (ROOT / "requirements-notebooks.txt").read_text(encoding="utf-8")
    assert "seaborn==" in notebooks


def test_render_blueprint() -> None:
    blueprint = (ROOT / "render.yaml").read_text(encoding="utf-8")
    assert "runtime: python" in blueprint
    assert "plan: free" in blueprint
    assert "buildCommand: pip install -r requirements.txt" in blueprint
    assert "startCommand: uvicorn src.app:app --host 0.0.0.0 --port $PORT" in blueprint
    assert "healthCheckPath: /api/health" in blueprint
    assert 'value: "3.11.18"' in blueprint
    assert "key: PORT" not in blueprint
    assert (ROOT / ".python-version").read_text(encoding="utf-8").strip() == "3.11.18"
