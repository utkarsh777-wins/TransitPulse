/* Shared rider arrival math and CSV cells. Loaded before app.js and rider-home.js. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.arrivalView = api.arrivalView;
  root.minutes1 = api.minutes1;
  root.formatMinutes = api.formatMinutes;
  root.csvCell = api.csvCell;
  root.createRequestGate = api.createRequestGate;
  root.driverBadgeText = api.driverBadgeText;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* This stop's 10th–90th delay band, shifted by earlier stops' point delays.
     Not a calibrated cumulative interval. Segment 1 has no earlier delay. */
  function arrivalView(segment) {
    var scheduled = Number(segment.scheduled_arrival_offset_min);
    var point = Number(segment.predicted_delay_min);
    var prior = Number(segment.cumulative_delay_min) - point;
    var lo = Math.max(0, scheduled + prior + Number(segment.lower_bound_min));
    var hi = Math.max(lo, scheduled + prior + Number(segment.upper_bound_min));
    var eta = Math.max(0, Number(segment.estimated_arrival_offset_min));
    return { eta: eta, lo: lo, hi: hi };
  }

  function minutes1(value) {
    var n = Math.round(Number(value) * 10) / 10;
    return Number.isFinite(n) ? n : "";
  }

  function formatMinutes(value) {
    var n = minutes1(value);
    return n === "" ? "" : n.toFixed(1);
  }

  function csvCell(value) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    var text = String(value ?? "");
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return text;
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    if (/[",\n\r]/.test(text)) return '"' + text.split('"').join('""') + '"';
    return text;
  }

  /* Empty when the one-decimal badge would read 0.0. A zero is not a reason. */
  function driverBadgeText(minutes) {
    var shown = Number(Number(minutes).toFixed(1));
    if (!Number.isFinite(shown) || shown === 0) return "";
    return (shown > 0 ? "+" : "") + shown.toFixed(1) + " min";
  }

  function createRequestGate() {
    var seq = 0;
    return {
      start: function () {
        seq += 1;
        return seq;
      },
      isCurrent: function (token) {
        return token === seq;
      },
    };
  }

  return {
    arrivalView: arrivalView,
    minutes1: minutes1,
    formatMinutes: formatMinutes,
    csvCell: csvCell,
    createRequestGate: createRequestGate,
    driverBadgeText: driverBadgeText,
  };
});
