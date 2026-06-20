// datasource.js — fetch + parse + normalize feeder data.
// Mirrors the parsing in flight_tracker.py so the scope sees the same fields.
//
// Normalized aircraft shape (one object per plane with a position fix):
//   { icao, callsign, registration, lat, lon, altFt, gsKt, trackDeg, squawk }

function normHex(s) {
  return String(s || "").trim().toLowerCase();
}

export function parseDump1090(data) {
  const out = [];
  for (const ac of data.aircraft || []) {
    if (ac.lat == null || ac.lon == null) continue; // no position fix yet
    out.push({
      icao: normHex(ac.hex),
      callsign: (ac.flight || "").trim(),
      registration: (ac.r || "").trim(),
      lat: +ac.lat,
      lon: +ac.lon,
      altFt: typeof ac.alt_baro === "number" ? ac.alt_baro : null,
      gsKt: ac.gs != null ? Math.round(+ac.gs) : null,
      trackDeg: ac.track != null ? +ac.track : null,
      squawk: ac.squawk || null,
    });
  }
  return out;
}

export function parseFr24(data) {
  // flights.json: keyed by FR24 flight id, value is a positional array.
  // [hex, lat, lon, track, alt, speed, squawk, radar, type, reg,
  //  timestamp, origin, dest, callsign, ...]
  const out = [];
  for (const key of Object.keys(data)) {
    const v = data[key];
    if (!Array.isArray(v) || v.length < 14) continue; // skip full_count/version/stats
    try {
      const lat = +v[1], lon = +v[2];
      if (lat === 0 && lon === 0) continue;
      let callsign = v[13] ? String(v[13]).trim() : "";
      if (!callsign && v.length > 16 && v[16]) callsign = String(v[16]).trim();
      out.push({
        icao: normHex(v[0]),
        callsign,
        registration: v[9] ? String(v[9]).trim() : "",
        lat, lon,
        altFt: v[4] !== null && v[4] !== "" ? parseInt(v[4], 10) : null,
        gsKt: v[5] !== null && v[5] !== "" ? parseInt(v[5], 10) : null,
        trackDeg: v[3] !== null && v[3] !== 0 && v[3] !== "" ? +v[3] : null,
        squawk: v[6] !== null && v[6] !== "" && v[6] !== 0 ? String(v[6]) : null,
      });
    } catch (_) { /* skip malformed row */ }
  }
  return out;
}

const PARSERS = { dump1090: parseDump1090, fr24: parseFr24 };

/**
 * MockDataSource — fake traffic for development (?mock=1). Same poll() contract
 * as DataSource: returns { aircraft, source }. Planes drift along their track,
 * and a new one occasionally appears so you can see the flare + hear the ping.
 */
export class MockDataSource {
  constructor(config) {
    this.config = config;
    this.planes = [];
    this.seq = 0;
    this.ticks = 0;
    for (let i = 0; i < 6; i++) this._spawn();
  }

  _spawn() {
    const c = this.config.receiver;
    const ang = (this.seq * 47) % 360;                 // deterministic spread
    const distNm = 8 + ((this.seq * 13) % (this.config.rangeNm - 10));
    const nmPerDeg = 60;
    const lat = c.lat + (distNm / nmPerDeg) * Math.cos((ang * Math.PI) / 180);
    const lon = c.lon + (distNm / nmPerDeg) * Math.sin((ang * Math.PI) / 180)
      / Math.cos((c.lat * Math.PI) / 180);
    const id = (0xa00000 + this.seq * 0x111).toString(16);
    this.planes.push({
      icao: id,
      callsign: "MOCK" + (100 + this.seq),
      registration: "N" + (1000 + this.seq),
      lat, lon,
      altFt: 5000 + ((this.seq * 1700) % 35000),
      gsKt: 220 + ((this.seq * 37) % 240),
      trackDeg: (this.seq * 61) % 360,
      squawk: this.seq % 11 === 0 ? "7700" : "1200",
    });
    this.seq++;
  }

  async poll() {
    this.ticks++;
    // drift each plane forward along its track
    const stepNm = 0.25;
    for (const p of this.planes) {
      const a = (p.trackDeg * Math.PI) / 180;
      p.lat += (stepNm / 60) * Math.cos(a);
      p.lon += (stepNm / 60) * Math.sin(a)
        / Math.cos((this.config.receiver.lat * Math.PI) / 180);
    }
    // every ~6 polls, retire the oldest and introduce a fresh contact
    if (this.ticks % 6 === 0) {
      if (this.planes.length > 8) this.planes.shift();
      this._spawn();
    }
    return { aircraft: this.planes.map((p) => ({ ...p })), source: "MOCK feed (dev)" };
  }
}

/**
 * Resolves an endpoint list to fetchable URLs, auto-detects which one works,
 * and returns normalized aircraft. Remembers the winner for subsequent polls.
 */
export class DataSource {
  constructor(config) {
    this.config = config;
    this.active = null;            // key of the endpoint that last succeeded
    this.lastError = null;
  }

  /** Unified candidate list: {key, url, format}. */
  _candidates() {
    const eps = this.config.endpoints;
    if (this.config.mode === "proxy") {
      // The SBS bridge (readsb via serve.py) is richest/fastest — try it first.
      return [
        { key: "sbs", url: "feed/sbs", format: "dump1090" },
        ...eps.map((ep, i) => ({ key: i, url: `feed/${i}`, format: ep.format })),
      ];
    }
    return eps.map((ep, i) => ({
      key: i, url: ep.url.replace("{host}", this.config.host), format: ep.format,
    }));
  }

  async _fetch(url) {
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  /** Returns { aircraft, source } or throws if no endpoint responds. */
  async poll() {
    const cands = this._candidates();
    // Try the known-good endpoint first, then fall back to scanning the rest.
    const order = this.active != null
      ? [...cands.filter((c) => c.key === this.active),
         ...cands.filter((c) => c.key !== this.active)]
      : cands;

    let lastErr = null;
    for (const c of order) {
      try {
        const data = await this._fetch(c.url);
        const aircraft = PARSERS[c.format](data);
        this.active = c.key;
        this.lastError = null;
        const tag = c.key === "sbs" ? "readsb/SBS" : c.format;
        return { aircraft, source: `${tag} @ ${c.url}` };
      } catch (e) {
        lastErr = { url: c.url, e };
        if (this.active === c.key) this.active = null; // winner went away; rescan
      }
    }
    this.lastError = lastErr;
    throw new Error(`No feeder endpoint responded. Last tried ${lastErr?.url}: ${lastErr?.e}`);
  }
}
