// renderer.js — RadarRenderer: draws the scope to a <canvas>.
//
// ── Renderer interface ───────────────────────────────────────────────────
// Any renderer (this scope, or a future Leaflet/satellite MapRenderer) must
// implement:
//
//   resize()                         -> recompute layout for the canvas size
//   project(lat, lon)                -> { x, y, rangeNm, bearingDeg, onScope }
//   render(nowMs, state)             -> draw one frame
//   setRange(nm) / getRange()        -> zoom (nm to the outer ring)
//   setOverlays({states,artcc,airports})
//   setLayers({states,artcc,...})    -> per-layer visibility
//
// where `state` is:
//   { aircraft: Map<icao, AircraftView>, sweepDeg: number }
//
// and AircraftView (produced by the model) carries:
//   { icao, callsign, lat, lon, altFt, gsKt, trackDeg, squawk,
//     firstSeen, lastSeen, trail: [{lat,lon}], pulseStart|null,
//     emergency: bool, alpha: 0..1 }
//
// app.js never touches canvas APIs, so swapping in a map view means writing a
// new class with these methods and changing one line in app.js.
// ─────────────────────────────────────────────────────────────────────────

const KM_PER_DEG = 111.32;
const NM_PER_KM = 1 / 1.852;

const DEFAULT_LAYERS = {
  states: true, artcc: true, airports: true,
  trails: true, vectors: true, sweep: true, labels: true,
};
const DEFAULT_OVERLAY_COLORS = {
  states: "#11633a", artcc: "#1a7f9c", airports: "#caa23a",
};

export class RadarRenderer {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.config = config;
    this.theme = config.theme;
    this.rangeNm = config.rangeNm;
    this.minRangeNm = config.minRangeNm || 3;
    this.maxRangeNm = config.maxRangeNm || 600;
    this.overlays = { states: null, artcc: null, airports: [] };
    this.layers = { ...DEFAULT_LAYERS, ...(config.layers || {}) };
    this.overlayColors = { ...DEFAULT_OVERLAY_COLORS, ...(config.overlays || {}) };
    this.resize();
  }

  // ── public API ──────────────────────────────────────────────────────────
  getRange() { return this.rangeNm; }

  setRange(nm) {
    this.rangeNm = Math.max(this.minRangeNm, Math.min(this.maxRangeNm, nm));
    this.scale = this.R / this.rangeNm;
    return this.rangeNm;
  }

  setOverlays(o) { Object.assign(this.overlays, o); }
  setLayers(o) { Object.assign(this.layers, o); }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
    this.cx = w / 2;
    this.cy = h / 2;
    this.R = Math.min(w, h) / 2 - 28;       // outer ring radius in px
    this.scale = this.R / this.rangeNm;     // px per nm
  }

  project(lat, lon) {
    const c = this.config.receiver;
    const nmNorth = (lat - c.lat) * KM_PER_DEG * NM_PER_KM;
    const nmEast = (lon - c.lon) * KM_PER_DEG * Math.cos((c.lat * Math.PI) / 180) * NM_PER_KM;
    const rangeNm = Math.hypot(nmEast, nmNorth);
    let bearingDeg = (Math.atan2(nmEast, nmNorth) * 180) / Math.PI;
    if (bearingDeg < 0) bearingDeg += 360;
    return {
      x: this.cx + nmEast * this.scale,
      y: this.cy - nmNorth * this.scale,
      rangeNm,
      bearingDeg,
      onScope: rangeNm <= this.rangeNm,
    };
  }

  render(now, state) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    this._drawBackground();
    this._drawOverlays();           // map layers, under the radar furniture
    this._drawGrid();
    if (this.layers.sweep) this._drawSweep(state.sweepDeg);

    let offScope = 0;
    for (const ac of state.aircraft.values()) {
      const p = this.project(ac.lat, ac.lon);
      if (!p.onScope) { offScope++; continue; }
      this._drawAircraft(now, ac, p, state.sweepDeg);
    }

    this._drawCenter();
    return { offScope };
  }

  // ── private drawing helpers ──────────────────────────────────────────────

  _drawBackground() {
    const ctx = this.ctx;
    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    const g = ctx.createRadialGradient(this.cx, this.cy, this.R * 0.1, this.cx, this.cy, this.R);
    g.addColorStop(0, "rgba(20,80,40,0.10)");
    g.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, this.R, 0, Math.PI * 2);
    ctx.fill();
  }

  // Clip all map overlays to the scope circle so they never spill into corners.
  _drawOverlays() {
    const o = this.overlays;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, this.R, 0, Math.PI * 2);
    ctx.clip();
    if (this.layers.states && o.states) {
      this._drawGeo(o.states.features, this.overlayColors.states, 1, 0.6);
    }
    if (this.layers.artcc && o.artcc) {
      this._drawGeo(o.artcc.features, this.overlayColors.artcc, 1.2, 0.7);
    }
    ctx.restore();
    if (this.layers.airports && o.airports?.length) this._drawAirports();
  }

  _drawGeo(features, color, width, alpha) {
    if (!features) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.globalAlpha = alpha;
    for (const f of features) {
      const g = f.geometry;
      if (!g) continue;
      let rings = [];
      if (g.type === "Polygon") rings = g.coordinates;
      else if (g.type === "MultiPolygon") rings = g.coordinates.flat();
      else if (g.type === "LineString") rings = [g.coordinates];
      else if (g.type === "MultiLineString") rings = g.coordinates;
      for (const ring of rings) {
        ctx.beginPath();
        for (let i = 0; i < ring.length; i++) {
          const p = this.project(ring[i][1], ring[i][0]);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _drawAirports() {
    const ctx = this.ctx;
    const color = this.overlayColors.airports;
    ctx.save();
    ctx.font = this.theme.font;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const a of this.overlays.airports) {
      const p = this.project(a.lat, a.lon);
      if (!p.onScope) continue;
      const big = a.type === "large_airport";
      const s = big ? 4 : 2.5;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.globalAlpha = big ? 0.85 : 0.55;
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x - s, p.y - s, s * 2, s * 2);
      // label only large airports unless zoomed in, to limit clutter
      if (big || this.rangeNm <= 40) {
        ctx.globalAlpha = big ? 0.8 : 0.45;
        ctx.fillText(a.iata || a.ident, p.x, p.y + s + 1);
      }
    }
    ctx.restore();
  }

  _drawGrid() {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = this.theme.grid;
    ctx.fillStyle = this.theme.phosphorDim;
    ctx.lineWidth = 1;
    ctx.font = this.theme.font;

    const rings = this.config.rangeRings;
    for (let i = 1; i <= rings; i++) {
      const r = (this.R / rings) * i;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, r, 0, Math.PI * 2);
      ctx.stroke();
      const nm = Math.round((this.rangeNm / rings) * i);
      ctx.globalAlpha = 0.7;
      ctx.fillText(`${nm}`, this.cx + r * 0.70 + 2, this.cy - r * 0.70);
    }

    ctx.globalAlpha = 0.4;
    const dirs = [["N", 0], ["E", 90], ["S", 180], ["W", 270]];
    for (const [, deg] of dirs) {
      const a = ((deg - 90) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(this.cx, this.cy);
      ctx.lineTo(this.cx + Math.cos(a) * this.R, this.cy + Math.sin(a) * this.R);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = this.theme.phosphor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [label, deg] of dirs) {
      const a = ((deg - 90) * Math.PI) / 180;
      ctx.fillText(label, this.cx + Math.cos(a) * (this.R + 14), this.cy + Math.sin(a) * (this.R + 14));
    }
    ctx.restore();
  }

  _drawSweep(sweepDeg) {
    if (this.config.sweepRpm <= 0) return;
    const ctx = this.ctx;
    const a = ((sweepDeg - 90) * Math.PI) / 180;
    const trail = 0.9;
    ctx.save();
    ctx.translate(this.cx, this.cy);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, this.R, a - trail, a);
    ctx.closePath();
    const wedge = ctx.createRadialGradient(0, 0, 0, 0, 0, this.R);
    wedge.addColorStop(0, "rgba(57,255,122,0.18)");
    wedge.addColorStop(1, "rgba(57,255,122,0)");
    ctx.fillStyle = wedge;
    ctx.fill();
    ctx.strokeStyle = "rgba(57,255,122,0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * this.R, Math.sin(a) * this.R);
    ctx.stroke();
    ctx.restore();
  }

  _drawCenter() {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = this.theme.phosphor;
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = this.theme.font;
    ctx.fillStyle = this.theme.phosphorDim;
    ctx.textAlign = "center";
    ctx.fillText(this.config.receiver.label || "RX", this.cx, this.cy + 16);
    ctx.restore();
  }

  _drawAircraft(now, ac, p, sweepDeg) {
    const ctx = this.ctx;
    const color = ac.emergency ? this.theme.warn : this.theme.phosphor;

    let lit = 0;
    if (this.layers.sweep && this.config.sweepRpm > 0) {
      const d = ((sweepDeg - p.bearingDeg) % 360 + 360) % 360;
      if (d < 60) lit = 1 - d / 60;
    }

    ctx.save();
    ctx.globalAlpha = ac.alpha;

    // ── trail ──
    if (this.layers.trails && ac.trail && ac.trail.length > 1) {
      for (let i = 1; i < ac.trail.length; i++) {
        const a = this.project(ac.trail[i - 1].lat, ac.trail[i - 1].lon);
        const b = this.project(ac.trail[i].lat, ac.trail[i].lon);
        ctx.globalAlpha = ac.alpha * (i / ac.trail.length) * 0.5;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = ac.alpha;
    }

    // ── heading vector with arrowhead (shows direction of travel) ──
    if (this.layers.vectors && ac.trackDeg != null && ac.gsKt) {
      const len = Math.min(34, 8 + ac.gsKt / 18);
      const a = ((ac.trackDeg - 90) * Math.PI) / 180;
      const ex = p.x + Math.cos(a) * len;   // tip
      const ey = p.y + Math.sin(a) * len;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.globalAlpha = ac.alpha * 0.6;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      // arrowhead: two short wings swept back from the tip
      const wing = 5, spread = 0.42;
      ctx.globalAlpha = ac.alpha * 0.85;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex + wing * Math.cos(a + Math.PI - spread), ey + wing * Math.sin(a + Math.PI - spread));
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex + wing * Math.cos(a + Math.PI + spread), ey + wing * Math.sin(a + Math.PI + spread));
      ctx.stroke();
      ctx.globalAlpha = ac.alpha;
    }

    // ── new-contact flare ring ──
    if (ac.pulseStart != null) {
      const t = (now - ac.pulseStart) / this.config.pulseMs;
      if (t >= 0 && t <= 1) {
        const ease = 1 - Math.pow(1 - t, 2);
        const radius = 4 + ease * 26;
        ctx.globalAlpha = ac.alpha * (1 - t);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = ac.alpha;
      }
    }

    // ── blip ──
    const flare = ac.pulseStart != null
      ? Math.max(0, 1 - (now - ac.pulseStart) / this.config.pulseMs)
      : 0;
    const glow = Math.max(lit, flare);
    const r = 2.5 + glow * 2.5;
    if (glow > 0) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 6 + glow * 14;
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // ── data block: one datum per line — callsign / squawk / alt / speed ──
    if (this.layers.labels) {
      const lh = 11;             // line height
      const x = p.x + 7;
      ctx.font = this.theme.font;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";

      const lines = [
        { t: ac.callsign || ac.registration || ac.icao.toUpperCase(), a: 0.9, c: color },
      ];
      if (ac.squawk) {
        lines.push({ t: `Sqk ${ac.squawk}`, a: ac.emergency ? 1 : 0.6,
                     c: ac.emergency ? this.theme.warn : color });
      }
      if (ac.altFt != null) {
        // FL above 10,000 ft (e.g. FL350); thousands-of-feet below (9.9k ft)
        const altTxt = ac.altFt >= 10000
          ? `FL${String(Math.round(ac.altFt / 100)).padStart(3, "0")}`
          : `${(ac.altFt / 1000).toFixed(1)}k ft`;
        lines.push({ t: altTxt, a: 0.65, c: color });
      }
      if (ac.gsKt != null) lines.push({ t: `${ac.gsKt}kt`, a: 0.65, c: color });

      let ly = p.y - ((lines.length - 1) * lh) / 2;   // vertically centered
      for (const ln of lines) {
        ctx.fillStyle = ln.c;
        ctx.globalAlpha = ac.alpha * ln.a;
        ctx.fillText(ln.t, x, ly);
        ly += lh;
      }
    }

    ctx.restore();
  }
}
