// config.js — edit this to point the scope at your feeder.
// Loaded as a normal script before the app module, exposed as window.RADAR_CONFIG.
window.RADAR_CONFIG = {
  // ── Receiver location + feeder (personal — DO NOT COMMIT real values) ────
  // These are placeholder fallbacks. Your real values live in .env (gitignored)
  // and are injected at runtime by site.js, which serve.py generates from .env.
  // Edit these only if you open the page WITHOUT serve.py (static/direct mode),
  // or create a static site.js. See .env.example.
  receiver: {
    lat: 0,
    lon: 0,
    label: "HOME",
  },

  // ── Where to get aircraft data ───────────────────────────────────────────
  // mode "direct": browser fetches the feeder URLs below itself.
  //   Works only if the feeder sends permissive CORS headers (tar1090 does;
  //   plain dump1090-fa / fr24feed often do NOT). If you see CORS errors in
  //   the console, switch to "proxy" and run:  python serve.py --host <feeder>
  // mode "proxy": browser fetches local /feed/<i>, served by serve.py, which
  //   relays to the feeder server-side (no CORS issue). serve.py also bridges
  //   readsb's raw SBS stream (tcp/30003) to /feed/sbs and the client prefers
  //   it automatically — richer + faster than fr24's flights.json.
  mode: "proxy",

  host: "your-feeder.local",   // overridden by site.js/.env in proxy mode

  // Tried in order; first one that returns aircraft wins and is remembered.
  // format: "dump1090" (aircraft.json) or "fr24" (flights.json).
  endpoints: [
    { url: "http://{host}:8754/dump1090/data/aircraft.json", format: "dump1090" },
    { url: "http://{host}/tar1090/data/aircraft.json",       format: "dump1090" },
    { url: "http://{host}/skyaware/data/aircraft.json",      format: "dump1090" },
    { url: "http://{host}:8080/data/aircraft.json",          format: "dump1090" },
    { url: "http://{host}:8754/flights.json",                format: "fr24"     },
  ],

  pollMs: 1000,          // how often to fetch the feed

  // ── Scope geometry ─────────────────────────────────────────────────────
  rangeNm: 60,           // radius of the outermost ring, nautical miles
  minRangeNm: 3,         // closest zoom (scroll wheel / +- keys)
  maxRangeNm: 400,       // farthest zoom (don't exceed fetch_overlays radius)
  rangeRings: 4,         // number of concentric range rings
  sweepRpm: 12,          // radar sweep speed (revolutions per minute); 0 = off

  // ── New-contact behavior (the whole point) ───────────────────────────────
  pulseMs: 2200,         // duration of the flare ring when a new plane appears
  fadeStartSec: 8,       // start dimming a contact after this much silence
  staleSec: 25,          // fully faded + dropped at this much silence
  trailSec: 120,         // ACTUAL trail length: keep points from the last N seconds
  trailLength: 5000,     // absurd backstop only — guards render cost vs a jittery
                         //   high-rate feed; trailSec is the real limiter. Points
                         //   are added only on movement, so a parked blip adds none.

  // ── Audio ──────────────────────────────────────────────────────────────
  ping: {
    enabled: true,
    volume: 0.25,
  },

  // ── Map overlays (run fetch_overlays.py to generate data/*.json) ─────────
  overlays: {                // colors for each map layer
    states: "#11633a",       // state borders — dim green
    artcc: "#1a7f9c",        // ATC center boundaries — teal
    airports: "#caa23a",     // airport markers — amber
  },

  // Initial layer visibility (toggle live in the LAYERS box on screen).
  layers: {
    states: true,
    artcc: true,
    airports: true,
    trails: true,
    vectors: true,           // heading/speed leader lines
    sweep: true,
    labels: true,
  },

  // ── Look ─────────────────────────────────────────────────────────────────
  theme: {
    phosphor: "#39ff7a",   // primary green
    phosphorDim: "#1f8f48",
    bg: "#020a04",
    grid: "#0c5a2a",
    warn: "#ff5b4d",       // emergency squawks
    font: "12px 'DejaVu Sans Mono', 'Consolas', monospace",
  },
};
