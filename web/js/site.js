/* TransitPulse site: theme, header, mobile nav, reveal, split-flap, explorer.
   No dependencies. Motion is skipped under prefers-reduced-motion and ?shot=1. */
(function () {
  "use strict";
  var doc = document.documentElement;
  var params = new URLSearchParams(location.search);
  var SHOT = params.has("shot");
  var REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var STILL = SHOT || REDUCED;
  if (SHOT) doc.classList.add("is-shot");
  doc.classList.remove("no-js");
  var isApp = document.body.hasAttribute("data-app"); // demo.html: app.js owns the theme toggle

  /* ---- Theme ---- */
  /* 160 ms colour crossfade on every theme change, including the demo (app.js owns its toggle there).
     The class is added in a MutationObserver callback, i.e. before the next style recalc, so the
     old → new colours transition. Instant under reduced motion and in ?shot=1 captures. */
  if (!STILL && "MutationObserver" in window) {
    var fadeTimer = 0;
    new MutationObserver(function () {
      doc.classList.add("theme-fade");
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(function () { doc.classList.remove("theme-fade"); }, 220);
    }).observe(doc, { attributes: true, attributeFilter: ["data-theme"] });
  }
  function setTheme(t) {
    doc.dataset.theme = t;
    try { localStorage.setItem("tp-theme", t); } catch (e) {}
    var m = document.getElementById("meta-theme-color");
    if (m) m.setAttribute("content", t === "dark" ? "#0F1012" : "#F3F1EC");
    var b = document.getElementById("theme-toggle");
    if (b) b.setAttribute("aria-label", t === "dark" ? "Switch to light theme" : "Switch to dark theme");
  }
  var tbtn = document.getElementById("theme-toggle");
  if (tbtn && !isApp) {
    setTheme(doc.dataset.theme || "light");
    tbtn.addEventListener("click", function () { setTheme(doc.dataset.theme === "dark" ? "light" : "dark"); });
  }

  /* ---- Header: hairline on scroll, mobile menu sheet ---- */
  var header = document.querySelector(".site-header");
  if (header) {
    var onScroll = function () { header.classList.toggle("is-scrolled", window.scrollY > 8); };
    onScroll(); window.addEventListener("scroll", onScroll, { passive: true });
    var menuBtn = header.querySelector(".site-menu-btn");
    var nav = header.querySelector(".site-nav");
    if (menuBtn && nav) {
      /* Full-screen layer = panel (the nav) + scrim. While open every other body child is inert,
         so Tab stays inside the header, and <html> stops scrolling. */
      var scrim = document.createElement("div");
      scrim.className = "site-scrim";
      scrim.setAttribute("aria-hidden", "true");
      header.appendChild(scrim);
      var mq = matchMedia("(max-width: 1099.98px)");
      var isOpen = function () { return header.classList.contains("is-open"); };
      var setInert = function (on) {
        Array.prototype.forEach.call(document.body.children, function (el) {
          if (el === header || el.tagName === "SCRIPT") return;
          if (on) { el.setAttribute("inert", ""); } else { el.removeAttribute("inert"); }
        });
      };
      var setMenu = function (open, restoreFocus) {
        if (open && !mq.matches) open = false;
        header.classList.toggle("is-open", open);
        doc.classList.toggle("menu-open", open);
        setInert(open);
        menuBtn.setAttribute("aria-expanded", String(open));
        menuBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
        if (open) { var first = nav.querySelector("a"); if (first) first.focus({ preventScroll: true }); }
        else if (restoreFocus) menuBtn.focus({ preventScroll: true });
      };
      menuBtn.addEventListener("click", function () { setMenu(!isOpen(), true); });
      scrim.addEventListener("click", function () { setMenu(false, true); });
      nav.addEventListener("click", function (e) { if (isOpen() && e.target.closest("a")) setMenu(false, false); });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape" && isOpen()) { setMenu(false, true); } });
      /* r4: Tab / Shift+Tab wrap inside the open menu layer (header + panel) instead of leaving for the browser chrome. */
      document.addEventListener("keydown", function (e) {
        if (e.key !== "Tab" || !isOpen()) return;
        var items = Array.prototype.filter.call(header.querySelectorAll("a[href], button:not([disabled])"), function (el) {
          return el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && el.tabIndex >= 0;
        });
        if (!items.length) return;
        var first = items[0], last = items[items.length - 1], inside = header.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
      });
      var onMq = function () { if (!mq.matches && isOpen()) setMenu(false, false); };
      if (mq.addEventListener) mq.addEventListener("change", onMq); else mq.addListener(onMq);
      window.addEventListener("pageshow", function (e) { if (e.persisted && isOpen()) setMenu(false, false); }); /* back/forward cache */
      if (params.get("menu") === "open") setMenu(true);
    }

    /* Header CTA rests while the page's own primary CTA ([data-hero-cta]) is in view. */
    var heroCta = document.querySelector("[data-hero-cta]");
    var headCta = header.querySelector(".site-cta");
    if (heroCta && headCta && "IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        var vis = entries[0].isIntersecting;
        headCta.classList.toggle("is-dormant", vis);
        if (vis) headCta.setAttribute("tabindex", "-1"); else headCta.removeAttribute("tabindex");
      }, { rootMargin: "-" + 68 + "px 0px 0px 0px" }).observe(heroCta);
    }
  }

  /* ---- Reveal on scroll (stagger via --rd set in markup) ---- */
  var reveal = document.querySelectorAll("[data-reveal], .rail, .fi");
  if (!STILL && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var el = en.target;
        el.classList.add("is-in");
        if (el.classList.contains("rail")) el.classList.add("draw");
        if (el.classList.contains("fi")) el.classList.add("grow");
        io.unobserve(el);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    reveal.forEach(function (el) { io.observe(el); });
  } else {
    reveal.forEach(function (el) { el.classList.add("is-in"); });
  }

  /* ---- Split-flap readouts: [data-flap="17:38–17:51"] ---- */
  /* Tiles are aria-hidden; the readable value is one .sr-only span (aria-label is not allowed on <p>/<span>). */
  /* r4: tiles sit in .grp runs ("17:38", "–", "17:51") that never wrap inside, so a narrow column or
     200 % text breaks the readout only at the dash, never inside a time. */
  function tiles(el) { return el.querySelectorAll(":scope > .grp > .ch, :scope > .grp > .sep, :scope > .dash"); }
  function renderFlap(el, text, label) {
    el.textContent = "";
    var grp = null;
    for (var i = 0; i < text.length; i++) {
      var c = text[i], s = document.createElement("span");
      s.setAttribute("aria-hidden", "true");
      if (c === "–") { s.className = "dash"; s.textContent = "–"; el.appendChild(s); grp = null; continue; }
      if (!grp) { grp = document.createElement("span"); grp.className = "grp"; grp.setAttribute("aria-hidden", "true"); el.appendChild(grp); }
      if (c === ":" || c === ".") { s.className = "sep"; s.textContent = c; }
      else { s.className = "ch"; var inner = document.createElement("span"); inner.textContent = c; s.appendChild(inner); }
      grp.appendChild(s);
    }
    var sr = document.createElement("span");
    sr.className = "sr-only";
    sr.textContent = label || el.dataset.label || text;
    el.appendChild(sr);
  }
  function flipTo(el, text) {
    var chs = tiles(el);
    if (chs.length !== text.length) { renderFlap(el, text); return; }
    for (var i = 0; i < text.length; i++) {
      (function (node, c, i) {
        if (!node.classList.contains("ch")) return;
        var span = node.firstChild;
        if (span.textContent === c) return;
        setTimeout(function () {
          node.classList.remove("is-flipping"); void node.offsetWidth; node.classList.add("is-flipping");
          setTimeout(function () { span.textContent = c; }, 150);
        }, i * 55);
      })(chs[i], text[i], i);
    }
  }
  document.querySelectorAll("[data-flap]").forEach(function (el) { renderFlap(el, el.dataset.flap); });

  /* Hero readout flips in once from a neutral board, like a departures sign settling. */
  var heroFlap = document.querySelector("[data-flap-intro]");
  if (heroFlap && !STILL) {
    var target = heroFlap.dataset.flap;
    renderFlap(heroFlap, target.replace(/[0-9]/g, "0"), heroFlap.dataset.label || target);
    setTimeout(function () { flipTo(heroFlap, target); }, 450);
  }

  /* ---- Explorer tabs (How it works) ---- */
  document.querySelectorAll("[data-explorer]").forEach(function (root) {
    var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        var p = document.getElementById(t.getAttribute("aria-controls"));
        p.hidden = !on;
        if (on && !STILL) { p.classList.remove("is-entering"); void p.offsetWidth; p.classList.add("is-entering"); }
      });
      if (focus) tab.focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { select(t); });
      t.addEventListener("keydown", function (e) {
        var k = e.key, n = null;
        if (k === "ArrowRight" || k === "ArrowDown") n = tabs[(i + 1) % tabs.length];
        if (k === "ArrowLeft" || k === "ArrowUp") n = tabs[(i - 1 + tabs.length) % tabs.length];
        if (k === "Home") n = tabs[0];
        if (k === "End") n = tabs[tabs.length - 1];
        if (n) { e.preventDefault(); select(n, true); }
      });
    });
    var want = params.get("step");
    if (want && root.querySelector('[data-step="' + want + '"]')) select(root.querySelector('[data-step="' + want + '"]'));
  });

  /* ---- Bus marker along the mini corridor ---- */
  var bus = document.querySelector("[data-bus-path]");
  if (bus && !STILL) {
    var path = document.getElementById(bus.getAttribute("data-bus-path"));
    var len = path.getTotalLength(), t0 = null, from = 0.18, to = 0.46, dur = 14000;
    var tick = function (ts) {
      if (t0 === null) t0 = ts;
      var k = ((ts - t0) % dur) / dur;
      var p = path.getPointAtLength(len * (from + (to - from) * k));
      bus.setAttribute("transform", "translate(" + p.x + "," + p.y + ")");
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* Coverage and the GPS-speed ablation are filled from /api/evidence, never hard-coded. */
  var slots = document.querySelectorAll("[data-evidence]");
  var artifactBody = document.getElementById("artifact-body");
  function evidenceText(value) { return value == null || value === "" || value === "unavailable" ? "—" : String(value); }
  function fmtPct(value) {
    var n = Number(value);
    return Number.isFinite(n) ? (n * 100).toFixed(1) + "%" : "unavailable";
  }
  function fmtNum(value, digits) {
    var n = Number(value);
    return Number.isFinite(n) ? n.toFixed(digits) : "unavailable";
  }
  function applyEvidence(data) {
    var cov = data.interval_coverage || {};
    var metrics = (data.ablation && data.ablation.metrics) || {};
    var map = {
      "coverage-overall": fmtPct(cov.overall),
      "coverage-peak": fmtPct(cov.peak),
      "coverage-offpeak": fmtPct(cov.off_peak),
      "ablation-mae": fmtNum(metrics.reg_mae, 3),
      "ablation-r2": fmtNum(metrics.reg_r2, 3)
    };
    slots.forEach(function (el) {
      var key = el.getAttribute("data-evidence");
      if (Object.prototype.hasOwnProperty.call(map, key)) el.textContent = evidenceText(map[key]);
    });
    if (artifactBody && Array.isArray(data.artifacts)) {
      var roles = {
        delay_regressor: "Point delay",
        delay_classifier: "Status cross-check",
        quantile_lower: "10th percentile",
        quantile_upper: "90th percentile",
        metadata: "Metrics and coverage",
        regressor: "Point delay",
        classifier: "Status cross-check"
      };
      var rows = data.artifacts.filter(function (item) { return item.file !== "dq_audit_report.json"; });
      /* Built with DOM nodes, not innerHTML: file names and hashes come from the API and are never parsed as HTML. */
      var cell = function (text, cls, title) {
        var td = document.createElement("td");
        if (cls) td.className = cls;
        if (title) td.title = title;
        td.textContent = text;
        return td;
      };
      artifactBody.replaceChildren.apply(artifactBody, rows.map(function (item) {
        var sha = String(item.sha256 || "");
        var short = sha ? sha.slice(0, 8) + "…" + sha.slice(-6) : "—";
        var size = Number(item.size_bytes);
        var sizeText = size >= 1024 * 1024 ? (size / (1024 * 1024)).toFixed(1) + " MB"
          : size >= 1024 ? (size / 1024).toFixed(1) + " kB" : size + " B";
        var role = roles[item.name] || roles[String(item.file || "").replace(".joblib", "").replace(".json", "")] || item.name || "";
        var tr = document.createElement("tr");
        /* r4: the hash cell stays one line (shortened "8…6" form, full hash in the title) with a Copy button,
           so phones get the whole SHA-256 without a 5-line cell. */
        var shaCell = cell("", "sha", sha);
        var shaText = document.createElement("span"); shaText.className = "sha-short"; shaText.textContent = short;
        shaCell.appendChild(shaText);
        if (sha) {
          var copy = document.createElement("button");
          copy.type = "button"; copy.className = "sha-copy"; copy.setAttribute("data-copy", sha);
          copy.setAttribute("aria-label", "Copy SHA-256 of " + String(item.file || "artifact"));
          copy.textContent = "Copy";
          shaCell.appendChild(copy);
        }
        tr.append(cell(String(item.file || ""), "mono"), cell(String(role)), cell(sizeText, "num"), shaCell);
        return tr;
      }));
    }
    doc.dataset.evidence = "1";
  }
  /* r3: one loader, re-runnable from any [data-ev-retry] button. On failure the inline values become an
     em dash (never the word "unavailable" inside a sentence) and one line under the block offers Retry. */
  function loadEvidence() {
    doc.dataset.evidence = "pending"; /* site.css draws skeleton bars in the slots until this flips */
    fetch("/api/evidence", { cache: "no-store" }).then(function (response) {
      if (!response.ok) throw new Error(String(response.status));
      return response.json();
    }).then(applyEvidence).catch(function () {
      slots.forEach(function (el) { el.textContent = "—"; el.title = "Not loaded: /api/evidence did not answer"; });
      if (artifactBody) {
        var tr = document.createElement("tr"), td = document.createElement("td");
        td.colSpan = 4; td.textContent = "The artifact inventory could not be loaded from /api/evidence. ";
        var btn = document.createElement("button"); btn.type = "button"; btn.className = "link link-inline"; btn.setAttribute("data-ev-retry", ""); btn.textContent = "Retry";
        td.appendChild(btn); tr.appendChild(td); artifactBody.replaceChildren(tr);
      }
      doc.dataset.evidence = "error";
    });
  }
  /* r4: copy a full hash; the button says "Copied" for 1.6 s (role=status line announces it). */
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-copy]");
    if (!btn) return;
    var text = btn.getAttribute("data-copy");
    var done = function (ok) {
      btn.textContent = ok ? "Copied" : "Select";
      if (!ok) { var r = document.createRange(); r.selectNodeContents(btn.previousSibling); var sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); btn.previousSibling.textContent = text; }
      setTimeout(function () { btn.textContent = "Copy"; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    else done(false);
  });
  if (slots.length || artifactBody) {
    loadEvidence();
    document.addEventListener("click", function (e) {
      var b = e.target.closest("[data-ev-retry]");
      if (b) { e.preventDefault(); loadEvidence(); }
    });
  }

  doc.dataset.ready = "1";
})();
