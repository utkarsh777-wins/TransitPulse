const dom = {
  clock: document.getElementById("live-clock"),
  syncPill: document.getElementById("sync-pill"),
  syncLabel: document.getElementById("sync-label"),
  views: {
    live: document.getElementById("view-live"),
    evaluator: document.getElementById("view-evaluator"),
  },
  tabs: Array.from(document.querySelectorAll(".view-tab")),
  footerMode: document.getElementById("footer-mode"),
  statDelay: document.getElementById("stat-delay"),
  statDelayFoot: document.getElementById("stat-delay-foot"),
  statConfidence: document.getElementById("stat-confidence"),
  statConfidenceFoot: document.getElementById("stat-confidence-foot"),
  statEta: document.getElementById("stat-eta"),
  statEtaFoot: document.getElementById("stat-eta-foot"),
  statStatus: document.getElementById("stat-status"),
  statStatusFoot: document.getElementById("stat-status-foot"),
  countOnTime: document.getElementById("count-on-time"),
  countModerate: document.getElementById("count-moderate"),
  countSevere: document.getElementById("count-severe"),
  etaCard: document.getElementById("eta-card"),
  peakAlert: document.getElementById("peak-alert"),
  etaTitle: document.getElementById("eta-title"),
  confidenceBadge: document.getElementById("confidence-badge"),
  etaValue: document.getElementById("eta-value"),
  etaMeta: document.getElementById("eta-meta"),
  etaRange: document.getElementById("eta-range"),
  etaRangeValue: document.getElementById("eta-range-value"),
  rangeBar: document.getElementById("range-bar"),
  recommendation: document.getElementById("recommendation"),
  etaSegmentName: document.getElementById("eta-segment-name"),
  etaClassifier: document.getElementById("eta-classifier"),
  etaWindow: document.getElementById("eta-window"),
  xaiSegment: document.getElementById("xai-segment"),
  xaiBars: document.getElementById("xai-bars"),
  xaiBaseline: document.getElementById("xai-baseline"),
  segmentList: document.getElementById("segment-list"),
  timeSlider: document.getElementById("time-slider"),
  timeValue: document.getElementById("time-value"),
  peakFlag: document.getElementById("peak-flag"),
  weatherValue: document.getElementById("weather-value"),
  weatherButtons: Array.from(document.querySelectorAll(".weather-btn")),
  lagSlider: document.getElementById("lag-slider"),
  lagValue: document.getElementById("lag-value"),
  dwellSlider: document.getElementById("dwell-slider"),
  dwellValue: document.getElementById("dwell-value"),
  speedSlider: document.getElementById("speed-slider"),
  speedValue: document.getElementById("speed-value"),
  presetButtons: Array.from(document.querySelectorAll(".preset-btn")),
  playToggle: document.getElementById("play-toggle"),
  playLabel: document.getElementById("play-label"),
  recenterMap: document.getElementById("recenter-map"),
  hudState: document.getElementById("hud-state"),
  hudLat: document.getElementById("hud-lat"),
  hudLon: document.getElementById("hud-lon"),
  hudSpeed: document.getElementById("hud-speed"),
  hudNextStop: document.getElementById("hud-next-stop"),
  hudProgressValue: document.getElementById("hud-progress-value"),
  hudProgressBar: document.getElementById("hud-progress-bar"),
  toast: document.getElementById("toast"),
  evalBadge: document.getElementById("eval-badge"),
  retentionTag: document.getElementById("retention-tag"),
  metricGrid: document.getElementById("metric-grid"),
  dqFunnel: document.getElementById("dq-funnel"),
  dqGates: document.getElementById("dq-gates"),
  featureImportance: document.getElementById("feature-importance"),
  uncertaintyVisual: document.getElementById("uncertainty-visual"),
  uncertaintyNote: document.getElementById("uncertainty-note"),
  diagnosticPlot: document.getElementById("diagnostic-plot"),
  plotLink: document.getElementById("plot-link"),
  diagnosticCaption: document.getElementById("diagnostic-caption"),
  artifactCount: document.getElementById("artifact-count"),
  artifactTable: document.getElementById("artifact-table"),
  diagRuntime: document.getElementById("diag-runtime"),
};

const WEATHER_LABELS = ["Clear", "Light Rain / Fog", "Heavy Downpour"];
const BUS_ID = "PB08-BUS-101";

const PRESETS = {
  midday: {
    hour_of_day: 13,
    is_weekend: false,
    weather_severity: 0,
    rolling_3trip_delay_min: 0.5,
    prev_stop_dwell_sec: 30,
    gps_speed_kmh: 34,
  },
  rush: {
    hour_of_day: 8,
    is_weekend: false,
    weather_severity: 1,
    rolling_3trip_delay_min: 6.5,
    prev_stop_dwell_sec: 85,
    gps_speed_kmh: 18,
  },
  evening: {
    hour_of_day: 18,
    is_weekend: false,
    weather_severity: 0,
    rolling_3trip_delay_min: 14,
    prev_stop_dwell_sec: 115,
    gps_speed_kmh: 10,
  },
};

const state = {
  corridor: null,
  result: null,
  diagnostics: null,
  simulation: { ...PRESETS.midday },
  selectedSegmentId: 1,
  playing: true,
  activePreset: "midday",
  requestSeq: 0,
  debounceTimer: null,
  toastTimer: null,
  map: null,
  busMarker: null,
  segmentLayers: {},
  stopMarkers: [],
  routeTotalKm: 0,
  busProgressKm: 0,
  lastFrame: null,
  lastHudTs: 0,
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isPeakHour(hour) {
  return (hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 19);
}

function signed(value, digits = 1) {
  const rounded = Number(value).toFixed(digits);
  return Number(rounded) > 0 ? `+${rounded}` : rounded;
}

function statusClass(status) {
  if (status === "Severe Delay") return "severe";
  if (status === "Moderate Delay") return "moderate";
  return "on-time";
}

function statusLabel(status) {
  return status || "On-Time";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function setSyncState(kind, label) {
  dom.syncPill.classList.remove("is-error", "is-busy");
  if (kind === "error") dom.syncPill.classList.add("is-error");
  if (kind === "busy") dom.syncPill.classList.add("is-busy");
  dom.syncLabel.textContent = label;
}

function showToast(message, isError = false) {
  dom.toast.textContent = message;
  dom.toast.classList.toggle("is-error", isError);
  dom.toast.classList.add("is-visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    dom.toast.classList.remove("is-visible");
  }, 3200);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  return response.json();
}

function startClock() {
  const formatter = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const tick = () => {
    dom.clock.textContent = formatter.format(new Date());
  };
  tick();
  window.setInterval(tick, 1000);
}

function updateRangeFill(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty("--fill", `${clamp(percent, 0, 100)}%`);
}

function updateControlLabels() {
  const hour = Number(state.simulation.hour_of_day);
  const peak = isPeakHour(hour);
  dom.timeValue.textContent = `${String(hour).padStart(2, "0")}:00`;
  dom.peakFlag.textContent = peak ? "Peak" : "Off-Peak";
  dom.peakFlag.classList.toggle("is-peak", peak);
  dom.weatherValue.textContent = WEATHER_LABELS[state.simulation.weather_severity];
  dom.lagValue.textContent = Number(state.simulation.rolling_3trip_delay_min).toFixed(1);
  dom.dwellValue.textContent = String(Math.round(state.simulation.prev_stop_dwell_sec));
  dom.speedValue.textContent = String(Math.round(state.simulation.gps_speed_kmh));
}

function syncControlsFromState() {
  dom.timeSlider.value = String(state.simulation.hour_of_day);
  dom.lagSlider.value = String(state.simulation.rolling_3trip_delay_min);
  dom.dwellSlider.value = String(state.simulation.prev_stop_dwell_sec);
  dom.speedSlider.value = String(state.simulation.gps_speed_kmh);
  dom.weatherButtons.forEach((button) => {
    button.classList.toggle("is-active", Number(button.dataset.weather) === state.simulation.weather_severity);
  });
  [dom.timeSlider, dom.lagSlider, dom.dwellSlider, dom.speedSlider].forEach(updateRangeFill);
  updateControlLabels();
}

function clearPresetSelection() {
  state.activePreset = null;
  dom.presetButtons.forEach((button) => button.classList.remove("is-active"));
}

function setPresetSelection(name) {
  state.activePreset = name;
  dom.presetButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.preset === name);
  });
}

function scheduleSimulation(delay = 140) {
  window.clearTimeout(state.debounceTimer);
  state.debounceTimer = window.setTimeout(() => {
    runSimulation();
  }, delay);
}

async function runSimulation() {
  const sequence = ++state.requestSeq;
  setSyncState("busy", "Running live inference");
  try {
    const result = await fetchJson("/api/simulate", {
      method: "POST",
      body: JSON.stringify(state.simulation),
    });
    if (sequence !== state.requestSeq) return;
    state.result = result;
    applySimulation(result);
    setSyncState("ok", "Model Link Active");
  } catch (error) {
    if (sequence !== state.requestSeq) return;
    setSyncState("error", "Inference offline");
    showToast("Live inference failed. Check the FastAPI server.", true);
  }
}

function applySimulation(result) {
  const selectedExists = result.segments.some((segment) => segment.segment_id === state.selectedSegmentId);
  if (!selectedExists) state.selectedSegmentId = result.segments[0]?.segment_id ?? 1;
  updateMapSegments(result.segments);
  renderStats();
  renderSegmentList();
  renderRiderCard();
  renderXai();
}

function getSelectedSegment() {
  if (!state.result) return null;
  return (
    state.result.segments.find((segment) => segment.segment_id === state.selectedSegmentId) ||
    state.result.segments[0] ||
    null
  );
}

function getSegmentById(id) {
  return state.result?.segments.find((segment) => segment.segment_id === id) || null;
}

function recommendationFor(segment) {
  if (!segment || !state.result) return "Select a segment to inspect live rider guidance.";
  const weather = state.result.simulation.weather_severity;
  if (segment.delay_status === "Severe Delay") {
    return "Allow 15+ extra minutes or board the next service. The live arrival window is expanding.";
  }
  if (segment.delay_status === "Moderate Delay") {
    if (weather > 0) return "Carry a weather buffer and monitor the live window; wet-weather boarding is slowing this segment.";
    if (segment.is_peak_hour) return "Prefer the next departure if connecting; peak demand is extending the arrival window.";
    return "Service is running slightly behind schedule. The current arrival window remains usable.";
  }
  if (weather > 0) return "Bus is close to schedule. Keep a small weather buffer for the final approach.";
  if (segment.is_peak_hour) return "Board now; the bus is tracking within the on-time band despite peak volumes.";
  return "On-time service. No action required; keep monitoring the live telemetry link.";
}

function renderStats() {
  if (!state.result) return;
  const corridor = state.result.corridor;
  const selected = getSelectedSegment();
  dom.statDelay.textContent = Number(corridor.total_predicted_delay_min).toFixed(1);
  dom.statDelayFoot.textContent = `${corridor.estimated_trip_time_min.toFixed(1)} min end-to-end · schedule ${corridor.scheduled_time_min.toFixed(1)} min`;
  dom.statConfidence.textContent = Number(corridor.confidence_pct).toFixed(0);
  dom.statConfidenceFoot.textContent = corridor.is_low_confidence
    ? `${corridor.low_confidence_segments} low-confidence segment${corridor.low_confidence_segments === 1 ? "" : "s"}`
    : "80% quantile envelope";
  if (selected) {
    dom.statEta.textContent = Number(selected.estimated_segment_time_min).toFixed(1);
    dom.statEtaFoot.textContent = `To ${selected.end_stop} · scheduled ${Number(selected.scheduled_time_min).toFixed(1)} min`;
  }
  dom.statStatus.textContent = statusLabel(corridor.delay_status);
  dom.statStatus.style.color = corridor.status_color;
  dom.statStatusFoot.textContent = `Classifier output · ${corridor.low_confidence_segments} uncertainty trigger${corridor.low_confidence_segments === 1 ? "" : "s"}`;

  const counts = { "On-Time": 0, "Moderate Delay": 0, "Severe Delay": 0 };
  state.result.segments.forEach((segment) => {
    counts[segment.delay_status] += 1;
  });
  dom.countOnTime.textContent = String(counts["On-Time"]);
  dom.countModerate.textContent = String(counts["Moderate Delay"]);
  dom.countSevere.textContent = String(counts["Severe Delay"]);
}

function renderRiderCard() {
  const segment = getSelectedSegment();
  if (!segment || !state.result) return;
  const low = Boolean(segment.is_low_confidence);
  const confidence = Number(segment.confidence_pct);
  const badgeClass = confidence >= 70 ? "high" : confidence >= 55 ? "low" : "critical";

  dom.peakAlert.hidden = !low;
  dom.peakAlert.classList.toggle("is-critical", low && (confidence < 55 || segment.delay_status === "Severe Delay"));
  dom.etaTitle.textContent = segment.end_stop;
  dom.confidenceBadge.className = `confidence-badge ${badgeClass}`;
  dom.confidenceBadge.textContent = `Confidence ${confidence.toFixed(0)}%`;

  dom.etaValue.classList.remove("is-low", "is-critical", "is-range");
  if (low) {
    dom.etaValue.classList.add("is-range");
    dom.etaValue.classList.add(confidence < 55 ? "is-critical" : "is-low");
    dom.etaValue.innerHTML = `${signed(segment.lower_bound_min)}<span class="range-arrow">→</span>${signed(segment.upper_bound_min)}<small>min</small>`;
    dom.etaMeta.textContent = `80% window: ${signed(segment.lower_bound_min)} to ${signed(segment.upper_bound_min)} min · ${segment.delay_status}`;
    dom.etaRange.hidden = false;
    dom.etaRangeValue.textContent = `Delay: ${signed(segment.lower_bound_min)} to ${signed(segment.upper_bound_min)} mins`;
    const width = Math.max(segment.interval_width_min, 0.1);
    dom.rangeBar.style.width = `${clamp((width / 12) * 100, 12, 100)}%`;
  } else {
    dom.etaValue.innerHTML = `${signed(segment.predicted_delay_min)}<small>min</small>`;
    dom.etaMeta.textContent = `Confidence: ${confidence.toFixed(0)}% | ETA: ${signed(segment.predicted_delay_min)} min · ${segment.delay_status}`;
    dom.etaRange.hidden = true;
  }

  dom.recommendation.textContent = recommendationFor(segment);
  dom.etaSegmentName.textContent = segment.name;
  dom.etaClassifier.textContent = `${segment.delay_status} · ${Number(segment.status_probability_pct).toFixed(0)}%`;
  dom.etaWindow.textContent = `${signed(segment.lower_bound_min)} to ${signed(segment.upper_bound_min)} min`;
  dom.etaCard.style.setProperty("--eta-status", segment.status_color);
}

function renderXai() {
  const segment = getSelectedSegment();
  if (!segment) return;
  const drivers = segment.xai_drivers || [];
  const maxMagnitude = Math.max(...drivers.map((driver) => Math.abs(Number(driver.minutes))), 0.5);
  dom.xaiSegment.textContent = `SEG ${String(segment.segment_id).padStart(2, "0")}`;
  dom.xaiBars.innerHTML = drivers
    .map((driver) => {
      const minutes = Number(driver.minutes);
      const negative = minutes < 0;
      const width = clamp((Math.abs(minutes) / maxMagnitude) * 100, 2, 100);
      return `
        <div class="xai-row">
          <span class="xai-label">${escapeHtml(driver.label)}</span>
          <span class="xai-track${negative ? " negative" : ""}"><i style="width:${width}%"></i></span>
          <span class="xai-value${negative ? " negative" : ""}">${signed(minutes)}m</span>
        </div>
      `;
    })
    .join("");
  dom.xaiBaseline.textContent = `${signed(segment.xai_baseline_min)} min`;
}

function renderSegmentList() {
  if (!state.result) return;
  dom.segmentList.innerHTML = state.result.segments
    .map((segment) => {
      const cls = statusClass(segment.delay_status);
      const selected = segment.segment_id === state.selectedSegmentId ? " is-selected" : "";
      return `
        <button class="segment-item status-${cls}${selected}" data-segment-id="${segment.segment_id}" type="button" aria-label="Inspect ${escapeHtml(segment.name)}">
          <span class="segment-top">
            <span class="segment-index">SEG ${String(segment.segment_id).padStart(2, "0")}</span>
            <span class="status-badge status-${cls}">${escapeHtml(segment.delay_status)}</span>
          </span>
          <span class="segment-name">${escapeHtml(segment.name)}</span>
          <span class="segment-delay"><b>${signed(segment.predicted_delay_min)}</b> min delay</span>
          <span class="segment-range">80%: ${signed(segment.lower_bound_min)} – ${signed(segment.upper_bound_min)}</span>
          <span class="segment-confidence"><i style="width:${clamp(segment.confidence_pct, 4, 100)}%"></i></span>
        </button>
      `;
    })
    .join("");
}

function selectSegment(segmentId, focus = false) {
  if (!getSegmentById(segmentId)) return;
  state.selectedSegmentId = segmentId;
  dom.segmentList.querySelectorAll(".segment-item").forEach((item) => {
    item.classList.toggle("is-selected", Number(item.dataset.segmentId) === segmentId);
  });
  renderStats();
  renderRiderCard();
  renderXai();
  if (focus && state.map) {
    const segment = getSegmentById(segmentId);
    state.map.panTo([(segment.start_lat + segment.end_lat) / 2, (segment.start_lon + segment.end_lon) / 2], {
      animate: true,
      duration: 0.45,
    });
  }
}

function initMap(corridor) {
  if (!window.L) {
    showToast("Leaflet failed to load. Map telemetry is unavailable.", true);
    return;
  }

  state.map = L.map("map", {
    zoomControl: true,
    attributionControl: false,
    scrollWheelZoom: true,
    preferCanvas: false,
  }).setView([31.272, 75.678], 12);

  const cartoKey =
    window.TRANSITPULSE_CARTO_KEY || new URLSearchParams(window.location.search).get("carto_key") || "";

  if (cartoKey) {
    L.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?api_key=${encodeURIComponent(cartoKey)}`, {
      subdomains: "abcd",
      maxZoom: 20,
      crossOrigin: true,
    }).addTo(state.map);
  } else {
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 16,
      crossOrigin: true,
    }).addTo(state.map);

    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 16,
      opacity: 0.92,
      crossOrigin: true,
    }).addTo(state.map);
  }

  const stopBounds = [];

  corridor.stops.forEach((stop) => {
    const terminal = stop.stop_id === 0 || stop.stop_id === corridor.stops.length - 1;
    const icon = L.divIcon({
      className: "stop-anchor",
      html: `<span class="stop-marker${terminal ? " is-terminal" : ""}"></span><span class="stop-label">${escapeHtml(stop.name)}</span>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    const marker = L.marker([stop.lat, stop.lon], { icon, zIndexOffset: 200 }).addTo(state.map);
    marker.bindPopup(
      `<strong>${escapeHtml(stop.name)}</strong><span>Stop ${stop.stop_id + 1} · scheduled +${Number(stop.scheduled_offset_min).toFixed(1)} min</span>`
    );
    state.stopMarkers.push(marker);
    stopBounds.push([stop.lat, stop.lon]);
  });

  corridor.segments.forEach((segment) => {
    const coordinates = [
      [segment.start_lat, segment.start_lon],
      [segment.end_lat, segment.end_lon],
    ];
    const glow = L.polyline(coordinates, {
      color: "#58a6ff",
      weight: 12,
      opacity: 0.14,
      lineCap: "round",
      interactive: false,
    }).addTo(state.map);
    const main = L.polyline(coordinates, {
      color: "#3fb950",
      weight: 5,
      opacity: 0.94,
      lineCap: "round",
      className: "route-line",
    }).addTo(state.map);
    main.bindTooltip(`${segment.name} · ${segment.distance_km} km`, { sticky: true });
    state.segmentLayers[segment.segment_id] = { glow, main };
  });

  const busIcon = L.divIcon({
    className: "bus-anchor",
    html: `<div class="bus-marker"><span class="bus-marker-core"><svg viewBox="0 0 24 24"><path d="M6 17V7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10M4 17h16M7 20h2M15 20h2M8 9h8M8 13h8" /></svg></span><span class="bus-marker-label">${BUS_ID}</span></div>`,
    iconSize: [46, 46],
    iconAnchor: [23, 23],
  });

  state.busMarker = L.marker([corridor.stops[0].lat, corridor.stops[0].lon], {
    icon: busIcon,
    zIndexOffset: 1000,
    interactive: false,
  }).addTo(state.map);

  state.routeTotalKm = corridor.segments.reduce((total, segment) => total + Number(segment.distance_km), 0);
  state.busProgressKm = 0;

  if (stopBounds.length) {
    state.map.fitBounds(stopBounds, {
      paddingTopLeft: [46, 46],
      paddingBottomRight: [46, 190],
      maxZoom: 13,
    });
  }

  const mapWrap = document.querySelector(".map-wrap");
  if (mapWrap && "ResizeObserver" in window) {
    const observer = new ResizeObserver(() => {
      state.map.invalidateSize();
    });
    observer.observe(mapWrap);
  }
  window.setTimeout(() => state.map.invalidateSize(), 120);
  window.setTimeout(() => state.map.invalidateSize(), 600);
  window.addEventListener("load", () => state.map.invalidateSize());

  updateHudPosition();
}

function updateMapSegments(segments) {
  segments.forEach((segment) => {
    const layers = state.segmentLayers[segment.segment_id];
    if (!layers) return;
    layers.main.setStyle({ color: segment.status_color });
    layers.glow.setStyle({ color: segment.status_color, opacity: 0.16 });
  });
}

function locateBus(progressKm) {
  if (!state.corridor) return null;
  let cursor = 0;
  const segments = state.corridor.segments;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const end = cursor + Number(segment.distance_km);
    if (progressKm <= end || index === segments.length - 1) {
      const fraction = clamp((progressKm - cursor) / Number(segment.distance_km), 0, 1);
      return {
        segment,
        index,
        lat: segment.start_lat + (segment.end_lat - segment.start_lat) * fraction,
        lon: segment.start_lon + (segment.end_lon - segment.start_lon) * fraction,
      };
    }
    cursor = end;
  }
  return null;
}

function liveSpeedFor(segment) {
  const live = state.result?.segments.find((item) => item.segment_id === segment.segment_id);
  if (live) return Number(live.simulated_speed_kmh);
  return (Number(segment.distance_km) / Number(segment.scheduled_time_min)) * 60;
}

function updateHudPosition(timestamp = 0) {
  if (!state.corridor) return;
  const located = locateBus(state.busProgressKm);
  if (!located) return;
  const speed = liveSpeedFor(located.segment);
  if (state.busMarker) {
    state.busMarker.setLatLng([located.lat, located.lon]);
  }
  if (timestamp - state.lastHudTs < 90) return;
  state.lastHudTs = timestamp;
  dom.hudLat.textContent = located.lat.toFixed(5);
  dom.hudLon.textContent = located.lon.toFixed(5);
  dom.hudSpeed.textContent = speed.toFixed(1);
  dom.hudNextStop.textContent = located.segment.end_stop;
  const progressPct = clamp((state.busProgressKm / state.routeTotalKm) * 100, 0, 100);
  dom.hudProgressValue.textContent = `${progressPct.toFixed(0)}%`;
  dom.hudProgressBar.style.width = `${progressPct}%`;
  dom.hudState.textContent = state.playing ? "TRACKING" : "PAUSED";
}

function animateBus(timestamp) {
  window.requestAnimationFrame(animateBus);
  if (!state.map || !state.corridor) return;
  if (!state.playing) {
    state.lastFrame = timestamp;
    return;
  }
  if (state.lastFrame === null) {
    state.lastFrame = timestamp;
    updateHudPosition(timestamp);
    return;
  }
  const deltaSeconds = Math.min((timestamp - state.lastFrame) / 1000, 0.25);
  state.lastFrame = timestamp;
  const located = locateBus(state.busProgressKm);
  if (!located) return;
  const speed = liveSpeedFor(located.segment);
  state.busProgressKm += (speed / 60) * deltaSeconds;
  if (state.busProgressKm >= state.routeTotalKm) {
    state.busProgressKm = 0;
    state.lastHudTs = 0;
  }
  updateHudPosition(timestamp);
}

function togglePlayback() {
  state.playing = !state.playing;
  state.lastFrame = null;
  dom.playToggle.classList.toggle("is-paused", !state.playing);
  dom.playToggle.setAttribute("aria-pressed", String(state.playing));
  dom.playLabel.textContent = state.playing ? "Pause animation" : "Resume animation";
  dom.hudState.textContent = state.playing ? "TRACKING" : "PAUSED";
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  state.simulation = { ...preset };
  syncControlsFromState();
  setPresetSelection(name);
  scheduleSimulation(40);
  showToast(`Scenario loaded: ${dom.presetButtons.find((button) => button.dataset.preset === name)?.textContent || name}`, false);
}

function switchView(view) {
  dom.tabs.forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  Object.entries(dom.views).forEach(([key, element]) => {
    element.classList.toggle("is-active", key === view);
  });
  dom.footerMode.textContent =
    view === "live" ? "Live simulation · FastAPI + scikit-learn" : "Evaluator audit · frozen artifacts + validation proof";
  document.body.classList.toggle("is-evaluator", view === "evaluator");
  if (view === "live" && state.map) {
    window.setTimeout(() => state.map.invalidateSize(), 120);
  }
}

function bindEvents() {
  dom.tabs.forEach((tab) => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });

  dom.timeSlider.addEventListener("input", () => {
    state.simulation.hour_of_day = Number(dom.timeSlider.value);
    clearPresetSelection();
    updateRangeFill(dom.timeSlider);
    updateControlLabels();
    scheduleSimulation();
  });

  dom.weatherButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.simulation.weather_severity = Number(button.dataset.weather);
      clearPresetSelection();
      dom.weatherButtons.forEach((item) => item.classList.toggle("is-active", item === button));
      updateControlLabels();
      scheduleSimulation();
    });
  });

  dom.lagSlider.addEventListener("input", () => {
    state.simulation.rolling_3trip_delay_min = Number(dom.lagSlider.value);
    clearPresetSelection();
    updateRangeFill(dom.lagSlider);
    updateControlLabels();
    scheduleSimulation();
  });

  dom.dwellSlider.addEventListener("input", () => {
    state.simulation.prev_stop_dwell_sec = Number(dom.dwellSlider.value);
    clearPresetSelection();
    updateRangeFill(dom.dwellSlider);
    updateControlLabels();
    scheduleSimulation();
  });

  dom.speedSlider.addEventListener("input", () => {
    state.simulation.gps_speed_kmh = Number(dom.speedSlider.value);
    clearPresetSelection();
    updateRangeFill(dom.speedSlider);
    updateControlLabels();
    scheduleSimulation();
  });

  dom.presetButtons.forEach((button) => {
    button.addEventListener("click", () => applyPreset(button.dataset.preset));
  });

  dom.playToggle.addEventListener("click", togglePlayback);

  dom.recenterMap.addEventListener("click", () => {
    if (!state.map || !state.corridor) return;
    state.map.fitBounds(
      state.corridor.stops.map((stop) => [stop.lat, stop.lon]),
      { paddingTopLeft: [46, 46], paddingBottomRight: [46, 190], maxZoom: 13 }
    );
  });

  dom.segmentList.addEventListener("click", (event) => {
    const item = event.target.closest("[data-segment-id]");
    if (!item) return;
    selectSegment(Number(item.dataset.segmentId), true);
  });

  window.addEventListener("resize", () => {
    if (state.map) state.map.invalidateSize();
  });
}

function renderDiagnostics(data) {
  const metadata = data.model_metadata || {};
  const audit = data.dq_audit_report || {};
  const metrics = metadata.metrics || {};
  const summary = audit.summary || {};
  const verification = data.verification || {};
  const passed = Boolean(verification.passed && audit.passed);

  dom.evalBadge.textContent = passed ? "All gates passed · artifacts frozen" : "Review required";
  dom.evalBadge.style.color = passed ? "" : "var(--red)";

  const cards = [
    {
      label: "Model MAE",
      value: Number(metrics.reg_mae ?? 0).toFixed(3),
      unit: "min",
      note: `Naive baseline ${Number(metrics.baseline_mae ?? 0).toFixed(3)} min`,
      cls: "is-positive",
    },
    {
      label: "Error Reduction",
      value: Number(metrics.error_reduction_pct ?? 0).toFixed(2),
      unit: "%",
      note: "Lower error than baseline",
      cls: "is-positive",
    },
    {
      label: "R² Score",
      value: Number(metrics.reg_r2 ?? 0).toFixed(3),
      unit: "",
      note: "Held-out future window",
      cls: "is-accent",
    },
    {
      label: "Classifier Accuracy",
      value: (Number(metrics.clf_accuracy ?? 0) * 100).toFixed(1),
      unit: "%",
      note: `Macro F1 ${(Number(metrics.clf_macro_f1 ?? 0) * 100).toFixed(1)}%`,
      cls: "is-positive",
    },
    {
      label: "Data Retention",
      value: Number(summary.retention_rate_pct ?? 0).toFixed(2),
      unit: "%",
      note: `${Number(summary.clean_records ?? 0).toLocaleString("en-US")} clean rows`,
      cls: "is-accent",
    },
    {
      label: "Peak Interval",
      value: Number(metadata.uncertainty?.peak_hour_interval_width ?? 0).toFixed(2),
      unit: "min",
      note: "80% quantile width",
      cls: "is-warning",
    },
  ];

  dom.metricGrid.innerHTML = cards
    .map(
      (card) => `
        <article class="metric-card ${card.cls}">
          <span>${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(card.value)}${card.unit ? `<small>${escapeHtml(card.unit)}</small>` : ""}</strong>
          <small>${escapeHtml(card.note)}</small>
        </article>
      `
    )
    .join("");

  dom.retentionTag.textContent = `${Number(summary.retention_rate_pct ?? 0).toFixed(2)}% retention`;
  const rawRecords = Number(summary.raw_records ?? 4800);
  const funnel = audit.cleaning_funnel || [];
  dom.dqFunnel.innerHTML = funnel
    .map((row) => {
      const records = Number(row.records ?? 0);
      const width = clamp((records / rawRecords) * 100, 20, 100);
      const delta = Number(row.delta ?? 0);
      const deltaText = delta === 0 ? (row.imputed ? `${row.imputed} imputed` : "—") : `${delta}`;
      const deltaClass = delta < 0 ? "is-drop" : "is-pass";
      return `
        <div class="funnel-row">
          <span class="funnel-label">${escapeHtml(row.stage)}</span>
          <span class="funnel-bar-wrap"><i class="funnel-bar" style="width:${width}%">${records.toLocaleString("en-US")}</i></span>
          <span class="funnel-delta ${deltaClass}">${escapeHtml(deltaText)}</span>
        </div>
      `;
    })
    .join("");

  const gates = audit.gates || [];
  dom.dqGates.innerHTML = gates
    .map((gate) => {
      const dropped = Number(gate.dropped_records ?? 0);
      const imputed = Number(gate.imputed_records ?? 0);
      const detail = imputed > 0 ? `${imputed} packets imputed` : `${dropped} dropped`;
      return `
        <div class="dq-gate">
          <div class="dq-gate-top">
            <strong>${escapeHtml(gate.name)}</strong>
            <span>${escapeHtml((gate.status || "passed").toUpperCase())}</span>
          </div>
          <p>${escapeHtml(gate.description)} <b>${escapeHtml(detail)}</b> → ${Number(gate.output_records ?? 0).toLocaleString("en-US")} rows.</p>
        </div>
      `;
    })
    .join("");

  const importances = Object.entries(metadata.feature_importances || {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 8);
  const maxImportance = Math.max(...importances.map((entry) => Number(entry[1])), 0.01);
  dom.featureImportance.innerHTML = importances
    .map(
      ([name, value]) => `
        <div class="importance-row">
          <span class="importance-label">${escapeHtml(name)}</span>
          <span class="importance-track"><i style="width:${(Number(value) / maxImportance) * 100}%"></i></span>
          <span class="importance-value">${(Number(value) * 100).toFixed(1)}%</span>
        </div>
      `
    )
    .join("");

  const offPeak = Number(metadata.uncertainty?.off_peak_interval_width ?? 0);
  const peak = Number(metadata.uncertainty?.peak_hour_interval_width ?? 0);
  const peakRatio = offPeak > 0 ? peak / offPeak : 0;
  dom.uncertaintyVisual.innerHTML = `
    <div class="uncertainty-row">
      <span>Off-Peak</span>
      <div class="uncertainty-track"><i style="width:${clamp((offPeak / Math.max(peak, 0.01)) * 100, 4, 100)}%"></i></div>
      <strong>${offPeak.toFixed(3)} min</strong>
    </div>
    <div class="uncertainty-row peak">
      <span>Peak</span>
      <div class="uncertainty-track"><i style="width:100%"></i></div>
      <strong>${peak.toFixed(3)} min</strong>
    </div>
  `;
  dom.uncertaintyNote.textContent = `Peak-hour prediction intervals are ${peakRatio.toFixed(1)}× wider than off-peak. The rider card switches to the 80% quantile range whenever confidence drops.`;

  if (data.plots?.length) {
    const plot = data.plots[0];
    dom.diagnosticPlot.src = plot.url;
    dom.plotLink.href = plot.url;
    dom.diagnosticCaption.textContent = plot.caption;
  }

  const artifacts = data.artifacts || [];
  dom.artifactCount.textContent = `${artifacts.length} artifacts`;
  dom.artifactTable.innerHTML = artifacts
    .map(
      (artifact) => `
        <tr>
          <td><span class="artifact-name">${escapeHtml(artifact.file)}<small>${escapeHtml(artifact.name)}</small></span></td>
          <td>${escapeHtml(formatBytes(artifact.size_bytes))}</td>
          <td class="artifact-hash" title="${escapeHtml(artifact.sha256)}">${escapeHtml(String(artifact.sha256).slice(0, 16))}…</td>
          <td><span class="artifact-ok">✓ VERIFIED</span></td>
        </tr>
      `
    )
    .join("");

  const runtime = data.runtime || {};
  const runtimeItems = [
    ["Backend", runtime.backend || "FastAPI"],
    ["Regressor", runtime.regressor || "RandomForestRegressor"],
    ["Uncertainty", runtime.uncertainty || "Quantile regressors"],
    ["Features", String(runtime.feature_count ?? 12)],
    ["Quality gates", runtime.quality_gates_passed ? "PASSED" : "FAILED"],
    ["Artifact freeze", runtime.artifacts_passed ? "PASSED" : "FAILED"],
    ["Service state", String(runtime.status || "online").toUpperCase()],
    ["Diagnostics", new Date(runtime.generated_at || Date.now()).toLocaleTimeString("en-IN", { hour12: false })],
  ];
  dom.diagRuntime.innerHTML = runtimeItems
    .map(
      ([label, value]) => `
        <div class="runtime-item">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `
    )
    .join("");
}

async function loadDiagnostics() {
  try {
    const data = await fetchJson("/api/diagnostics");
    state.diagnostics = data;
    renderDiagnostics(data);
  } catch (error) {
    dom.evalBadge.textContent = "Diagnostics unavailable";
    dom.evalBadge.style.color = "var(--red)";
    dom.diagRuntime.innerHTML = '<div class="runtime-item"><span>Service state</span><strong>OFFLINE</strong></div>';
    showToast("Diagnostics endpoint unavailable.", true);
  }
}

async function init() {
  startClock();
  bindEvents();
  syncControlsFromState();
  [dom.timeSlider, dom.lagSlider, dom.dwellSlider, dom.speedSlider].forEach(updateRangeFill);
  if (new URLSearchParams(window.location.search).get("view") === "evaluator") {
    switchView("evaluator");
  }

  try {
    const corridor = await fetchJson("/api/corridor");
    state.corridor = corridor;
    initMap(corridor);
  } catch (error) {
    setSyncState("error", "Corridor offline");
    showToast("Could not load the NH-44 corridor from the backend.", true);
    return;
  }

  loadDiagnostics();
  await runSimulation();
  window.requestAnimationFrame(animateBus);
}

init();
