/* TransitPulse — dashboard controller (theme v2 "Departures").
   Based on source/web/app.js: same API calls, presets, state and render flow.
   Changes: theme handling, one consistent ETA story, map decluttering, phone sheet,
   split-flap numerals, and an in-browser stand-in when the FastAPI backend is unreachable. */

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const SHOT = params.has("shot");
if (SHOT) document.documentElement.classList.add("is-shot");

const dom = {
  clock: $("live-clock"), syncPill: $("sync-pill"), syncLabel: $("sync-label"),
  views: { live: $("view-live"), evaluator: $("view-evaluator") },
  tabs: Array.from(document.querySelectorAll(".view-tab")),
  footerMode: $("footer-mode"), themeToggle: $("theme-toggle"),
  statDelay: $("stat-delay"), statDelayFoot: $("stat-delay-foot"),
  statConfidence: $("stat-confidence"), statConfidenceFoot: $("stat-confidence-foot"),
  statEta: $("stat-eta"), statEtaFoot: $("stat-eta-foot"),
  statStatus: $("stat-status"), statStatusDot: $("stat-status-dot"), statStatusFoot: $("stat-status-foot"),
  countOnTime: $("count-on-time"), countModerate: $("count-moderate"), countSevere: $("count-severe"),
  etaCard: $("eta-card"), peakAlert: $("peak-alert"), etaTitle: $("eta-title"), confidenceBadge: $("confidence-badge"),
  etaKicker: $("eta-kicker"), etaValue: $("eta-value"), etaStatus: $("eta-status"), etaMeta: $("eta-meta"),
  etaRange: $("eta-range"), etaRangeValue: $("eta-range-value"), rangeBar: $("range-bar"), rangeSched: $("range-sched"), rangeMax: $("range-max"),
  recommendation: $("recommendation"), etaSegmentName: $("eta-segment-name"), etaClassifier: $("eta-classifier"), etaWindow: $("eta-window"), etaLeave: $("eta-leave"),
  xaiSegment: $("xai-segment"), xaiBars: $("xai-bars"), xaiBaseline: $("xai-baseline"), xaiSum: $("xai-sum"),
  segmentList: $("segment-list"),
  timeSlider: $("time-slider"), timeValue: $("time-value"), peakFlag: $("peak-flag"), weatherValue: $("weather-value"),
  walkSlider: $("walk-slider"), walkValue: $("walk-value"),
  weatherButtons: Array.from(document.querySelectorAll(".weather-btn")),
  lagSlider: $("lag-slider"), lagValue: $("lag-value"), dwellSlider: $("dwell-slider"), dwellValue: $("dwell-value"),
  speedSlider: $("speed-slider"), speedValue: $("speed-value"),
  presetButtons: Array.from(document.querySelectorAll(".preset-btn")),
  playToggle: $("play-toggle"), playLabel: $("play-label"), recenterMap: $("recenter-map"),
  controls: $("controls"), sheetToggle: $("sheet-toggle"), sheetSummary: $("sheet-summary"), sheetBackdrop: $("sheet-backdrop"),
  mapEl: $("map"), mapWrap: $("map-wrap"), mapFallback: $("map-fallback"),
  hudState: $("hud-state"), hudLat: $("hud-lat"), hudLon: $("hud-lon"), hudSpeed: $("hud-speed"), hudNextStop: $("hud-next-stop"),
  hudProgressValue: $("hud-progress-value"), hudProgressBar: $("hud-progress-bar"),
  toast: $("toast"), standinBanner: $("standin-banner"),
  evalBadge: $("eval-badge"), verdict: $("verification-summary"), retentionTag: $("retention-tag"), metricGrid: $("metric-grid"),
  dqFunnel: $("dq-funnel"), dqGates: $("dq-gates"), featureImportance: $("feature-importance"),
  uncertaintyVisual: $("uncertainty-visual"), uncertaintyNote: $("uncertainty-note"),
  diagnosticPlot: $("diagnostic-plot"), plotFrame: $("plot-frame"), plotLink: $("plot-link"), diagnosticCaption: $("diagnostic-caption"),
  artifactCount: $("artifact-count"), artifactTable: $("artifact-table"), diagRuntime: $("diag-runtime"),
};

const WEATHER_LABELS = ["Clear", "Light rain / fog", "Heavy downpour"];
const WEATHER_SHORT = ["Clear", "Light rain", "Heavy rain"];
const BUS_ID = "PB08-BUS-101";
const SHORT_NAMES = { "Jalandhar Bus Stand": "Jalandhar BS", "Phagwara Bus Stand": "Phagwara BS", "LPU Main Gate": "LPU Gate", "Haveli Corridor": "Haveli" };
/* Preferred label side per stop; the declutter pass tries the others if this one collides. */
const LABEL_SIDES = { 0: "left", 1: "bottom", 2: "top", 3: "right", 4: "left", 5: "bottom" };

const PRESETS = {
  midday: { hour_of_day: 13, is_weekend: false, weather_severity: 0, rolling_3trip_delay_min: 0.5, prev_stop_dwell_sec: 30, gps_speed_kmh: 34 },
  rush: { hour_of_day: 8, is_weekend: false, weather_severity: 1, rolling_3trip_delay_min: 6.5, prev_stop_dwell_sec: 85, gps_speed_kmh: 18 },
  evening: { hour_of_day: 18, is_weekend: false, weather_severity: 0, rolling_3trip_delay_min: 14, prev_stop_dwell_sec: 115, gps_speed_kmh: 10 },
};
const PRESET_LABELS = { midday: "Midday Clear", rush: "Morning Rush + Rain", evening: "Evening Gridlock" };

const startPreset = PRESETS[params.get("preset")] ? params.get("preset") : "midday";
const state = {
  corridor: null, result: null, diagnostics: null,
  simulation: { ...PRESETS[startPreset], walk_time_min: 5 }, activePreset: startPreset,
  selectedSegmentId: Number(params.get("seg")) || 1,
  playing: !SHOT && params.get("paused") !== "1",
  requestSeq: 0, debounceTimer: null, toastTimer: null,
  map: null, busMarker: null, segmentLayers: {}, stopMarkers: [], tileLayers: [],
  routeTotalKm: 0, busProgressKm: Number(params.get("km") ?? 0), lastFrame: null, lastHudTs: 0, lastDeclutter: 0,
  standin: false, tilesFailed: false, tileErrors: 0,
};

/* ---------------------------------------------------------------- helpers */
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function isPeakHour(hour) { return (hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 19); }
/* Signed number with a real minus sign; 0 stays unsigned. */
function signed(value, digits = 1) {
  const n = Number(Number(value).toFixed(digits));
  if (n === 0) return (0).toFixed(digits);
  return n > 0 ? `+${n.toFixed(digits)}` : `−${Math.abs(n).toFixed(digits)}`;
}
function statusClass(status) { return status === "Severe Delay" ? "severe" : status === "Moderate Delay" ? "moderate" : "ontime"; }
function statusText(status) { return status === "Severe Delay" ? "Severe delay" : status === "Moderate Delay" ? "Moderate delay" : "On time"; }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function statusColor(status) { return cssVar(`--${statusClass(status)}`); }
function shortName(name) { return SHORT_NAMES[name] || name; }
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}
function routeName(name) { return String(name).replace("->", "→"); }

function setSyncState(kind, label) {
  dom.syncPill.dataset.state = kind;
  dom.syncLabel.textContent = label;
  dom.syncPill.title = label;
}
function showToast(message, isError = false) {
  if (SHOT) return;
  dom.toast.textContent = message;
  dom.toast.classList.toggle("is-error", isError);
  dom.toast.classList.add("is-visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => dom.toast.classList.remove("is-visible"), 3200);
}

/* ---------------------------------------------------------------- API (real backend first, stand-in second)
   Paths are root-relative (no scheme or host) so the same page works on any host. */
function apiPath(url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) {
    throw new Error("API calls must be relative");
  }
  return url.startsWith("/") ? url : `/${url}`;
}
async function fetchJson(url, options = {}) {
  const response = await fetch(apiPath(url), { headers: { "Content-Type": "application/json" }, ...options });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}
const FORCE_STANDIN = window.location.protocol === "file:" || params.has("standin");
function activateStandin() {
  state.standin = true;
  if (dom.standinBanner) dom.standinBanner.dataset.mode = "standin";
  dom.syncPill.title = "Stand-in fallback: in-browser heuristic, not the trained model.";
  dom.footerMode.textContent = "Stand-in model · runs in your browser, not the trained model";
}
async function api(url, options = {}) {
  const path = apiPath(url);
  if (!FORCE_STANDIN && !state.standin) {
    try {
      const data = await fetchJson(path, options);
      if (dom.standinBanner && dom.standinBanner.dataset.mode === "pending") dom.standinBanner.dataset.mode = "live";
      return data;
    }
    catch (error) { if (!window.TPStandIn) throw error; }
  }
  if (!window.TPStandIn) throw new Error("No backend and no stand-in");
  activateStandin();
  const S = window.TPStandIn;
  if (path.startsWith("/api/corridor")) return S.corridor();
  if (path.startsWith("/api/simulate")) return S.simulate(JSON.parse(options.body || "{}"));
  if (path.startsWith("/api/diagnostics")) return S.diagnostics();
  throw new Error(`Stand-in has no route for ${path}`);
}
const okLabel = () => (state.standin ? "Stand-in fallback" : "Model link active");

/* ---------------------------------------------------------------- theme */
function currentTheme() { return document.documentElement.dataset.theme === "dark" ? "dark" : "light"; }
function applyThemeChrome() {
  const dark = currentTheme() === "dark";
  dom.themeToggle.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  $("meta-theme-color").setAttribute("content", dark ? "#0F1012" : "#F3F1EC");
}
function setTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  if (persist) { try { localStorage.setItem("tp-theme", theme); } catch (e) { /* private mode */ } }
  applyThemeChrome();
  updateBaseTiles();
  if (state.result) updateMapSegments(state.result.segments);
  renderFallback();
}
function bindTheme() {
  applyThemeChrome();
  dom.themeToggle.addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark"));
  /* Follow the OS only while the user hasn't made a choice. */
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    let saved = null; try { saved = localStorage.getItem("tp-theme"); } catch (err) {}
    if (!saved && !params.get("theme")) setTheme(e.matches ? "dark" : "light", false);
  });
}

/* ---------------------------------------------------------------- split-flap numerals */
function setFlap(el, text) {
  const next = String(text);
  if (el.dataset.text === next) return;
  const prev = el.dataset.text ?? "";
  el.dataset.text = next;
  /* aria-label is not allowed on a plain <span>; the flap is aria-hidden and the value goes to #<id>-sr. */
  el.setAttribute("aria-hidden", "true");
  const sr = document.getElementById(`${el.id}-sr`);
  if (sr) sr.textContent = next.replace("–", " to ");
  const isTile = (ch) => /[0-9A-Z]/.test(ch);
  const chars = Array.from(next);
  const same = prev.length === next.length && el.children.length === chars.length;
  if (!same) {
    el.innerHTML = chars.map((ch) => `<span class="${isTile(ch) ? "fc" : "fp"}" aria-hidden="true">${escapeHtml(ch)}</span>`).join("");
    if (prev && !reducedMotion() && !SHOT) Array.from(el.children).forEach((c) => c.classList.contains("fc") && flip(c, c.textContent));
    return;
  }
  chars.forEach((ch, i) => {
    const c = el.children[i];
    if (c.textContent === ch) return;
    if (reducedMotion() || SHOT || !c.classList.contains("fc")) { c.textContent = ch; return; }
    flip(c, ch);
  });
}
function flip(cell, ch) {
  cell.classList.remove("is-flipping");
  void cell.offsetWidth;
  cell.classList.add("is-flipping");
  window.setTimeout(() => { cell.textContent = ch; }, 115);
  window.setTimeout(() => cell.classList.remove("is-flipping"), 280);
}

/* ---------------------------------------------------------------- clock */
function startClock() {
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const tick = () => { dom.clock.textContent = formatter.format(new Date()); };
  tick();
  window.setInterval(tick, 1000);
}

/* ---------------------------------------------------------------- controls */
function updateRangeFill(input) {
  const min = Number(input.min), max = Number(input.max), value = Number(input.value);
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty("--fill", `${clamp(percent, 0, 100)}%`);
}
function updateControlLabels() {
  const s = state.simulation;
  const hour = Number(s.hour_of_day);
  const peak = isPeakHour(hour);
  dom.timeValue.textContent = `${String(hour).padStart(2, "0")}:00`;
  dom.peakFlag.textContent = peak ? "Peak" : "Off-peak";
  dom.peakFlag.classList.toggle("is-peak", peak);
  dom.weatherValue.textContent = WEATHER_LABELS[s.weather_severity];
  dom.lagValue.textContent = Number(s.rolling_3trip_delay_min).toFixed(1);
  dom.dwellValue.textContent = String(Math.round(s.prev_stop_dwell_sec));
  dom.speedValue.textContent = String(Math.round(s.gps_speed_kmh));
  if (dom.walkValue) dom.walkValue.textContent = String(Math.round(s.walk_time_min ?? 5));
  const preset = state.activePreset ? PRESET_LABELS[state.activePreset] : "Custom";
  dom.sheetSummary.textContent = `${preset} · ${String(hour).padStart(2, "0")}:00`;
}
function syncControlsFromState() {
  dom.timeSlider.value = String(state.simulation.hour_of_day);
  dom.lagSlider.value = String(state.simulation.rolling_3trip_delay_min);
  dom.dwellSlider.value = String(state.simulation.prev_stop_dwell_sec);
  dom.speedSlider.value = String(state.simulation.gps_speed_kmh);
  if (dom.walkSlider) dom.walkSlider.value = String(state.simulation.walk_time_min ?? 5);
  dom.weatherButtons.forEach((b) => {
    const on = Number(b.dataset.weather) === state.simulation.weather_severity;
    b.classList.toggle("is-active", on); b.setAttribute("aria-pressed", String(on));
  });
  [dom.timeSlider, dom.lagSlider, dom.dwellSlider, dom.speedSlider, dom.walkSlider].filter(Boolean).forEach(updateRangeFill);
  setPresetSelection(state.activePreset);
  updateControlLabels();
}
function setPresetSelection(name) {
  state.activePreset = name;
  dom.presetButtons.forEach((b) => {
    const on = b.dataset.preset === name;
    b.classList.toggle("is-active", on); b.setAttribute("aria-pressed", String(on));
  });
}
function clearPresetSelection() { setPresetSelection(null); }
function scheduleSimulation(delay = 140) {
  window.clearTimeout(state.debounceTimer);
  state.debounceTimer = window.setTimeout(runSimulation, delay);
}
async function runSimulation() {
  const sequence = ++state.requestSeq;
  setSyncState("busy", "Running inference");
  try {
    const result = await api("/api/simulate", { method: "POST", body: JSON.stringify(state.simulation) });
    if (sequence !== state.requestSeq) return;
    state.result = result;
    state.lastResultAt = new Date();
    applySimulation(result);
    if (navigator.onLine === false || FORCED_STATE === "offline") goOffline(); else setSyncState(state.standin ? "standin" : "ok", okLabel());
  } catch (error) {
    if (sequence !== state.requestSeq) return;
    setSyncState("error", "Inference offline");
    showToast("Live inference failed. Check the FastAPI server.", true);
  }
}
function applySimulation(result) {
  if (!result.segments.some((s) => s.segment_id === state.selectedSegmentId)) state.selectedSegmentId = result.segments[0]?.segment_id ?? 1;
  updateMapSegments(result.segments);
  renderStats();
  renderSegmentList();
  renderRiderCard();
  renderXai();
  renderFallback();
}
function getSelectedSegment() {
  if (!state.result) return null;
  return state.result.segments.find((s) => s.segment_id === state.selectedSegmentId) || state.result.segments[0] || null;
}
function getSegmentById(id) { return state.result?.segments.find((s) => s.segment_id === id) || null; }

/* ---------------------------------------------------------------- the ETA story
   One number everywhere: minutes until the bus reaches the end stop of the selected segment
   (estimated_segment_time_min). Early/late is a signed delta against the schedule — never a negative ETA.
   When the model flags low confidence the ETA becomes the 80% window (schedule + quantile bounds). */
function etaStory(segment) {
  const sched = Number(segment.scheduled_time_min);
  const delay = Number(segment.predicted_delay_min);
  const eta = Number(segment.estimated_segment_time_min ?? sched + Math.max(delay, 0));
  const lo = Math.max(sched + Number(segment.lower_bound_min), 0.5);
  const hi = Math.max(sched + Number(segment.upper_bound_min), lo + 0.1);
  const low = Boolean(segment.is_low_confidence);
  let phrase;
  if (Math.abs(delay) < 0.5) phrase = "On schedule";
  else if (delay < 0) phrase = `${Math.abs(delay).toFixed(1)} min early`;
  else phrase = `${delay.toFixed(1)} min late`;
  return {
    sched, delay, eta, lo, hi, low, phrase,
    flap: low ? `${Math.floor(lo)}–${Math.ceil(hi)}` : eta.toFixed(1),
  };
}

function recommendationFor(segment) {
  if (!segment || !state.result) return "Select a segment to inspect live rider guidance.";
  const weather = state.result.simulation.weather_severity;
  if (segment.delay_status === "Severe Delay") return "Allow 15+ extra minutes or board the next service. The live arrival window is expanding.";
  if (segment.delay_status === "Moderate Delay") {
    if (weather > 0) return "Carry a weather buffer and watch the live window; wet-weather boarding is slowing this segment.";
    if (segment.is_peak_hour) return "Prefer the next departure if connecting; peak demand is extending the arrival window.";
    return "Running slightly behind schedule. The current arrival window is still usable.";
  }
  if (weather > 0) return "Bus is close to schedule. Keep a small weather buffer for the final approach.";
  if (segment.is_peak_hour) return "Board now; the bus is tracking within the on-time band despite peak volumes.";
  return "On-time service. No action needed; keep an eye on the live telemetry.";
}

/* ---------------------------------------------------------------- renderers */
function renderStats() {
  if (!state.result) return;
  const corridor = state.result.corridor;
  const selected = getSelectedSegment();
  dom.statDelay.textContent = signed(corridor.total_predicted_delay_min);
  dom.statDelayFoot.innerHTML = `<b>${Number(corridor.estimated_trip_time_min).toFixed(1)}</b> min trip · ${Number(corridor.scheduled_time_min).toFixed(1)} scheduled`;
  dom.statConfidence.textContent = Number(corridor.confidence_pct).toFixed(0);
  dom.statConfidenceFoot.textContent = corridor.is_low_confidence
    ? `${corridor.low_confidence_segments} low-confidence segment${corridor.low_confidence_segments === 1 ? "" : "s"}`
    : "80% quantile envelope";
  if (selected) {
    const story = etaStory(selected);
    setFlap(dom.statEta, story.flap);
    dom.statEtaFoot.innerHTML = `To <b>${escapeHtml(selected.end_stop)}</b> · ${story.phrase.toLowerCase()}`;
  }
  const cls = statusClass(corridor.delay_status);
  dom.statStatus.textContent = statusText(corridor.delay_status);
  dom.statStatus.style.color = `var(--${cls})`;
  dom.statStatusDot.style.background = `var(--${cls})`;
  dom.statStatusFoot.textContent = `Classifier · ${corridor.low_confidence_segments} uncertainty trigger${corridor.low_confidence_segments === 1 ? "" : "s"}`;

  const counts = { "On-Time": 0, "Moderate Delay": 0, "Severe Delay": 0 };
  state.result.segments.forEach((s) => { counts[s.delay_status] += 1; });
  dom.countOnTime.textContent = String(counts["On-Time"]);
  dom.countModerate.textContent = String(counts["Moderate Delay"]);
  dom.countSevere.textContent = String(counts["Severe Delay"]);
}

function renderRiderCard() {
  const segment = getSelectedSegment();
  if (!segment || !state.result) return;
  const story = etaStory(segment);
  const confidence = Number(segment.confidence_pct);
  const badgeClass = confidence >= 70 ? "is-high" : confidence >= 55 ? "is-low" : "is-critical";
  const cls = statusClass(segment.delay_status);

  dom.peakAlert.hidden = !story.low;
  dom.peakAlert.classList.toggle("is-critical", story.low && (confidence < 55 || segment.delay_status === "Severe Delay"));
  dom.etaTitle.textContent = segment.end_stop;
  dom.confidenceBadge.className = `badge ${badgeClass}`;
  dom.confidenceBadge.textContent = `${confidence.toFixed(0)}% confidence`;

  dom.etaKicker.textContent = story.low ? "Arrives within (80% window)" : "Arrives in";
  setFlap(dom.etaValue, story.flap);
  dom.etaStatus.className = `status-chip ${cls}`;
  dom.etaStatus.textContent = statusText(segment.delay_status);
  dom.etaMeta.innerHTML = `<b>${signed(story.delay)} min</b> vs schedule · scheduled <b>${story.sched.toFixed(1)}</b> min`;

  dom.etaRange.hidden = !story.low;
  if (story.low) {
    const max = Math.max(Math.ceil(story.hi / 5) * 5, 10);
    dom.etaRangeValue.textContent = `${story.lo.toFixed(1)}–${story.hi.toFixed(1)} min`;
    dom.rangeBar.style.left = `${(story.lo / max) * 100}%`;
    dom.rangeBar.style.width = `${((story.hi - story.lo) / max) * 100}%`;
    dom.rangeBar.style.background = `var(--${cls === "ontime" ? "moderate" : cls})`;
    dom.rangeSched.style.left = `calc(${(story.sched / max) * 100}% - 1px)`;
    dom.rangeSched.title = `Scheduled ${story.sched.toFixed(1)} min`;
    dom.rangeMax.textContent = `${max} min`;
  }
  dom.recommendation.textContent = recommendationFor(segment);
  dom.etaSegmentName.textContent = routeName(segment.name);
  dom.etaClassifier.textContent = `${statusText(segment.delay_status)} · ${Number(segment.status_probability_pct).toFixed(0)}%`;
  dom.etaWindow.textContent = `${signed(segment.lower_bound_min)} to ${signed(segment.upper_bound_min)} min`;
  if (dom.etaLeave) {
    const leave = Number(segment.leave_by_min);
    const walk = Number(state.simulation.walk_time_min ?? segment.walk_time_min ?? 5);
    const start = Number(segment.window_start_min);
    dom.etaLeave.textContent = Number.isFinite(leave) ? (leave > 0.05 ? `In ${leave.toFixed(1)} min` : "Now") : "--";
    dom.etaLeave.title = Number.isFinite(start)
      ? `Window starts in ${start.toFixed(1)} min, minus a ${walk.toFixed(0)} min walk`
      : "Window start minus walk time";
  }
}

function renderXai() {
  const segment = getSelectedSegment();
  if (!segment) return;
  const drivers = segment.xai_drivers || [];
  const maxMagnitude = Math.max(...drivers.map((d) => Math.abs(Number(d.minutes))), 0.5);
  dom.xaiSegment.textContent = `SEG ${String(segment.segment_id).padStart(2, "0")}`;
  dom.xaiBars.innerHTML = drivers.map((d) => {
    const m = Number(d.minutes);
    const w = Math.abs(m) < 0.005 ? 0 : clamp((Math.abs(m) / maxMagnitude) * 100, 3, 100);
    const neg = m < 0;
    return `<div class="xai-row" role="listitem">
        <span class="xai-label">${escapeHtml(d.label)}</span>
        <span class="xai-track" aria-hidden="true"><span class="neg"><i style="width:${neg ? w : 0}%"></i></span><span class="pos"><i style="width:${neg ? 0 : w}%"></i></span></span>
        <span class="xai-value${neg ? " is-neg" : ""}">${signed(m)}m</span>
      </div>`;
  }).join("");
  dom.xaiBaseline.textContent = `${signed(segment.xai_baseline_min)} min`;
  dom.xaiSum.innerHTML = `<span>Baseline + factors = predicted delay</span><b>${signed(segment.predicted_delay_min)} min</b>`;
}

function renderSegmentList() {
  if (!state.result) return;
  dom.segmentList.innerHTML = state.result.segments.map((s) => {
    const cls = statusClass(s.delay_status);
    const story = etaStory(s);
    const sel = s.segment_id === state.selectedSegmentId ? " is-selected" : "";
    const id = `SEG ${String(s.segment_id).padStart(2, "0")}`;
    const d = Number(s.predicted_delay_min);
    const dcls = d >= 5 ? "is-severe" : d >= 2 ? "is-late" : d <= -0.5 ? "is-early" : "";
    const etaText = story.low ? `${story.lo.toFixed(0)}–${story.hi.toFixed(0)}` : story.eta.toFixed(1);
    return `<button class="seg-row seg-item${sel}" data-segment-id="${s.segment_id}" type="button" aria-pressed="${sel ? "true" : "false"}">
        <span class="seg-id">${id}</span>
        <span class="seg-name"><strong data-id="${id}">${escapeHtml(shortName(s.start_stop))} → ${escapeHtml(shortName(s.end_stop))}</strong><small>${Number(s.distance_km).toFixed(1)} km</small></span>
        <span class="seg-num">${Number(s.scheduled_time_min).toFixed(1)}</span>
        <span class="seg-num is-strong">${etaText}</span>
        <span class="seg-num seg-delay ${dcls}">${signed(d)}</span>
        <span class="seg-window">${signed(s.lower_bound_min)} to ${signed(s.upper_bound_min)}</span>
        <span class="seg-nums"><span>Sched <b>${Number(s.scheduled_time_min).toFixed(1)}</b></span><span>ETA <b>${etaText}</b> min</span><span>Delay <b class="seg-delay ${dcls}">${signed(d)}</b></span><span>80% <b>${signed(s.lower_bound_min)}…${signed(s.upper_bound_min)}</b></span></span>
        <span class="seg-badge"><span class="status-chip ${cls}">${statusText(s.delay_status)}</span></span>
        <span class="seg-conf"><span class="track"><i style="width:${clamp(s.confidence_pct, 4, 100)}%"></i></span><span>${Number(s.confidence_pct).toFixed(0)}%</span></span>
      </button>`;
  }).join("");
}

function selectSegment(segmentId, pan = false) {
  if (!getSegmentById(segmentId)) return;
  state.selectedSegmentId = segmentId;
  dom.segmentList.querySelectorAll(".seg-item").forEach((item) => {
    const on = Number(item.dataset.segmentId) === segmentId;
    item.classList.toggle("is-selected", on); item.setAttribute("aria-pressed", String(on));
  });
  renderStats(); renderRiderCard(); renderXai();
  if (state.result) updateMapSegments(state.result.segments);
  renderFallback();
  if (pan && state.map && !state.tilesFailed) {
    const s = getSegmentById(segmentId);
    state.map.panTo([(s.start_lat + s.end_lat) / 2, (s.start_lon + s.end_lon) / 2], { animate: !reducedMotion(), duration: 0.45 });
  }
}

/* ---------------------------------------------------------------- map */
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/";
function tileUrls() {
  const dark = currentTheme() === "dark";
  if (params.get("tiles") === "off") return { base: "https://invalid.example/{z}/{x}/{y}.png", ref: null };
  return {
    base: `${ESRI}${dark ? "World_Dark_Gray_Base" : "World_Light_Gray_Base"}/MapServer/tile/{z}/{y}/{x}`,
    ref: `${ESRI}${dark ? "World_Dark_Gray_Reference" : "World_Light_Gray_Reference"}/MapServer/tile/{z}/{y}/{x}`,
  };
}
function updateBaseTiles() {
  if (!state.map || state.tileLayers.length === 0) return;
  const u = tileUrls();
  state.tileLayers[0].setUrl(u.base);
  if (state.tileLayers[1] && u.ref) state.tileLayers[1].setUrl(u.ref);
}
function mapPadding() {
  const w = dom.mapWrap.clientWidth;
  const p = w < 480 ? 28 : w < 900 ? 48 : 72;
  // Corridor runs NW -> SE: leave room top-left for the zoom control and the origin label.
  const extra = w < 480 ? 36 : 80;
  return { paddingTopLeft: [p + extra, p + 8], paddingBottomRight: [p + 8, p + 8], maxZoom: 13 };
}
function fitCorridor() {
  if (!state.map || !state.corridor) return;
  state.map.fitBounds(state.corridor.stops.map((s) => [s.lat, s.lon]), mapPadding());
}

function initMap(corridor) {
  state.routeTotalKm = corridor.segments.reduce((t, s) => t + Number(s.distance_km), 0);
  if (!window.L) { useFallback("Leaflet failed to load"); return; }

  state.map = L.map("map", { zoomControl: true, attributionControl: true, scrollWheelZoom: false, zoomSnap: 0.25 });
  state.map.attributionControl.setPrefix(false).addAttribution("Tiles © Esri");
  const u = tileUrls();
  /* No crossOrigin: tiles are plain <img>, never read back, so CORS only produced console errors. */
  const base = L.tileLayer(u.base, { maxZoom: 16, className: "tp-tiles" }).addTo(state.map);
  state.tileLayers.push(base);
  if (u.ref) state.tileLayers.push(L.tileLayer(u.ref, { maxZoom: 16, opacity: 0.9, className: "tp-tiles" }).addTo(state.map));
  /* One quiet retry per tile after 1.5 s; only repeated failures switch to the schematic corridor. */
  base.on("tileerror", (e) => {
    const img = e.tile;
    if (img && !img.dataset.retried) {
      img.dataset.retried = "1";
      window.setTimeout(() => { img.src = base.getTileUrl(e.coords); }, 1500);
      return;
    }
    state.tileErrors += 1;
    if (state.tileErrors >= 4) useFallback("Map tiles unavailable");
  });
  base.on("tileload", () => { state.tileErrors = Math.max(0, state.tileErrors - 1); });

  corridor.segments.forEach((segment) => {
    const coords = [[segment.start_lat, segment.start_lon], [segment.end_lat, segment.end_lon]];
    const casing = L.polyline(coords, { color: cssVar("--map-casing"), weight: 10, opacity: 1, lineCap: "round", interactive: false }).addTo(state.map);
    const main = L.polyline(coords, { color: cssVar("--ontime"), weight: 5, opacity: 1, lineCap: "round", className: "route-line" }).addTo(state.map);
    main.bindTooltip(`SEG ${String(segment.segment_id).padStart(2, "0")} · ${escapeHtml(routeName(segment.name))} · ${segment.distance_km} km`, { sticky: true, direction: "auto", className: "tp-tip" });
    /* r3: route lines stay mouse/touch-interactive but leave the Tab order. Segments are reachable by
       keyboard through the segment list, which has names and a visible ring (SVG paths can't show one). */
    main.on("click", () => selectSegment(segment.segment_id));
    state.segmentLayers[segment.segment_id] = { casing, main };
  });

  unfocusRoutePaths();
  corridor.stops.forEach((stop) => {
    const terminal = stop.stop_id === 0 || stop.stop_id === corridor.stops.length - 1;
    const icon = L.divIcon({
      className: `stop-anchor${terminal ? " is-terminal" : ""}`,
      html: `<span class="stop-dot"></span><span class="stop-label" data-stop="${stop.stop_id}" data-side="${LABEL_SIDES[stop.stop_id] || "right"}">${escapeHtml(shortName(stop.name))}</span>`,
      iconSize: [44, 44], iconAnchor: [22, 22], /* 44 px pointer target; the dot stays 12–14 px */
    });
    const marker = L.marker([stop.lat, stop.lon], { icon, zIndexOffset: 200, keyboard: false }).addTo(state.map);
    marker.bindTooltip(`${escapeHtml(stop.name)} · stop ${stop.stop_id + 1} of ${corridor.stops.length} · scheduled +${Number(stop.scheduled_offset_min).toFixed(1)} min`, { className: "tp-tip", direction: "top", offset: [0, -10] });
    state.stopMarkers.push(marker);
  });

  const busIcon = L.divIcon({
    className: "bus-anchor",
    html: `<div class="bus-marker"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v9M5 16h14M8 19h1.5M14.5 19H16M8.5 9h7M8.5 12.5h7"/></svg></div>`,
    iconSize: [44, 44], iconAnchor: [22, 22],
  });
  /* 44 × 44 hit area around the 26 px tile; keyboard-focusable with a name and a tooltip. */
  state.busMarker = L.marker([corridor.stops[0].lat, corridor.stops[0].lon], { icon: busIcon, zIndexOffset: 1000, keyboard: true, title: `Bus ${BUS_ID}`, alt: `Bus ${BUS_ID}` }).addTo(state.map);
  state.busMarker.bindTooltip(`Bus ${BUS_ID}`, { className: "tp-tip", direction: "top", offset: [0, -16] });

  fitCorridor();
  state.map.on("zoomend moveend resize", () => declutterLabels(true));
  if ("ResizeObserver" in window) {
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { state.map.invalidateSize(); fitCorridor(); });
    }).observe(dom.mapWrap);
  }
  window.setTimeout(() => { state.map.invalidateSize(); fitCorridor(); }, 150);
  updateHudPosition(0, true);
}

function updateMapSegments(segments) {
  segments.forEach((segment) => {
    const layers = state.segmentLayers[segment.segment_id];
    if (!layers) return;
    const on = segment.segment_id === state.selectedSegmentId;
    layers.casing.setStyle({ color: cssVar("--map-casing"), weight: on ? 13 : 10 });
    layers.main.setStyle({ color: statusColor(segment.delay_status), weight: on ? 8 : 5 });
  });
  state.stopMarkers.forEach((m) => {
    const el = m.getElement()?.querySelector(".stop-label");
    if (el) el.classList.toggle("is-next", Number(el.dataset.stop) === getSelectedSegment()?.end_stop_id);
  });
}

/* Stop-label collision avoidance: terminals and the selected next stop win; every label tries its
   preferred side, then the others; anything that still collides or leaves the map is hidden.
   On small maps only the terminals and the next stop are labelled. */
function declutterLabels(force = false) {
  if (!state.map) return;
  const now = performance.now();
  if (!force && now - state.lastDeclutter < 400) return;
  state.lastDeclutter = now;
  const mapRect = dom.mapEl.getBoundingClientRect();
  if (mapRect.width === 0) return;
  const small = mapRect.width < 520;
  const nextStop = getSelectedSegment()?.end_stop_id;
  const last = state.corridor.stops.length - 1;
  const labels = state.stopMarkers.map((m) => m.getElement()?.querySelector(".stop-label")).filter(Boolean);
  const priority = (el) => { const id = Number(el.dataset.stop); return id === 0 || id === last ? 0 : id === nextStop ? 1 : 2; };
  labels.sort((a, b) => priority(a) - priority(b));
  const pad = 3;
  const obstacles = state.stopMarkers.map((m) => m.getElement()?.querySelector(".stop-dot")?.getBoundingClientRect()).filter(Boolean);
  const bus = state.busMarker?.getElement()?.getBoundingClientRect();
  if (bus) obstacles.push(bus);
  const ctrl = dom.mapEl.querySelector(".leaflet-control-zoom")?.getBoundingClientRect();
  if (ctrl) obstacles.push(ctrl);
  const hit = (a, b) => !(a.right + pad < b.left || a.left - pad > b.right || a.bottom + pad < b.top || a.top - pad > b.bottom);
  const inside = (r) => r.left >= mapRect.left + 4 && r.right <= mapRect.right - 4 && r.top >= mapRect.top + 4 && r.bottom <= mapRect.bottom - 18;
  const placed = [];
  labels.forEach((el) => {
    const id = Number(el.dataset.stop);
    el.classList.remove("is-hidden");
    if (small && priority(el) === 2) { el.classList.add("is-hidden"); return; }
    const pref = LABEL_SIDES[id] || "right";
    const order = [pref, ...["right", "left", "top", "bottom"].filter((s) => s !== pref)];
    const ownDot = state.stopMarkers[id].getElement()?.querySelector(".stop-dot")?.getBoundingClientRect();
    let ok = false;
    for (const side of order) {
      el.dataset.side = side;
      const r = el.getBoundingClientRect();
      if (!inside(r)) continue;
      if (placed.some((p) => hit(r, p))) continue;
      if (obstacles.some((o) => o !== ownDot && hit(r, o))) continue;
      placed.push(r); ok = true; break;
    }
    if (!ok && priority(el) === 0) {
      // Terminals always keep a label: take the first side that stays inside the map.
      let side = pref, best = Infinity;
      for (const sd of order) {
        el.dataset.side = sd;
        const r = el.getBoundingClientRect();
        if (!inside(r)) continue;
        const cost = placed.filter((p) => hit(r, p)).length + obstacles.filter((o) => o !== ownDot && hit(r, o)).length * 2;
        if (cost < best) { best = cost; side = sd; }
      }
      el.dataset.side = side; placed.push(el.getBoundingClientRect()); ok = true;
    }
    if (!ok) { el.dataset.side = pref; el.classList.add("is-hidden"); }
  });
}

/* ---------------------------------------------------------------- SVG fallback map */
function useFallback(reason) {
  if (state.tilesFailed) return;
  state.tilesFailed = true;
  dom.mapEl.hidden = true;
  dom.mapFallback.hidden = false;
  renderFallback();
  if (!SHOT) showToast(`${reason}. Showing the schematic corridor.`, false);
}
function projector(stops, w, h, pad) {
  const lats = stops.map((s) => s.lat), lons = stops.map((s) => s.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = (maxLon - minLon) * kx, spanY = maxLat - minLat;
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const ox = (w - spanX * scale) / 2, oy = (h - spanY * scale) / 2;
  return (lat, lon) => [ox + (lon - minLon) * kx * scale, oy + (maxLat - lat) * scale];
}
function renderFallback() {
  if (!state.tilesFailed || !state.corridor) return;
  const w = Math.max(dom.mapWrap.clientWidth, 280), h = Math.max(dom.mapWrap.clientHeight, 240);
  const P = projector(state.corridor.stops, w, h, w < 480 ? 56 : 96);
  const segs = state.result?.segments || state.corridor.segments;
  const lines = segs.map((s) => {
    const [x1, y1] = P(s.start_lat, s.start_lon), [x2, y2] = P(s.end_lat, s.end_lon);
    const on = s.segment_id === state.selectedSegmentId;
    const color = s.delay_status ? `var(--${statusClass(s.delay_status)})` : "var(--ontime)";
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--map-casing)" stroke-width="${on ? 13 : 10}" stroke-linecap="round"/>
            <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${on ? 8 : 5}" stroke-linecap="round"/>`;
  }).join("");
  const small = w < 520, last = state.corridor.stops.length - 1;
  const stops = state.corridor.stops.map((s) => {
    const [x, y] = P(s.lat, s.lon);
    const term = s.stop_id === 0 || s.stop_id === last;
    const dot = term ? `<rect x="${x - 7}" y="${y - 7}" width="14" height="14" rx="4" fill="var(--fg)" stroke="var(--map-stop)" stroke-width="2"/>`
      : `<circle cx="${x}" cy="${y}" r="6" fill="var(--map-stop)" stroke="var(--fg)" stroke-width="2.5"/>`;
    if (small && !term && s.stop_id !== getSelectedSegment()?.end_stop_id) return dot;
    const name = shortName(s.name), tw = name.length * 6.6 + 12;
    const side = LABEL_SIDES[s.stop_id] || "right";
    let lx = x - tw / 2, ly = y - 10;
    if (side === "left") lx = x - tw - 12; else if (side === "right") lx = x + 12;
    else if (side === "top") ly = y - 32; else ly = y + 12;
    lx = Math.min(Math.max(lx, 6), w - tw - 6); ly = Math.min(Math.max(ly, 6), h - 46);
    return `${dot}<rect class="fb-label-bg" x="${lx}" y="${ly}" width="${tw}" height="20" rx="4"/><text class="fb-label" x="${lx + tw / 2}" y="${ly + 14}" text-anchor="middle">${escapeHtml(name)}</text>`;
  }).join("");
  const loc = locateBus(state.busProgressKm);
  const [bx, by] = loc ? P(loc.lat, loc.lon) : [0, 0];
  dom.mapFallback.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Schematic map of the NH-44 corridor">
      ${lines}${stops}
      <g id="fb-bus" transform="translate(${bx} ${by})"><rect x="-12" y="-12" width="24" height="24" rx="6" fill="var(--accent)" stroke="var(--map-casing)" stroke-width="2"/></g>
      <text class="fb-note" x="14" y="${h - 14}">Schematic view · map tiles unavailable</text>
    </svg>`;
}

/* ---------------------------------------------------------------- bus animation + telemetry */
function locateBus(progressKm) {
  if (!state.corridor) return null;
  let cursor = 0;
  const segments = state.corridor.segments;
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i];
    const end = cursor + Number(s.distance_km);
    if (progressKm <= end || i === segments.length - 1) {
      const f = clamp((progressKm - cursor) / Number(s.distance_km), 0, 1);
      return { segment: s, index: i, lat: s.start_lat + (s.end_lat - s.start_lat) * f, lon: s.start_lon + (s.end_lon - s.start_lon) * f };
    }
    cursor = end;
  }
  return null;
}
function liveSpeedFor(segment) {
  const live = state.result?.segments.find((s) => s.segment_id === segment.segment_id);
  if (live) return Number(live.simulated_speed_kmh);
  return (Number(segment.distance_km) / Number(segment.scheduled_time_min)) * 60;
}
function updateHudPosition(timestamp = 0, force = false) {
  if (!state.corridor) return;
  const located = locateBus(state.busProgressKm);
  if (!located) return;
  if (state.busMarker) state.busMarker.setLatLng([located.lat, located.lon]);
  if (!force && timestamp - state.lastHudTs < 120) return;
  state.lastHudTs = timestamp;
  dom.hudLat.textContent = located.lat.toFixed(5);
  dom.hudLon.textContent = located.lon.toFixed(5);
  dom.hudSpeed.textContent = liveSpeedFor(located.segment).toFixed(1);
  dom.hudNextStop.textContent = located.segment.end_stop;
  const pct = clamp((state.busProgressKm / state.routeTotalKm) * 100, 0, 100);
  dom.hudProgressValue.textContent = `${pct.toFixed(0)}%`;
  dom.hudProgressBar.style.width = `${pct}%`;
  dom.hudState.textContent = state.playing ? "Tracking" : "Paused";
  dom.hudState.classList.toggle("is-paused", !state.playing);
  if (state.tilesFailed) {
    const g = document.getElementById("fb-bus");
    if (g) renderFallback();
  } else declutterLabels();
}
function animateBus(timestamp) {
  window.requestAnimationFrame(animateBus);
  if (!state.corridor) return;
  if (!state.playing) { state.lastFrame = timestamp; return; }
  if (state.lastFrame === null) { state.lastFrame = timestamp; updateHudPosition(timestamp, true); return; }
  const dt = Math.min((timestamp - state.lastFrame) / 1000, 0.25);
  state.lastFrame = timestamp;
  const located = locateBus(state.busProgressKm);
  if (!located) return;
  state.busProgressKm += (liveSpeedFor(located.segment) / 60) * dt;
  if (state.busProgressKm >= state.routeTotalKm) { state.busProgressKm = 0; state.lastHudTs = 0; }
  updateHudPosition(timestamp);
}
function togglePlayback() {
  state.playing = !state.playing;
  state.lastFrame = null;
  dom.playToggle.classList.toggle("is-paused", !state.playing);
  setPlayName();
  updateHudPosition(performance.now(), true);
}

/* The visible label is hidden under 640 px, so the button always carries its own name. */
function setPlayName() {
  const name = state.playing ? "Pause bus" : "Resume bus";
  dom.playLabel.textContent = name;
  dom.playToggle.setAttribute("aria-label", name);
}

function applyPreset(name) {
  if (!PRESETS[name]) return;
  const walk = state.simulation.walk_time_min ?? 5;
  state.simulation = { ...PRESETS[name], walk_time_min: walk };
  setPresetSelection(name);
  syncControlsFromState();
  scheduleSimulation(40);
  showToast(`Scenario loaded: ${PRESET_LABELS[name]}`);
}

/* r3: route lines stay mouse/touch-interactive but leave the Tab order and the accessibility tree.
   Segments are reachable by keyboard through the segment list (named, with a visible ring); an SVG
   path can't paint the box-shadow ring. */
function unfocusRoutePaths() {
  document.querySelectorAll("#map path.leaflet-interactive").forEach((el) => {
    el.setAttribute("tabindex", "-1"); el.setAttribute("aria-hidden", "true"); el.setAttribute("focusable", "false");
  });
}

/* ---------------------------------------------------------------- phone sheet */
const phoneQuery = window.matchMedia("(max-width: 639.98px)");
const controlsBody = $("controls-body");
function setSheet(open) {
  const isPhone = phoneQuery.matches;
  dom.controls.classList.toggle("is-open", open && isPhone);
  dom.sheetToggle.setAttribute("aria-expanded", String(open && isPhone));
  dom.sheetBackdrop.hidden = !(open && isPhone);
  /* r3: a collapsed phone sheet takes its controls out of the Tab order and the accessibility tree
     (WCAG 2.4.11). The handle and #play-toggle stay reachable; from 640 up the card is always open. */
  if (controlsBody) controlsBody.inert = isPhone && !open;
  /* r4: an open phone sheet is modal, like the site menu (js/site.js setInert): everything outside it
     (skip link, header, demo bar, the rest of main, footer) is inert, so Tab and Shift+Tab cycle inside
     the sheet, and the page behind it stops scrolling. Esc / backdrop / handle close it. */
  setSheetModal(open && isPhone);
}
const sheetInerted = new Set();
function setSheetModal(on) {
  sheetInerted.forEach((el) => el.removeAttribute("inert"));
  sheetInerted.clear();
  const card = dom.controls;
  if (on && card) {
    for (let node = card; node && node !== document.body; node = node.parentElement) {
      const parent = node.parentElement;
      if (!parent) break;
      Array.prototype.forEach.call(parent.children, (sib) => {
        if (sib === node || sib.tagName === "SCRIPT" || sib === dom.sheetBackdrop || sib.id === "toast" || sib.hasAttribute("inert")) return;
        sib.setAttribute("inert", ""); sheetInerted.add(sib);
      });
    }
    card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true");
  } else if (card) {
    card.removeAttribute("role"); card.removeAttribute("aria-modal");
  }
  document.documentElement.classList.toggle("sheet-open", on);
}
/* r4: Tab past the last control wraps to the handle, Shift+Tab before the handle wraps to the last
   control, so focus never leaves the open sheet for the browser chrome. */
const SHEET_FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
function trapSheetTab(e) {
  if (e.key !== "Tab" || !document.documentElement.classList.contains("sheet-open")) return;
  const items = Array.from(dom.controls.querySelectorAll(SHEET_FOCUSABLE)).filter((el) => !el.closest("[inert],[hidden]") && el.getClientRects().length);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  const inside = dom.controls.contains(document.activeElement);
  if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
}
document.addEventListener("keydown", trapSheetTab);
/* The peek height follows the real header height (it grows at 200 % text), so the head is never cut off. */
function syncSheetPeek() {
  const head = dom.controls && dom.controls.querySelector(".controls-head");
  if (!head) return;
  const h = phoneQuery.matches ? Math.ceil(head.getBoundingClientRect().height) : 0;
  if (h) document.documentElement.style.setProperty("--sheet-peek", `${h}px`);
  else document.documentElement.style.removeProperty("--sheet-peek");
}

/* ---------------------------------------------------------------- views */
function switchView(view) {
  dom.tabs.forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  Object.entries(dom.views).forEach(([key, el]) => { el.hidden = key !== view; });
  document.body.dataset.view = view;
  if (document.documentElement.dataset.demo === "error") {
    dom.footerMode.textContent = "Corridor service unavailable · nothing on this page is current";
  } else if (state.standin) {
    dom.footerMode.textContent = "Stand-in model · runs in your browser, not the trained model";
  } else {
    dom.footerMode.textContent = view === "live" ? "Live simulation · FastAPI + scikit-learn" : "Evaluator audit · frozen artifacts + validation proof";
  }
  setSheet(false);
  if (view === "live" && state.map) window.setTimeout(() => { state.map.invalidateSize(); fitCorridor(); }, 60);
}

function bindEvents() {
  dom.tabs.forEach((tab) => tab.addEventListener("click", () => switchView(tab.dataset.view)));
  document.querySelector(".view-tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = dom.tabs.findIndex((t) => t.classList.contains("is-active"));
    const next = dom.tabs[(i + (e.key === "ArrowRight" ? 1 : dom.tabs.length - 1)) % dom.tabs.length];
    switchView(next.dataset.view); next.focus();
  });

  const sliders = [[dom.timeSlider, "hour_of_day"], [dom.lagSlider, "rolling_3trip_delay_min"], [dom.dwellSlider, "prev_stop_dwell_sec"], [dom.speedSlider, "gps_speed_kmh"], [dom.walkSlider, "walk_time_min"]];
  sliders.forEach(([el, key]) => el && el.addEventListener("input", () => {
    state.simulation[key] = Number(el.value);
    clearPresetSelection(); updateRangeFill(el); updateControlLabels(); scheduleSimulation();
  }));
  dom.weatherButtons.forEach((button) => button.addEventListener("click", () => {
    state.simulation.weather_severity = Number(button.dataset.weather);
    clearPresetSelection(); syncControlsFromState(); scheduleSimulation();
  }));
  dom.presetButtons.forEach((b) => b.addEventListener("click", () => applyPreset(b.dataset.preset)));
  dom.playToggle.addEventListener("click", togglePlayback);
  dom.recenterMap.addEventListener("click", fitCorridor);
  dom.segmentList.addEventListener("click", (e) => {
    const item = e.target.closest("[data-segment-id]");
    if (item) selectSegment(Number(item.dataset.segmentId), true);
  });
  dom.sheetToggle.addEventListener("click", () => { if (phoneQuery.matches) setSheet(!dom.controls.classList.contains("is-open")); });
  dom.sheetBackdrop.addEventListener("click", () => { setSheet(false); dom.sheetToggle.focus({ preventScroll: true }); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !dom.controls.classList.contains("is-open")) return;
    setSheet(false); dom.sheetToggle.focus();
  });
  phoneQuery.addEventListener("change", () => { setSheet(false); syncSheetPeek(); });
  if (window.ResizeObserver) new ResizeObserver(syncSheetPeek).observe(dom.controls.querySelector(".controls-head"));
  window.addEventListener("resize", () => { if (state.tilesFailed) renderFallback(); });
}

/* ---------------------------------------------------------------- evaluator */
function renderDiagnostics(data) {
  const metadata = data.model_metadata || {};
  const audit = data.dq_audit_report || {};
  const metrics = metadata.metrics || {};
  const summary = audit.summary || {};
  const verification = data.verification || {};
  const passed = Boolean(verification.passed && (audit.passed ?? true));
  dom.evalBadge.textContent = passed ? "All gates passed · artifacts frozen" : "Review required";
  dom.verdict.classList.toggle("is-bad", !passed);

  const cards = [
    { label: "Model MAE", value: Number(metrics.reg_mae ?? 0).toFixed(3), unit: "min", note: `Naive baseline ${Number(metrics.baseline_mae ?? 0).toFixed(3)} min`, cls: "is-good" },
    { label: "Error reduction", value: Number(metrics.error_reduction_pct ?? 0).toFixed(2), unit: "%", note: "Lower error than baseline", cls: "is-good" },
    { label: "R² score", value: Number(metrics.reg_r2 ?? 0).toFixed(3), unit: "", note: "Held-out future window", cls: "" },
    { label: "Classifier accuracy", value: (Number(metrics.clf_accuracy ?? 0) * 100).toFixed(1), unit: "%", note: `Macro F1 ${(Number(metrics.clf_macro_f1 ?? 0) * 100).toFixed(1)}%`, cls: "is-good" },
    { label: "Data retention", value: Number(summary.retention_rate_pct ?? 0).toFixed(2), unit: "%", note: `${Number(summary.clean_records ?? 0).toLocaleString("en-US")} clean rows`, cls: "" },
    { label: "Peak interval", value: Number(metadata.uncertainty?.peak_hour_interval_width ?? 0).toFixed(2), unit: "min", note: "80% quantile width", cls: "is-warn" },
  ];
  dom.metricGrid.innerHTML = cards.map((c) => `<article class="metric ${c.cls}">
      <h3 class="label">${escapeHtml(c.label)}</h3>
      <p class="metric-value">${escapeHtml(c.value)}${c.unit ? `<small>${escapeHtml(c.unit)}</small>` : ""}</p>
      <p class="kpi-foot">${escapeHtml(c.note)}</p>
    </article>`).join("");

  dom.retentionTag.textContent = `${Number(summary.retention_rate_pct ?? 0).toFixed(2)}% retention`;
  const raw = Number(summary.raw_records ?? 4800);
  dom.dqFunnel.innerHTML = (audit.cleaning_funnel || []).map((row) => {
    const records = Number(row.records ?? 0);
    const width = clamp((records / raw) * 100, 20, 100);
    const delta = Number(row.delta ?? 0);
    const deltaText = delta === 0 ? (row.imputed ? `${row.imputed} imputed` : "—") : `${delta < 0 ? "−" : "+"}${Math.abs(delta)}`;
    return `<div class="funnel-row">
        <span class="funnel-label">${escapeHtml(row.stage)}</span>
        <span class="funnel-bar-wrap"><i class="funnel-bar" style="width:${width}%">${records.toLocaleString("en-US")}</i></span>
        <span class="funnel-delta ${delta < 0 ? "is-drop" : ""}">${escapeHtml(deltaText)}</span>
      </div>`;
  }).join("");
  dom.dqGates.innerHTML = (audit.gates || []).map((g) => {
    const dropped = Number(g.dropped_records ?? 0), imputed = Number(g.imputed_records ?? 0);
    const detail = imputed > 0 ? `${imputed} imputed` : `${dropped} dropped`;
    return `<div class="gate">
        <div class="gate-top"><strong>${escapeHtml(g.name)}</strong><span class="status-chip ontime">${escapeHtml((g.status || "passed").replace(/^./, (c) => c.toUpperCase()))}</span></div>
        <p>${escapeHtml(g.description)} <b>${escapeHtml(detail)}</b> → ${Number(g.output_records ?? 0).toLocaleString("en-US")} rows.</p>
      </div>`;
  }).join("");

  const imps = Object.entries(metadata.feature_importances || {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 8);
  const maxImp = Math.max(...imps.map((e) => Number(e[1])), 0.01);
  dom.featureImportance.innerHTML = imps.map(([name, v]) => `<div class="hbar">
      <span class="hbar-label" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <span class="track"><i style="width:${(Number(v) / maxImp) * 100}%"></i></span>
      <span class="hbar-value">${(Number(v) * 100).toFixed(1)}%</span>
    </div>`).join("");

  const off = Number(metadata.uncertainty?.off_peak_interval_width ?? 0);
  const peak = Number(metadata.uncertainty?.peak_hour_interval_width ?? 0);
  const ratio = off > 0 ? peak / off : 0;
  dom.uncertaintyVisual.innerHTML = `
    <div class="hbar"><span class="hbar-label">Off-peak</span><span class="track"><i style="width:${clamp((off / Math.max(peak, 0.01)) * 100, 4, 100)}%"></i></span><span class="hbar-value">${off.toFixed(3)} min</span></div>
    <div class="hbar is-peak"><span class="hbar-label">Peak</span><span class="track"><i style="width:100%"></i></span><span class="hbar-value">${peak.toFixed(3)} min</span></div>`;
  dom.uncertaintyNote.textContent = `Peak-hour prediction intervals are ${ratio.toFixed(1)}× wider than off-peak. The rider card switches to the 80% arrival window whenever confidence drops.`;

  const plot = data.plots?.[0];
  if (plot) { dom.plotLink.href = plot.url; dom.diagnosticCaption.textContent = plot.caption; }
  const showSvgPlot = () => {
    if (!window.TPStandIn?.plotSVG || dom.plotFrame.querySelector(".diag-plot")) return;
    dom.diagnosticPlot.remove();
    dom.plotFrame.insertAdjacentHTML("afterbegin", window.TPStandIn.plotSVG());
    dom.plotLink.hidden = true;
    dom.diagnosticCaption.textContent += " (Schematic redraw; the real PNG loads from /assets when the backend serves it.)";
  };
  if (state.standin) showSvgPlot();
  else {
    dom.diagnosticPlot.addEventListener("error", showSvgPlot, { once: true });
    if (plot) dom.diagnosticPlot.src = plot.url;
  }

  const artifacts = data.artifacts || [];
  dom.artifactCount.textContent = `${artifacts.length} artifacts`;
  dom.artifactTable.innerHTML = artifacts.map((a) => `<tr>
      <td><span class="artifact-name"><b title="${escapeHtml(a.file)}">${escapeHtml(a.file)}</b><small>${escapeHtml(a.name)}</small></span></td>
      <td class="r mono">${escapeHtml(formatBytes(a.size_bytes))}</td>
      <td class="artifact-hash" title="${escapeHtml(a.sha256)}">${escapeHtml(String(a.sha256).slice(0, 12))}…</td>
      <td><span class="artifact-ok">✓ Verified</span></td>
    </tr>`).join("");

  const rt = data.runtime || {};
  const items = [
    ["Backend", rt.backend || "FastAPI"], ["Regressor", rt.regressor || "RandomForestRegressor"],
    ["Uncertainty", rt.uncertainty || "Quantile regressors"], ["Features", String(rt.feature_count ?? 12)],
    ["Quality gates", rt.quality_gates_passed ? "Passed" : "Failed"], ["Artifact freeze", rt.artifacts_passed ? "Passed" : "Failed"],
    ["Service state", state.standin ? "Stand-in fallback (not the trained model)" : String(rt.status || "online").replace(/^./, (c) => c.toUpperCase())],
    ["Generated", new Date(rt.generated_at || Date.now()).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false }) + " IST"],
  ];
  dom.diagRuntime.innerHTML = items.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd class="${v === "Passed" ? "is-pass" : ""}">${escapeHtml(v)}</dd></div>`).join("");
}
async function loadDiagnostics() {
  try {
    const data = await api("/api/diagnostics");
    state.diagnostics = data;
    renderDiagnostics(data);
  } catch (error) {
    dom.evalBadge.textContent = "Diagnostics unavailable";
    dom.verdict.classList.add("is-bad");
    dom.diagRuntime.innerHTML = "<div><dt>Service state</dt><dd>Offline</dd></div>";
    showToast("Diagnostics endpoint unavailable.", true);
  }
}

/* ---------------------------------------------------------------- page states
   html[data-demo]: "loading" → (after 300 ms) "skeleton" → "ready" | "error". Offline is a pill state.
   ?state=loading|error|offline freezes a state for captures and reviews. */
const FORCED_STATE = params.get("state");
function setDemoState(kind) {
  document.documentElement.dataset.demo = kind;
  const mainEl = document.getElementById("main");
  if (mainEl) mainEl.setAttribute("aria-busy", String(kind === "loading" || kind === "skeleton"));
  const card = $("demo-error");
  if (card) card.hidden = kind !== "error";
  if (kind === "error" && dom.footerMode) dom.footerMode.textContent = "Corridor service unavailable · nothing on this page is current";
}
/* r3: offline marks every value as stale: dimmed, with an "as of" time under the KPI row. */
function goOffline() {
  setSyncState("offline", "Offline · showing the last result");
  const asOf = state.lastResultAt || new Date();
  const t = asOf.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false });
  document.documentElement.dataset.demoStale = "1";
  const note = $("stale-note");
  if (note) { note.hidden = false; note.textContent = `Offline · values as of ${t} IST, not updating`; }
  if (dom.footerMode) dom.footerMode.textContent = `Offline · last result from ${t} IST`;
  /* r4: the rider card and the live-status KPI carry their own "as of" stamp (CSS ::after), so a
     re-render of their text can't drop it. */
  [dom.etaKicker, dom.statStatusFoot].forEach((el) => { if (el) el.dataset.asof = t; });
  /* r4: the bus position is extrapolated from the last result, so offline it stops moving; it resumes
     when the connection returns if it was playing before. */
  if (state.playing) { state.resumeOnline = true; togglePlayback(); }
}
function clearStale() {
  [dom.etaKicker, dom.statStatusFoot].forEach((el) => { if (el) delete el.dataset.asof; });
  if (state.resumeOnline && !state.playing) togglePlayback();
  state.resumeOnline = false;
  delete document.documentElement.dataset.demoStale;
  const note = $("stale-note");
  if (note) note.hidden = true;
}
function bindConnectivity() {
  window.addEventListener("offline", goOffline);
  window.addEventListener("online", () => { clearStale(); switchView(document.body.dataset.view || "live"); if (state.corridor) scheduleSimulation(40); else retryBoot(); });
  const retry = $("demo-retry");
  if (retry) retry.addEventListener("click", retryBoot);
}
async function retryBoot() {
  setDemoState("loading");
  setSyncState("busy", "Retrying");
  const t = window.setTimeout(() => { if (document.documentElement.dataset.demo === "loading") setDemoState("skeleton"); }, 300);
  try {
    if (!state.corridor) { state.corridor = await api("/api/corridor"); await loadLeaflet(); initMap(state.corridor); loadDiagnostics(); }
    await runSimulation();
    window.clearTimeout(t);
    if (state.result) setDemoState("ready"); else setDemoState("error");
  } catch (error) {
    window.clearTimeout(t);
    setDemoState("error");
    setSyncState("error", "Corridor offline");
  }
}

/* ---------------------------------------------------------------- boot */
/* r4 · LCP: Leaflet (147 kB JS + its CSS) no longer blocks first paint or app.js; it loads on demand and
   the map waits for it. */
let leafletReady = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (!leafletReady) leafletReady = Promise.all([
    new Promise((resolve) => {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = "vendor/leaflet-1.9.4/leaflet.css";
      css.onload = css.onerror = () => resolve();
      /* before the bundle, so the demo's Leaflet overrides keep winning */
      document.head.insertBefore(css, document.querySelector('link[rel="stylesheet"]'));
    }),
    new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "vendor/leaflet-1.9.4/leaflet.js";
      s.onload = s.onerror = () => resolve();
      document.head.appendChild(s);
    }),
  ]);
  return leafletReady;
}
/* Leaflet starts once the corridor answer has set the status line, the page has loaded and that frame has painted (+150 ms), so the
   147 kB map library never competes with the first meaningful paint (the map shows its skeleton meanwhile). */
const afterFirstPaint = () => new Promise((resolve) => {
  const frames = () => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)));
  if (document.readyState === "complete") frames(); else window.addEventListener("load", frames, { once: true });
});
async function init() {
  setDemoState("loading");
  setSheet(false); syncSheetPeek();
  const skeletonTimer = window.setTimeout(() => { if (document.documentElement.dataset.demo === "loading") setDemoState("skeleton"); }, 300);
  bindConnectivity();
  if (FORCED_STATE === "loading") { window.clearTimeout(skeletonTimer); setDemoState("skeleton"); bindTheme(); startClock(); return; }
  if (FORCED_STATE === "error") { window.clearTimeout(skeletonTimer); bindTheme(); startClock(); setDemoState("error"); setSyncState("error", "Corridor offline"); document.documentElement.dataset.ready = "1"; return; }
  bindTheme();
  startClock();
  bindEvents();
  syncControlsFromState();
  dom.playToggle.classList.toggle("is-paused", !state.playing);
  setPlayName();
  switchView(params.get("view") === "evaluator" ? "evaluator" : "live");

  try {
    const corridor = await api("/api/corridor");
    state.corridor = corridor;
    await afterFirstPaint();
    await loadLeaflet();
    initMap(corridor);
  } catch (error) {
    window.clearTimeout(skeletonTimer);
    setSyncState("error", "Corridor offline");
    setDemoState("error");
    return;
  }
  loadDiagnostics();
  await runSimulation();
  window.clearTimeout(skeletonTimer);
  setDemoState(state.result ? "ready" : "error");
  if (FORCED_STATE === "offline" || navigator.onLine === false) goOffline();
  if (params.get("sheet") === "open") setSheet(true);
  window.requestAnimationFrame(animateBus);
  window.setTimeout(() => { declutterLabels(true); unfocusRoutePaths(); document.documentElement.dataset.ready = "1"; }, 400);
}
init();
