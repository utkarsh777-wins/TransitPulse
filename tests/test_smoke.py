"""Import the app, load the frozen models, and hit the public API."""

from __future__ import annotations

import json
import subprocess
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
        assert "Not a live GPS feed" in page.text
        assert "Evaluator evidence" in page.text
        assert "Arrival windows" not in page.text

        demo = client.get("/demo")
        assert demo.status_code == 200
        assert 'id="map"' in demo.text
        assert "PROTOTYPE ONLY" not in demo.text
        assert 'id="walk-slider"' in demo.text
        assert 'id="recommendation"' in demo.text
        assert 'id="eta-leave"' not in demo.text
        assert "Why this stop is late" not in demo.text
        assert "Live status" not in demo.text
        assert "Morning rush and rain" in demo.text
        assert "Midday Clear" not in demo.text

        for path, needle in (
            ("/how-it-works", "From a GPS ping"),
            ("/model", "synthetic GPS"),
            ("/about", "Utkarsh Kumar"),
        ):
            response = client.get(path)
            assert response.status_code == 200, path
            assert needle in response.text

        evidence = client.get("/api/evidence")
        assert evidence.status_code == 200
        evidence_body = evidence.json()
        coverage = evidence_body["interval_coverage"]
        assert coverage is not None
        assert 0.0 <= coverage["overall"] <= 1.0
        ablation = evidence_body["ablation"]["metrics"]
        assert ablation["reg_mae"] > 0
        assert "reg_r2" in ablation

        default_sim = client.post("/api/simulate", json=SIMULATION)
        assert default_sim.status_code == 200
        default_segment = default_sim.json()["segments"][0]
        assert default_sim.json()["simulation"]["walk_time_min"] == 5.0
        assert default_segment["leave_by_min"] == pytest.approx(
            default_segment["window_start_min"] - 5.0, abs=0.05
        )

        custom = client.post("/api/simulate", json={**SIMULATION, "walk_time_min": 12})
        custom_segment = custom.json()["segments"][0]
        assert custom_segment["window_start_min"] == default_segment["window_start_min"]
        assert custom_segment["leave_by_min"] == pytest.approx(custom_segment["window_start_min"] - 12.0, abs=0.05)

        later = default_sim.json()["segments"][-1]
        assert later["segment_id"] == 5
        cumulative_arrival = later["scheduled_arrival_offset_min"] + later["cumulative_delay_min"]
        assert later["window_start_min"] == pytest.approx(round(cumulative_arrival, 1), abs=0.05)
        assert later["leave_by_min"] == pytest.approx(later["window_start_min"] - 5.0, abs=0.05)
        assert later["window_start_min"] > later["scheduled_time_min"] + 20

        zero = client.post("/api/simulate", json={**SIMULATION, "walk_time_min": 0})
        assert zero.status_code == 200
        zero_segment = zero.json()["segments"][-1]
        assert zero_segment["leave_by_min"] == pytest.approx(zero_segment["window_start_min"], abs=0.05)

        assert client.post("/api/simulate", json={**SIMULATION, "walk_time_min": -1}).status_code == 422
        assert client.post("/api/simulate", json={**SIMULATION, "walk_time_min": 30.1}).status_code == 422
        assert client.post("/api/simulate", json={**SIMULATION, "walk_time_min": "x"}).status_code == 422

        omitted = {key: value for key, value in SIMULATION.items() if key != "walk_time_min"}
        default_walk = client.post("/api/simulate", json=omitted)
        assert default_walk.status_code == 200
        assert default_walk.json()["simulation"]["walk_time_min"] == 5.0

    assert {path: path.stat().st_mtime_ns for path in artifact_times} == artifact_times


def test_unknown_api_path_returns_json_not_found() -> None:
    with TestClient(app) as client:
        response = client.get("/api/nope")
        assert response.status_code == 404
        assert response.headers["content-type"].startswith("application/json")
        assert response.json() == {"detail": "Not Found"}
        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.json()["service"] == "TransitPulse AI"


def test_unknown_path_returns_the_not_found_page() -> None:
    with TestClient(app) as client:
        response = client.get("/not-on-this-route")
        assert response.status_code == 404
        assert "Page not found" in response.text
        assert "This stop" in response.text
        assert 'href="/vendor/fonts/fonts.css"' in response.text


def test_scenario_presets_change_the_delay() -> None:
    midday = {
        "hour_of_day": 13,
        "is_weekend": False,
        "weather_severity": 0,
        "rolling_3trip_delay_min": 0.5,
        "prev_stop_dwell_sec": 30,
        "gps_speed_kmh": 34,
        "walk_time_min": 5,
    }
    severe = {
        "hour_of_day": 18,
        "is_weekend": False,
        "weather_severity": 0,
        "rolling_3trip_delay_min": 14,
        "prev_stop_dwell_sec": 115,
        "gps_speed_kmh": 10,
        "walk_time_min": 8,
    }
    with TestClient(app) as client:
        calm = client.post("/api/simulate", json=midday)
        crowded = client.post("/api/simulate", json=severe)
        assert calm.status_code == 200
        assert crowded.status_code == 200
        calm_delay = calm.json()["corridor"]["total_predicted_delay_min"]
        crowded_delay = crowded.json()["corridor"]["total_predicted_delay_min"]
        assert crowded_delay > calm_delay
        assert calm.json()["peak"]["is_peak_hour"] is False
        assert crowded.json()["peak"]["is_peak_hour"] is True


def test_evidence_hashes_match_committed_files() -> None:
    import hashlib

    with TestClient(app) as client:
        body = client.get("/api/evidence").json()
        matched = 0
        for item in body["artifacts"]:
            path = ROOT / "models" / item["file"]
            if not path.is_file():
                continue
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            assert digest == item["sha256"], item["file"]
            matched += 1
        assert matched >= 4
        assert body["ablation"]["dropped_feature"] == "gps_speed_kmh"
        assert body["metrics"]["reg_mae"] == 0.627
        assert body["metrics"]["reg_r2"] == 0.945


def test_rider_pages_do_not_treat_the_band_as_85_percent() -> None:
    demo = (ROOT / "web" / "demo.html").read_text(encoding="utf-8")
    home = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    assert "80% arrival window" not in demo
    assert "85%" not in home
    assert "not measured" in demo
    assert "Severe congestion" in demo
    assert 'id="ops"' in home
    assert "These scores are not real-world accuracy" not in home


def test_frontend_api_urls_are_relative() -> None:
    script = (ROOT / "web" / "app.js").read_text(encoding="utf-8")
    assert "localhost" not in script
    assert "127.0.0.1" not in script
    for path in ("/api/corridor", "/api/simulate", "/api/diagnostics"):
        assert path in script
    assert "API calls must be relative" in script


def test_pages_do_not_ship_placeholders() -> None:
    about = (ROOT / "web" / "about.html").read_text(encoding="utf-8")
    demo = (ROOT / "web" / "demo.html").read_text(encoding="utf-8")
    model = (ROOT / "web" / "model.html").read_text(encoding="utf-8")
    assert "team@example.com" not in about
    assert "Team member name" not in about
    assert "Utkarsh Kumar" in about
    assert "github.com/utkarsh777-wins" in about
    assert "ps-card" not in about
    assert "PROTOTYPE ONLY" not in demo
    assert "not in repo" not in model
    assert "not measured yet" not in model


def test_standin_fallback_is_labeled() -> None:
    page = (ROOT / "web" / "demo.html").read_text(encoding="utf-8")
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


def test_later_segment_arrival_matches_homepage_demo_and_csv() -> None:
    """Segment 5 must use the cumulative arrival, the same function the pages call."""
    with TestClient(app) as client:
        payload = client.post("/api/simulate", json=SIMULATION).json()
        evidence = client.get("/api/evidence").json()
    segment = payload["segments"][4]
    assert segment["segment_id"] == 5
    hop_only = segment["scheduled_time_min"] + segment["lower_bound_min"]
    cumulative = segment["estimated_arrival_offset_min"]
    assert cumulative > hop_only + 10

    script = r"""
const api = require("./web/js/arrival.js");
const seg = JSON.parse(process.argv[1]);
const view = api.arrivalView(seg);
const hopLo = Math.max(0, Number(seg.scheduled_time_min) + Number(seg.lower_bound_min));
if (Math.abs(view.eta - Math.max(0, Number(seg.estimated_arrival_offset_min))) > 1e-9) process.exit(2);
if (view.lo - view.eta > 0.05 || view.eta - view.hi > 0.05) process.exit(3);
if (Math.abs(view.lo - hopLo) < 1) process.exit(4);
const walk = Number(seg.walk_time_min);
if (Math.abs(api.minutes1(view.eta) - (Number(seg.leave_by_min) + walk)) > 0.15) process.exit(5);
const row = [
  seg.segment_id, seg.start_stop, seg.end_stop,
  api.formatMinutes(seg.scheduled_arrival_offset_min), api.formatMinutes(view.eta),
  api.formatMinutes(seg.predicted_delay_min), api.formatMinutes(view.lo), api.formatMinutes(view.hi),
  api.formatMinutes(seg.leave_by_min), seg.delay_status,
].map(api.csvCell);
if (row[6] !== api.formatMinutes(view.lo)) process.exit(6);
if (row[6] !== api.csvCell(row[6])) process.exit(16);
if (api.csvCell(-1.25) !== "-1.25") process.exit(7);
if (api.csvCell("-1.25") !== "-1.25") process.exit(8);
if (!api.csvCell("=1+1").startsWith("'")) process.exit(9);
if (!api.csvCell("+cmd").startsWith("'")) process.exit(10);
if (api.csvCell('PAP, "Chowk"') !== '"PAP, ""Chowk""' + '"') process.exit(11);
const gate = api.createRequestGate();
const first = gate.start();
const second = gate.start();
const events = [];
function settle(token, ok, value) {
  if (!gate.isCurrent(token)) { events.push("drop"); return; }
  events.push(ok ? "show:" + value : "fail");
}
settle(first, true, "old");
settle(second, false, "err");
if (events.indexOf("show:old") !== -1) process.exit(12);
if (events.indexOf("fail") === -1 || events.indexOf("drop") === -1) process.exit(13);
const third = gate.start();
settle(second, true, "stale-error-path");
settle(third, true, "new");
if (events.indexOf("show:stale-error-path") !== -1) process.exit(14);
if (events.indexOf("show:new") === -1) process.exit(15);
console.log(JSON.stringify({ lo: view.lo, hi: view.hi, eta: view.eta, row: row.join(",") }));
"""
    proc = subprocess.run(
        ["node", "-e", script, json.dumps(segment)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr + proc.stdout
    rendered = json.loads(proc.stdout)
    assert rendered["eta"] == pytest.approx(cumulative, abs=1e-6)

    home = (ROOT / "web" / "js" / "rider-home.js").read_text(encoding="utf-8")
    demo_js = (ROOT / "web" / "app.js").read_text(encoding="utf-8")
    demo_html = (ROOT / "web" / "demo.html").read_text(encoding="utf-8")
    index = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    assert "arrivalView(" in home
    assert "createRequestGate" in home
    assert home.count("isCurrent") >= 2
    assert "arrivalView(" in demo_js
    assert "scheduled_time_min) + Number(segment.lower_bound_min)" not in demo_js
    assert "scheduled_arrival_min" in demo_js
    assert "shifted_band_low_min" in demo_js
    assert "shifted_band_high_min" in demo_js
    assert "range_low_min" not in demo_js
    assert "story.scheduledArrival" in demo_js
    assert "hop time" in demo_js
    assert "Likely arrival" in home
    how = (ROOT / "web" / "how-it-works.html").read_text(encoding="utf-8")
    landing = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    assert "Riders get the 10th–90th range" not in how
    assert "not a calibrated cumulative interval" in how
    assert "10th–90th percentile band" not in landing
    assert "percentile window" not in landing
    assert "not a calibrated cumulative interval" not in landing
    assert "walk_time_min: 8" not in home
    assert home.count("walk_time_min: 5") >= 3
    assert "80% prediction interval" not in (ROOT / "src" / "app.py").read_text(encoding="utf-8")
    assert "10th–90th minute range" not in demo_html
    assert "not a calibrated cumulative interval" in demo_html.lower() or "Not a calibrated cumulative interval" in demo_html
    assert 'src="js/arrival.js"' in index
    assert 'src="js/arrival.js"' in demo_html
    assert index.index("js/arrival.js") < index.index("js/rider-home.js")
    assert "3,756" not in demo_html
    assert "939" not in demo_html
    assert 'id="split-train"' in demo_html
    assert "n_train" in demo_js
    assert evidence["ablation"]["n_train"] == 3750
    assert evidence["ablation"]["n_test"] == 945
    assert evidence["interval_coverage"]["n_test"] == 945
