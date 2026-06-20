# ADSB Radar Terminal

A radar-scope web frontend for ADS-B receivers — **readsb / dump1090 / tar1090 / fr24feed**.
Live blips that **flare and ping the instant a new aircraft is heard**, then relax to a
steady contact; fading trails; a rotating sweep; and toggleable map overlays for state
borders, ARTCC (ATC center) boundaries, and airports.

It's built to feel like sitting at a radar scope rather than looking at a map — though a
real map view can drop in behind the same renderer interface later.

```
scroll = zoom   ·   +/− keys   ·   0 = reset   ·   click = unlock audio
```

## Features

- **Fresh-contact flare + ping** — a newly heard ICAO triggers an expanding ring and a
  soft WebAudio blip (higher pitch for emergency squawks), then settles to a normal dot.
- **Live push** — connects to readsb's raw **SBS/BaseStation** stream and pushes updates
  over a WebSocket as they arrive, not on a fixed poll clock. Falls back to HTTP polling
  automatically.
- **Server-side trails** — the server keeps recent position history per aircraft and ships
  it in the connect snapshot, so a page refresh redraws every existing trail instantly.
- **Map overlays** — US state borders, ARTCC high-altitude boundaries, and large/medium
  airports, auto-downloaded and clipped to your area on first run.
- **Radar furniture** — range rings (nm-labeled), cardinal spokes, rotating sweep with
  target illumination, vector leader lines with arrowheads, per-contact data blocks
  (callsign / squawk / altitude / speed).
- **Layers box + zoom** — toggle any layer live; scroll-wheel range zoom.
- **No build step, minimal deps** — vanilla ES modules in the browser; a single stdlib-only
  Python server (no `pip install`).

## How it works

```
ADS-B feeder ──(SBS tcp/30003 or HTTP aircraft.json)──> serve.py ──(WebSocket /ws)──> browser
                                                            │
                                                  /feed/*  (CORS proxy, fallback)
                                                  /site.js (runtime config from .env)
                                                  data/*   (map overlays, auto-generated)
```

- **serve.py** serves the page, proxies HTTP feeders (to dodge CORS), bridges readsb's SBS
  stream into `aircraft.json`, pushes live updates over `/ws`, injects per-deployment
  config via `/site.js`, and auto-generates map overlays on first run.
- The browser prefers the WebSocket; if it's unavailable it polls `/feed/sbs`, then any
  configured HTTP `aircraft.json`/`flights.json` endpoint.

## Requirements

- Python 3.8+ (standard library only)
- An ADS-B feeder reachable on your network, exposing **any** of:
  - readsb / dump1090 **SBS BaseStation** stream on tcp/30003 *(richest + fastest)*
  - a dump1090/tar1090/skyaware/readsb **`aircraft.json`** over HTTP
  - fr24feed **`flights.json`**
- A modern browser.

## Quick start

```bash
cp .env.example .env       # set your feeder host + receiver lat/lon
python serve.py            # starts on http://localhost:8000
```

Open <http://localhost:8000/> and click once to enable audio. On first run the map
overlays download and clip to your area in the background (~3s) and appear within a few
seconds — no separate step needed.

No feeder handy? Try the built-in simulator:

```
http://localhost:8000/?mock=1
```

## Configuration

Personal/deployment values live in **`.env`** (gitignored) so nothing identifying is
committed. They're injected into the browser at runtime via `/site.js`.

| `.env` key       | Meaning                                   |
|------------------|-------------------------------------------|
| `RADAR_HOST`     | feeder hostname/IP                        |
| `RADAR_LAT`/`LON`| receiver location (scope center)          |
| `RADAR_LABEL`    | label drawn at center                     |
| `RADAR_SBS_PORT` | SBS/BaseStation port (default 30003)      |

Look-and-feel tunables live in [`config.js`](config.js) — range, sweep speed, ping volume,
fade/stale timing, trail length, layer defaults, and theme colors. Map overlays can be
regenerated or re-scoped any time:

```bash
python fetch_overlays.py                 # uses .env location
python fetch_overlays.py --radius-nm 400 # wider area
python fetch_overlays.py --artcc-level both  # high + low ARTCC boundaries
```

### Feeder modes

`config.js` `mode` is `proxy` by default (browser talks to `serve.py`, which relays to the
feeder — required for CORS and for the SBS bridge). Set it to `direct` only if your feeder
serves `aircraft.json` with permissive CORS headers and you don't need the SBS bridge.

## Architecture

The render layer is isolated behind a small interface (`resize` / `project` / `render` /
`setOverlays` / `setLayers`), so the scope can be swapped for — or overlaid on — a real map
view without touching the data or model code.

| File | Role |
|------|------|
| [`index.html`](index.html) | CRT-styled shell, HUD, layers box |
| [`config.js`](config.js) | committed defaults + tunables (no personal data) |
| [`js/datasource.js`](js/datasource.js) | fetch/parse/normalize (dump1090 + fr24), mock source |
| [`js/renderer.js`](js/renderer.js) | `RadarRenderer` — the scope (swappable interface) |
| [`js/audio.js`](js/audio.js) | WebAudio ping |
| [`js/app.js`](js/app.js) | model, new-contact detection, WS/poll transport, UI wiring |
| [`serve.py`](serve.py) | static server, CORS proxy, SBS→JSON bridge, WebSocket push |
| [`fetch_overlays.py`](fetch_overlays.py) | download + clip map overlays |
| [`envload.py`](envload.py) | tiny `.env` reader |

## Data & acknowledgements

Map overlays are built from public datasets, clipped locally to your area:

- **State borders** — US Census–derived GeoJSON
- **ARTCC boundaries** — FAA ArcGIS aeronautical data
- **Airports** — [OurAirports](https://ourairports.com/) public data

## License

MIT — see [LICENSE](LICENSE).
