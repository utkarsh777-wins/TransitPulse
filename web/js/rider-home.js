/* Home rider strip. Uses /api/simulate. Text is set with textContent only. */
(function () {
  "use strict";
  var root = document.getElementById("ops");
  if (!root) return;
  var PRESETS = {
    midday: { hour_of_day: 13, is_weekend: false, weather_severity: 0, rolling_3trip_delay_min: 0.5, prev_stop_dwell_sec: 30, gps_speed_kmh: 34, walk_time_min: 5, label: "Weekday 13:00 · clear" },
    rush: { hour_of_day: 8, is_weekend: false, weather_severity: 1, rolling_3trip_delay_min: 6.5, prev_stop_dwell_sec: 85, gps_speed_kmh: 18, walk_time_min: 8, label: "Weekday 08:00 · light rain" },
    evening: { hour_of_day: 18, is_weekend: false, weather_severity: 0, rolling_3trip_delay_min: 14, prev_stop_dwell_sec: 115, gps_speed_kmh: 10, walk_time_min: 8, label: "Weekday 18:00 · severe congestion" }
  };
  var NAMES = { rolling_lag: "Earlier buses running late", peak_hour: "Peak hour", weather: "Weather", dwell: "Time stopped at the last stop" };
  var params = new URLSearchParams(location.search);
  var presetName = PRESETS[params.get("preset")] ? params.get("preset") : "midday";
  var seg = Number(params.get("seg")) || 1;
  var requests = createRequestGate();

  function $(id) { return document.getElementById(id); }
  function setPressed() {
    root.querySelectorAll("[data-ops-preset]").forEach(function (btn) {
      var on = btn.getAttribute("data-ops-preset") === presetName;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  function statusWord(status) {
    if (status === "Severe Delay") return "Severely late";
    if (status === "Moderate Delay") return "Late";
    return "Close to schedule";
  }
  function action(segment, walk) {
    var leave = Number(segment.leave_by_min);
    var when = leave > 0.05 ? "Leave in " + leave.toFixed(1) + " min" : "Leave now";
    var walkBit = " for a " + Number(walk).toFixed(0) + " min walk";
    if (segment.delay_status === "Severe Delay") return when + walkBit + ". This stop is running severely late.";
    if (segment.delay_status === "Moderate Delay") return when + walkBit + ". This stop is late.";
    if (segment.is_low_confidence) return when + walkBit + ". The arrival range is wide, so the midpoint is not an exact time.";
    return when + walkBit + ". This stop is close to the schedule.";
  }
  function show(result) {
    var preset = PRESETS[presetName];
    var segment = (result.segments || []).find(function (s) { return s.segment_id === seg; }) || result.segments[0];
    if (!segment) return;
    $("ops-context").textContent = "PB08-BUS-101 · " + preset.label;
    $("ops-stop").textContent = segment.end_stop;
    var status = $("ops-status");
    status.textContent = statusWord(segment.delay_status);
    status.dataset.status = segment.delay_status === "Severe Delay" ? "severe" : segment.delay_status === "Moderate Delay" ? "moderate" : "ontime";
    var leave = Number(segment.leave_by_min);
    $("ops-leave").textContent = leave > 0.05 ? "in " + leave.toFixed(1) + " min" : "now";
    var view = arrivalView(segment);
    $("ops-range").textContent = "Arrival range " + minutes1(view.lo).toFixed(1) + "–" + minutes1(view.hi).toFixed(1) + " min (10th–90th band, not a guarantee)";
    $("ops-action").textContent = action(segment, preset.walk_time_min);
    var list = $("ops-drivers");
    list.replaceChildren();
    (segment.xai_drivers || []).forEach(function (d) {
      var li = document.createElement("li");
      var minutes = Number(d.minutes);
      var name = NAMES[d.key] || d.label;
      li.textContent = name + ": " + (minutes >= 0 ? "+" : "") + minutes.toFixed(1) + " min";
      list.appendChild(li);
    });
  }
  function fail() {
    $("ops-stop").textContent = "Model unavailable";
    $("ops-status").textContent = "Not loaded";
    $("ops-action").textContent = "The scenario model did not answer. Open the corridor page to retry.";
  }
  function load() {
    setPressed();
    var token = requests.start();
    fetch("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PRESETS[presetName])
    }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    }).then(function (result) {
      if (!requests.isCurrent(token)) return;
      show(result);
    }).catch(function () {
      if (!requests.isCurrent(token)) return;
      fail();
    });
  }
  root.querySelectorAll("[data-ops-preset]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      presetName = btn.getAttribute("data-ops-preset");
      var url = new URL(location.href);
      url.searchParams.set("preset", presetName);
      history.replaceState(null, "", url);
      load();
    });
  });
  load();
})();
