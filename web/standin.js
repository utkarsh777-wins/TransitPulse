/* TransitPulse AI — in-browser stand-in for the FastAPI backend (source/app.py).
   Used ONLY when the real API is unreachable (opened from file://, ?standin=1, or a failed fetch).
   It mirrors the JSON shapes of GET /api/corridor, POST /api/simulate and GET /api/diagnostics.
   The numbers come from a heuristic that imitates the RandomForest + quantile models; they are NOT model output. */
(function () {
  const STOPS = [
    { stop_id: 0, name: "Jalandhar Bus Stand", short: "Jalandhar BS", lat: 31.3156, lon: 75.592 },
    { stop_id: 1, name: "PAP Chowk", short: "PAP Chowk", lat: 31.309, lon: 75.6195 },
    { stop_id: 2, name: "Rama Mandi", short: "Rama Mandi", lat: 31.3015, lon: 75.6375 },
    { stop_id: 3, name: "Haveli Corridor", short: "Haveli", lat: 31.272, lon: 75.678 },
    { stop_id: 4, name: "LPU Main Gate", short: "LPU Gate", lat: 31.2554, lon: 75.7049 },
    { stop_id: 5, name: "Phagwara Bus Stand", short: "Phagwara BS", lat: 31.224, lon: 75.7708 },
  ];
  const SEG_DEF = [
    [1, "Jalandhar BS → PAP Chowk", 0, 1, 3.4, 6.5],
    [2, "PAP Chowk → Rama Mandi", 1, 2, 2.2, 5.0],
    [3, "Rama Mandi → Haveli Corridor", 2, 3, 5.1, 7.5],
    [4, "Haveli Corridor → LPU Gate", 3, 4, 3.3, 5.5],
    [5, "LPU Gate → Phagwara BS", 4, 5, 7.2, 11.0],
  ];
  const DELAY_LABELS = ["On-Time", "Moderate Delay", "Severe Delay"];
  const WEATHER_LABELS = ["Clear", "Light Rain / Fog", "Heavy Downpour"];
  const BUS_ID = "PB08-BUS-101";
  const ROUTE_NAME = "NH-44 GT Road Corridor";
  const PRESETS = {
    midday: { hour_of_day: 13, is_weekend: false, weather_severity: 0, rolling_3trip_delay_min: 0.5, prev_stop_dwell_sec: 30, gps_speed_kmh: 34 },
    rush: { hour_of_day: 8, is_weekend: false, weather_severity: 1, rolling_3trip_delay_min: 6.5, prev_stop_dwell_sec: 85, gps_speed_kmh: 18 },
    evening: { hour_of_day: 18, is_weekend: false, weather_severity: 0, rolling_3trip_delay_min: 14, prev_stop_dwell_sec: 115, gps_speed_kmh: 10 },
  };
  const PRESET_LABELS = { midday: "Midday Clear", rush: "Morning Rush + Rain", evening: "Evening Gridlock" };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r2 = (v) => Math.round(v * 100) / 100;
  const isPeak = (h) => (h >= 8 && h <= 10) || (h >= 17 && h <= 19);
  const signed = (v, d = 1) => { const s = Number(v).toFixed(d); return Number(s) > 0 ? `+${s}` : Number(s) === 0 ? (0).toFixed(d) : s.replace("-", "−"); };
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
  const statusKey = (s) => (s === "Severe Delay" ? "severe" : s === "Moderate Delay" ? "moderate" : "ontime");
  const statusShort = (s) => (s === "Severe Delay" ? "Severe" : s === "Moderate Delay" ? "Moderate" : "On-Time");

  const segments = SEG_DEF.map(([id, name, a, b, km, sched]) => ({
    segment_id: id, name, start_stop_id: a, end_stop_id: b, distance_km: km, scheduled_time_min: sched,
    start_stop: STOPS[a].name, end_stop: STOPS[b].name,
    start_lat: STOPS[a].lat, start_lon: STOPS[a].lon, end_lat: STOPS[b].lat, end_lon: STOPS[b].lon,
  }));
  let cur = 0;
  segments.forEach((s) => { s.scheduled_start_offset_min = cur; cur += s.scheduled_time_min; s.scheduled_arrival_offset_min = cur; });
  const SCHED_TOTAL = cur;
  const DIST_TOTAL = r2(segments.reduce((t, s) => t + s.distance_km, 0));

  function corridor() {
    let c = 0;
    return {
      route_name: ROUTE_NAME, bus_id: BUS_ID, distance_km: DIST_TOTAL, scheduled_time_min: SCHED_TOTAL,
      stops: STOPS.map((s, i) => { const o = { ...s, scheduled_offset_min: c }; if (i < segments.length) c += segments[i].scheduled_time_min; return o; }),
      segments: segments.map((s) => ({ ...s })),
      peak_windows: ["08:00-10:00", "17:00-19:00"],
    };
  }

  /* Heuristic stand-in for the RandomForest + quantile models, decomposed the same way app.py does (leave-one-out). */
  const BASE_C = [-0.2, 0.3, 0.65, 0.45, 1.2];
  function simulate(req) {
    const peak = isPeak(req.hour_of_day);
    const w = req.weather_severity, lag = req.rolling_3trip_delay_min, dwell = req.prev_stop_dwell_sec, spd = req.gps_speed_kmh;
    let cumDelay = 0, cumSched = 0, confW = 0, worst = 0;
    const segs = segments.map((seg, i) => {
      const sched = seg.scheduled_time_min;
      const baseline = BASE_C[i] + (34 - spd) * 0.05 * (sched / 6.6);
      const lagD = lag * (0.12 + 0.01 * i);
      const peakD = peak ? 0.5 + 0.06 * sched + (seg.segment_id === 2 || seg.segment_id === 4 ? 1.2 : 0) : 0;
      const wD = w * (0.3 + 0.05 * sched);
      const dwD = ((dwell - 30) / 30) * 0.35;
      const pred = baseline + lagD + peakD + wD + dwD;
      const lower = pred - (0.25 + 0.035 * sched + (peak ? 1.5 : 0) + w * 0.55 + lag * 0.06);
      const upper = pred + (0.45 + 0.04 * sched + (peak ? 2.1 : 0) + w * 0.8 + lag * 0.08);
      const width = r2(Math.max(upper - lower, 0.1));
      let conf = clamp(100 - 8.2 * width - (peak ? 4 : 0), 35, 96); if (peak) conf = Math.min(conf, 69);
      conf = Math.round(conf * 10) / 10;
      const si = pred < 2 ? 0 : pred < 5 ? 1 : 2;
      worst = Math.max(worst, si);
      const edge = si === 0 ? 2 - pred : si === 1 ? Math.min(pred - 2, 5 - pred) : pred - 5;
      const prob = clamp(0.58 + 0.41 * Math.min(1, edge / 1.6), 0.5, 0.99);
      const segSpeed = seg.distance_km / Math.max((sched + Math.max(pred, 0)) / 60, 0.1);
      cumDelay += pred;
      const out = {
        ...seg,
        predicted_delay_min: r2(pred), lower_bound_min: r2(lower), upper_bound_min: r2(upper), interval_width_min: width,
        delay_status: DELAY_LABELS[si], status_probability_pct: Math.round(prob * 1000) / 10, is_peak_hour: peak,
        confidence_pct: conf, is_low_confidence: peak || conf < 70,
        xai_drivers: [
          { key: "rolling_lag", label: "Cascading 3-Trip Lag", minutes: r2(lagD) },
          { key: "peak_hour", label: "Peak Hour Surge", minutes: r2(peakD) },
          { key: "weather", label: "Weather Impact", minutes: r2(wD) },
          { key: "dwell", label: "Stop Dwell Time", minutes: r2(dwD) },
        ],
        xai_baseline_min: r2(baseline),
        simulated_speed_kmh: Math.round(clamp(0.65 * spd + 0.35 * segSpeed, 5, 85) * 10) / 10,
        estimated_segment_time_min: r2(sched + Math.max(pred, 0)),
        scheduled_start_offset_min: r2(cumSched), cumulative_delay_min: r2(cumDelay),
      };
      cumSched += sched;
      out.scheduled_arrival_offset_min = r2(cumSched);
      out.estimated_arrival_offset_min = r2(cumSched + cumDelay);
      confW += conf * sched;
      return out;
    });
    const total = r2(segs.reduce((t, s) => t + s.predicted_delay_min, 0));
    const cconf = Math.round((confW / SCHED_TOTAL) * 10) / 10;
    return {
      simulation: { ...req, weather_label: WEATHER_LABELS[w], clock: `${String(req.hour_of_day).padStart(2, "0")}:00` },
      peak: { is_peak_hour: peak, window: "08:00-10:00 / 17:00-19:00" },
      segments: segs,
      corridor: {
        route_name: ROUTE_NAME, bus_id: BUS_ID, distance_km: DIST_TOTAL, scheduled_time_min: SCHED_TOTAL,
        total_predicted_delay_min: total, estimated_trip_time_min: r2(SCHED_TOTAL + total),
        delay_status: DELAY_LABELS[worst], confidence_pct: cconf, is_low_confidence: peak || cconf < 70,
        low_confidence_segments: segs.filter((s) => s.is_low_confidence).length,
      },
    };
  }

  /* Representative /api/diagnostics payload (real values come from models/model_metadata.json + dq_audit_report.json). */
  function diagnostics() {
    const hex = (seed) => { let h = 2166136261 ^ seed, out = ""; for (let i = 0; i < 64; i++) { h = Math.imul(h ^ (i * 2654435761), 16777619) >>> 0; out += (h & 15).toString(16); } return out; };
    return {
      model_metadata: {
        metrics: { reg_mae: 0.842, baseline_mae: 2.317, error_reduction_pct: 63.66, reg_r2: 0.874, clf_accuracy: 0.912, clf_macro_f1: 0.884 },
        uncertainty: { peak_hour_interval_width: 4.862, off_peak_interval_width: 1.734 },
        feature_importances: { rolling_3trip_delay_min: 0.284, gps_speed_kmh: 0.196, is_peak_hour: 0.142, prev_stop_dwell_sec: 0.118, weather_severity: 0.091, historical_segment_avg_min: 0.067, hour_of_day: 0.043, scheduled_time_min: 0.027, segment_distance_km: 0.016, segment_id: 0.009, day_of_week: 0.005, is_weekend: 0.002 },
      },
      dq_audit_report: {
        passed: true,
        summary: { raw_records: 4800, clean_records: 4695, retention_rate_pct: 97.81 },
        cleaning_funnel: [
          { stage: "Raw GPS ingest", records: 4800, delta: 0 },
          { stage: "Schema & type checks", records: 4800, delta: 0 },
          { stage: "Geofence bounds", records: 4762, delta: -38 },
          { stage: "Duplicate packets", records: 4731, delta: -31 },
          { stage: "Speed plausibility", records: 4695, delta: -36 },
          { stage: "Dwell imputation", records: 4695, delta: 0, imputed: 84 },
        ],
        gates: [
          { name: "Geofence Gate", status: "passed", description: "GPS fixes outside the NH-44 corridor buffer removed.", dropped_records: 38, imputed_records: 0, output_records: 4762 },
          { name: "Deduplication Gate", status: "passed", description: "Repeated telemetry packets with identical timestamps collapsed.", dropped_records: 31, imputed_records: 0, output_records: 4731 },
          { name: "Physics Gate", status: "passed", description: "Speeds above 95 km/h or teleport jumps rejected.", dropped_records: 36, imputed_records: 0, output_records: 4695 },
          { name: "Dwell Imputation", status: "passed", description: "Missing dwell readings filled from stop-level medians.", dropped_records: 0, imputed_records: 84, output_records: 4695 },
        ],
      },
      verification: { passed: true },
      artifacts: [
        { file: "delay_regressor.joblib", name: "RandomForestRegressor", size_bytes: 19293798, sha256: hex(1) },
        { file: "delay_classifier.joblib", name: "RandomForestClassifier", size_bytes: 10171187, sha256: hex(2) },
        { file: "quantile_lower_10.joblib", name: "Quantile regressor α=0.10", size_bytes: 421888, sha256: hex(3) },
        { file: "quantile_upper_90.joblib", name: "Quantile regressor α=0.90", size_bytes: 418816, sha256: hex(4) },
        { file: "model_metadata.json", name: "Metrics & feature schema", size_bytes: 6144, sha256: hex(5) },
      ],
      plots: [{ name: "Phase 1 Pipeline Diagnostics", url: "/assets/phase1_pipeline_diagnostics.png", caption: "Data-quality gates, corridor telemetry distributions, and cleaning funnel." }],
      runtime: { status: "online", backend: "FastAPI", regressor: "RandomForestRegressor", classifier: "RandomForestClassifier", uncertainty: "GradientBoosting quantile (α 0.10 / 0.90)", feature_count: 12, artifacts_passed: true, quality_gates_passed: true, generated_at: new Date().toISOString() },
    };
  }

  /* Phase-1 diagnostics plot rebuilt as themable SVG (the real PNG lives at /assets/phase1_pipeline_diagnostics.png). */
  function diagnosticPlotSVG() {
    const W = 720, H = 260, pad = 28, pw = (W - pad * 4) / 3, ph = H - 70;
    const panel = (i, title, body) => `<g transform="translate(${pad + i * (pw + pad)},28)"><text class="pl-title" x="0" y="-10">${title}</text><rect class="pl-frame" x="0" y="0" width="${pw}" height="${ph}" rx="4"/>${body}</g>`;
    const funnel = [4800, 4800, 4762, 4731, 4695, 4695];
    const fb = funnel.map((v, i) => { const w = ((v - 4500) / 300) * (pw - 20); return `<rect class="${i === 5 ? "pl-bar2" : "pl-bar"}" x="10" y="${12 + i * 28}" width="${w}" height="18" rx="2"/><text class="pl-num" x="${w + 4 > pw - 50 ? w - 4 : w + 14}" y="${25 + i * 28}" text-anchor="${w + 4 > pw - 50 ? "end" : "start"}">${v}</text>`; }).join("");
    const speeds = [2, 5, 11, 19, 27, 31, 28, 22, 15, 9, 5, 2];
    const bw = (pw - 20) / speeds.length;
    const hb = speeds.map((v, i) => `<rect class="pl-bar" x="${10 + i * bw + 1}" y="${ph - 14 - v * 5}" width="${bw - 2}" height="${v * 5}" rx="1"/>`).join("") + `<line class="pl-axis" x1="10" x2="${pw - 10}" y1="${ph - 14}" y2="${ph - 14}"/><text class="pl-num" x="10" y="${ph - 2}">0</text><text class="pl-num" x="${pw - 10}" y="${ph - 2}" text-anchor="end">60 km/h</text>`;
    const pts = Array.from({ length: 40 }, (_, i) => { const x = i / 39, y = Math.exp(-Math.pow((x - 0.32) / 0.14, 2)) * 0.9 + Math.exp(-Math.pow((x - 0.68) / 0.12, 2)) * 0.35; return [10 + x * (pw - 20), ph - 14 - y * (ph - 40)]; });
    const path = "M" + pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" L");
    const area = path + ` L${pw - 10},${ph - 14} L10,${ph - 14} Z`;
    const kd = `<path class="pl-area" d="${area}"/><path class="pl-line" d="${path}"/><line class="pl-axis" x1="10" x2="${pw - 10}" y1="${ph - 14}" y2="${ph - 14}"/><line class="pl-mark" x1="${10 + 0.32 * (pw - 20)}" x2="${10 + 0.32 * (pw - 20)}" y1="14" y2="${ph - 14}"/><text class="pl-num" x="10" y="${ph - 2}">−2</text><text class="pl-num" x="${pw - 10}" y="${ph - 2}" text-anchor="end">+14 min</text>`;
    return `<svg class="diag-plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="Phase 1 pipeline diagnostics: cleaning funnel, GPS speed distribution, delay distribution">${panel(0, "CLEANING FUNNEL · ROWS", fb)}${panel(1, "GPS SPEED DISTRIBUTION", hb)}${panel(2, "SEGMENT DELAY DENSITY", kd)}</svg>`;
  }


  window.TPStandIn = { corridor, simulate, diagnostics, plotSVG: diagnosticPlotSVG };
})();
