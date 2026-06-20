// app.js — orchestration. Owns the aircraft model, runs the poll + render
// loops, detects fresh contacts, and wires the renderer + audio + HUD.
// Knows nothing about canvas drawing or feed formats — those live in
// renderer.js and datasource.js.

import { DataSource, MockDataSource, parseDump1090 } from "./datasource.js";
import { RadarRenderer } from "./renderer.js";
import { PingAudio } from "./audio.js";

// Committed defaults (config.js) merged with personal values (site.js / .env).
const BASE = window.RADAR_CONFIG;
const SITE = window.RADAR_SITE || {};
const CONFIG = {
  ...BASE, ...SITE,
  receiver: { ...BASE.receiver, ...(SITE.receiver || {}) },
};
const EMERGENCY_SQUAWKS = new Set(["7500", "7600", "7700"]);

// ── Model ──────────────────────────────────────────────────────────────────
// Map<icao, AircraftView>. The model is renderer-agnostic state.
class RadarModel {
  constructor(config) {
    this.config = config;
    this.aircraft = new Map();
  }

  /** Merge a fresh poll. Returns the list of icaos that are NEW this tick. */
  ingest(list, nowMs) {
    const fresh = [];
    const seen = new Set();
    for (const a of list) {
      if (!a.icao) continue;
      seen.add(a.icao);
      const emergency = a.squawk ? EMERGENCY_SQUAWKS.has(a.squawk) : false;
      let ac = this.aircraft.get(a.icao);
      if (!ac) {
        ac = {
          icao: a.icao,
          firstSeen: nowMs,
          trail: [],
          pulseStart: nowMs,   // <- triggers the flare ring
          alpha: 1,
        };
        this.aircraft.set(a.icao, ac);
        fresh.push(ac);
      }
      // update live fields
      ac.callsign = a.callsign;
      ac.registration = a.registration;
      ac.lat = a.lat;
      ac.lon = a.lon;
      ac.altFt = a.altFt;
      ac.gsKt = a.gsKt;
      ac.trackDeg = a.trackDeg;
      ac.squawk = a.squawk;
      ac.emergency = emergency;
      ac.lastSeen = nowMs;
      ac.alpha = 1;
      // append to trail only when the position actually moved
      const last = ac.trail[ac.trail.length - 1];
      if (!last || last.lat !== a.lat || last.lon !== a.lon) {
        ac.trail.push({ lat: a.lat, lon: a.lon, t: nowMs });
        // prune by age (feed-rate independent), then by a hard count cap
        const cutoff = nowMs - this.config.trailSec * 1000;
        while (ac.trail.length && ac.trail[0].t < cutoff) ac.trail.shift();
        if (ac.trail.length > this.config.trailLength) ac.trail.shift();
      }
    }
    return fresh;
  }

  /** Dim then evict aircraft that have gone silent. Contacts hold full
   *  brightness until fadeStartSec, then decay linearly to 0 at staleSec. */
  expire(nowMs) {
    const staleMs = this.config.staleSec * 1000;
    const fadeStartMs = (this.config.fadeStartSec ?? 8) * 1000;
    const span = Math.max(1, staleMs - fadeStartMs);
    for (const [icao, ac] of this.aircraft) {
      const age = nowMs - ac.lastSeen;
      if (age > staleMs) {
        this.aircraft.delete(icao);
      } else if (age > fadeStartMs) {
        ac.alpha = Math.max(0, 1 - (age - fadeStartMs) / span);
      } else {
        ac.alpha = 1;
      }
    }
  }

  /** Seed trails from a server snapshot so a page refresh shows existing
   *  history immediately. rawList carries `trail: [[lat,lon,ageSec], …]`.
   *  Only seeds aircraft whose client trail is still essentially empty. */
  seedTrails(rawList, nowMs) {
    for (const r of rawList || []) {
      if (!r.trail || !r.hex) continue;
      const ac = this.aircraft.get(r.hex.toLowerCase());
      if (!ac || ac.trail.length > 1) continue;
      ac.trail = r.trail.map(([lat, lon, ageSec]) => ({
        lat, lon, t: nowMs - ageSec * 1000,
      }));
    }
  }

  /** Clear an aircraft's flare once its animation has finished. */
  clearStalePulses(nowMs) {
    for (const ac of this.aircraft.values()) {
      if (ac.pulseStart != null && nowMs - ac.pulseStart > this.config.pulseMs) {
        ac.pulseStart = null;
      }
    }
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────
const canvas = document.getElementById("scope");
const renderer = new RadarRenderer(canvas, CONFIG);
const model = new RadarModel(CONFIG);
const useMock = new URLSearchParams(location.search).has("mock");
const source = useMock ? new MockDataSource(CONFIG) : new DataSource(CONFIG);
const audio = new PingAudio(CONFIG.ping);

const hud = {
  count: document.getElementById("count"),
  status: document.getElementById("status"),
  source: document.getElementById("source"),
  clock: document.getElementById("clock"),
  mute: document.getElementById("mute"),
  range: document.getElementById("range"),
  layers: document.getElementById("layers"),
};

let muted = !CONFIG.ping.enabled;
let lastOk = 0;
let sweepDeg = 0;
let lastFrame = performance.now();

window.addEventListener("resize", () => renderer.resize());

// audio needs a user gesture to start
function enableAudio() {
  audio.unlock();
  window.removeEventListener("pointerdown", enableAudio);
}
window.addEventListener("pointerdown", enableAudio);

hud.mute.addEventListener("click", () => {
  muted = !muted;
  audio.setEnabled(!muted);
  audio.unlock();
  hud.mute.textContent = muted ? "♪ muted" : "♪ on";
  hud.mute.classList.toggle("off", muted);
});
hud.mute.textContent = muted ? "♪ muted" : "♪ on";
hud.mute.classList.toggle("off", muted);

// ── Map overlays (optional; app works fine if data/ files are absent) ───────
// serve.py auto-generates these in the background on first run, so we retry a
// few times until they appear, then stop.
async function loadOverlays(attempt = 0) {
  const want = [
    ["states", "data/states.geojson"],
    ["artcc", "data/artcc.geojson"],
    ["airports", "data/airports.json"],
  ];
  const out = {};
  let missing = 0;
  for (const [key, url] of want) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) out[key] = await r.json();
      else missing++;
    } catch (_) { missing++; }
  }
  renderer.setOverlays(out);
  if (missing && attempt < 24) setTimeout(() => loadOverlays(attempt + 1), 5000);
}
loadOverlays();

// ── Zoom: scroll wheel + / - keys change RANGE, not page size ───────────────
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
  renderer.setRange(renderer.getRange() * factor);
}, { passive: false });

window.addEventListener("keydown", (e) => {
  if (e.key === "+" || e.key === "=") renderer.setRange(renderer.getRange() / 1.2);
  else if (e.key === "-" || e.key === "_") renderer.setRange(renderer.getRange() * 1.2);
  else if (e.key === "0") renderer.setRange(CONFIG.rangeNm);
});

// ── Layers box: a checkbox per visual layer, wired live to the renderer ─────
const LAYER_LABELS = {
  states: "State borders", artcc: "ATC centers", airports: "Airports",
  trails: "Trails", vectors: "Leader lines", sweep: "Sweep", labels: "Data blocks",
};
for (const key of Object.keys(renderer.layers)) {
  const id = `lyr_${key}`;
  const row = document.createElement("label");
  row.className = "layer-row";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.id = id;
  cb.checked = !!renderer.layers[key];
  cb.addEventListener("change", () => renderer.setLayers({ [key]: cb.checked }));
  const txt = document.createElement("span");
  txt.textContent = LAYER_LABELS[key] || key;
  row.append(cb, txt);
  hud.layers.append(row);
}

// ── Shared update path (used by both WebSocket push and HTTP poll) ──────────
// `silent` suppresses pings for the initial batch (a full snapshot/first poll),
// so we only chime for genuinely new contacts heard after we're primed.
let primed = false;
function applyUpdate(aircraft, srcLabel, silent) {
  const now = performance.now();
  const fresh = model.ingest(aircraft, now);
  lastOk = Date.now();
  if (!silent && primed) {
    for (const ac of fresh) {
      if (!muted) audio.ping({ warn: ac.emergency });
    }
  }
  primed = true;
  if (srcLabel) hud.source.textContent = srcLabel;
  hud.status.textContent = "● LINK";
  hud.status.className = "ok";
}

function setNoSignal(e) {
  hud.status.textContent = "● NO SIGNAL";
  hud.status.className = "err";
  hud.source.textContent = String(e?.message || e || "");
}

// ── HTTP poll loop (fallback when WebSocket isn't available) ────────────────
let pollTimer = null;
async function poll() {
  try {
    const { aircraft, source: src } = await source.poll();
    applyUpdate(aircraft, src, false);
  } catch (e) {
    setNoSignal(e);
  }
}
function startPolling() {
  if (pollTimer) return;
  poll();
  pollTimer = setInterval(poll, CONFIG.pollMs);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── WebSocket live push (preferred in proxy mode; readsb pushes as it hears) ─
let ws = null, wsRetry = null;
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws`;
  try { ws = new WebSocket(url); } catch (_) { scheduleWSRetry(); return; }

  ws.onopen = () => stopPolling();          // push is live; stop the fallback
  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      const silent = data.type === "snapshot";
      applyUpdate(parseDump1090(data), "readsb/SBS · live push (ws)", silent);
      if (silent) model.seedTrails(data.aircraft, performance.now()); // restore history
    } catch (_) { /* ignore malformed frame */ }
  };
  ws.onclose = () => { ws = null; startPolling(); scheduleWSRetry(); };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}
function scheduleWSRetry() {
  if (wsRetry) return;
  wsRetry = setTimeout(() => { wsRetry = null; connectWS(); }, 4000);
}

// ── Render loop ──────────────────────────────────────────────────────────
function frame() {
  const now = performance.now();
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;

  if (CONFIG.sweepRpm > 0) {
    sweepDeg = (sweepDeg + (CONFIG.sweepRpm * 360 / 60) * dt) % 360;
  }

  model.expire(now);          // lastSeen is stamped on this same perf clock
  model.clearStalePulses(now);
  const { offScope } = renderer.render(now, { aircraft: model.aircraft, sweepDeg });

  const n = model.aircraft.size;
  hud.count.textContent = `${n} contact${n === 1 ? "" : "s"}${offScope ? ` (+${offScope} off-scope)` : ""}`;
  hud.clock.textContent = new Date().toLocaleTimeString([], { hour12: false });
  hud.range.textContent = `RNG ${Math.round(renderer.getRange())}nm`;

  requestAnimationFrame(frame);
}

// Mock + direct mode poll over HTTP. Proxy mode prefers the WebSocket push
// (serve.py /ws) and keeps polling running until the socket actually opens.
startPolling();
if (!useMock && CONFIG.mode === "proxy") connectWS();
requestAnimationFrame(frame);
