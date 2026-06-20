#!/usr/bin/env python3
"""
fetch_overlays.py — download map overlays once, clipped to your area, into
radar/data/. Re-run occasionally to refresh (airports/ARTCC change rarely).

    python fetch_overlays.py                       # uses RADAR_LAT/LON from .env
    python fetch_overlays.py --lat 40.7 --lon -74.0 --radius-nm 250   # or override

Writes:
    data/states.geojson    US state borders (whole, rounded)
    data/artcc.geojson      ARTCC (ATC center) boundaries, clipped to bbox
    data/airports.json      large+medium airports within the bbox

Stdlib only. Sources are public (US Census-derived states, FAA ArcGIS ARTCC,
OurAirports). Clipping keeps the saved files small even though ARTCC raw is ~20MB.
"""
import argparse
import csv
import io
import json
import math
import os
import urllib.request

from envload import load_env

STATES_URL = "https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json"
ARTCC_URL = "https://opendata.arcgis.com/datasets/67885972e4e940b2aa6d74024901c561_0.geojson"
AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "radar-overlays/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def bbox_for(lat, lon, radius_nm):
    dlat = radius_nm / 60.0
    dlon = radius_nm / (60.0 * max(0.1, math.cos(math.radians(lat))))
    return (lon - dlon, lat - dlat, lon + dlon, lat + dlat)  # minx,miny,maxx,maxy


def round_coords(coords, nd=4):
    """Recursively round coordinate numbers to nd decimals (shrinks files)."""
    if isinstance(coords, list):
        if coords and isinstance(coords[0], (int, float)):
            return [round(c, nd) for c in coords]
        return [round_coords(c, nd) for c in coords]
    return coords


def feature_bbox(geom):
    minx = miny = math.inf
    maxx = maxy = -math.inf

    def walk(c):
        nonlocal minx, miny, maxx, maxy
        if isinstance(c, list) and c and isinstance(c[0], (int, float)):
            x, y = c[0], c[1]
            minx, maxx = min(minx, x), max(maxx, x)
            miny, maxy = min(miny, y), max(maxy, y)
        elif isinstance(c, list):
            for sub in c:
                walk(sub)

    walk(geom.get("coordinates", []))
    return minx, miny, maxx, maxy


def bbox_overlap(a, b):
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def fetch_states():
    fc = json.loads(get(STATES_URL))
    for f in fc.get("features", []):
        f["geometry"]["coordinates"] = round_coords(f["geometry"]["coordinates"], 3)
        f["properties"] = {"name": f.get("properties", {}).get("name", "")}
    out = os.path.join(DATA, "states.geojson")
    with open(out, "w") as fh:
        json.dump(fc, fh)
    print(f"  states.geojson: {len(fc['features'])} states, {os.path.getsize(out)//1024} KB")


def fetch_artcc(box, type_codes, level):
    # The FAA layer mixes ARTCC / ADIZ / TRSA / FIR / etc.; TYPE_CODE selects.
    # Each ARTCC is stored TWICE: a high (LEVEL_=U / ARTCC_H) and low (LEVEL_=L)
    # sector boundary that differ slightly — drawing both doubles every line and
    # leaves slivers where adjacent centers' high/low boundaries cross. `level`
    # picks one: "U" (high, default), "L" (low), or "both".
    # Reuse a cached raw download (~20MB) if present so re-runs are instant.
    raw_path = os.path.join(DATA, "_artcc_raw.json")
    if os.path.exists(raw_path):
        with open(raw_path) as fh:
            fc = json.load(fh)
    else:
        fc = json.loads(get(ARTCC_URL))
        with open(raw_path, "w") as fh:
            json.dump(fc, fh)
    kept = []
    for f in fc.get("features", []):
        p = f.get("properties", {})
        if p.get("TYPE_CODE") not in type_codes:
            continue
        # Apply the high/low filter only to features that actually have a level.
        lvl = p.get("LEVEL_")
        if level != "both" and lvl in ("U", "L") and lvl != level:
            continue
        g = f.get("geometry")
        if not g or not bbox_overlap(feature_bbox(g), box):
            continue
        g["coordinates"] = round_coords(g["coordinates"], 4)
        f["properties"] = {"name": p.get("NAME", ""), "type": p.get("TYPE_CODE", ""),
                           "level": lvl}
        kept.append(f)
    out = os.path.join(DATA, "artcc.geojson")
    with open(out, "w") as fh:
        json.dump({"type": "FeatureCollection", "features": kept}, fh)
    print(f"  artcc.geojson: {len(kept)} {'/'.join(sorted(type_codes))} boundaries in range, {os.path.getsize(out)//1024} KB")


def fetch_airports(box, types):
    raw = get(AIRPORTS_URL).decode("utf-8", "replace")
    rdr = csv.DictReader(io.StringIO(raw))
    minx, miny, maxx, maxy = box
    out = []
    for row in rdr:
        if row["type"] not in types:
            continue
        try:
            lat = float(row["latitude_deg"]); lon = float(row["longitude_deg"])
        except (ValueError, KeyError):
            continue
        if not (minx <= lon <= maxx and miny <= lat <= maxy):
            continue
        out.append({
            "ident": row.get("ident", ""),
            "iata": row.get("iata_code", ""),
            "name": row.get("name", ""),
            "type": row["type"],
            "lat": round(lat, 5),
            "lon": round(lon, 5),
        })
    path = os.path.join(DATA, "airports.json")
    with open(path, "w") as fh:
        json.dump(out, fh)
    print(f"  airports.json: {len(out)} airports ({'/'.join(t.split('_')[0] for t in types)}), {os.path.getsize(path)//1024} KB")


def generate(lat, lon, radius_nm=250,
             airport_types=("large_airport", "medium_airport"),
             artcc_types=("ARTCC",), artcc_level="U"):
    """Generate all overlay files for a location. Importable by serve.py."""
    os.makedirs(DATA, exist_ok=True)
    box = bbox_for(lat, lon, radius_nm)
    print(f"Clipping overlays to {radius_nm}nm around {lat},{lon} …")
    fetch_states()
    fetch_artcc(box, set(artcc_types), artcc_level)
    fetch_airports(box, set(airport_types))
    print("Overlays done.")


def have_overlays():
    return all(os.path.exists(os.path.join(DATA, f))
               for f in ("states.geojson", "artcc.geojson", "airports.json"))


def _envf(env, key):
    try:
        return float(env[key])
    except (KeyError, ValueError, TypeError):
        return None


def main():
    env = load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--lat", type=float, default=_envf(env, "RADAR_LAT"),
                    help="receiver latitude (default: RADAR_LAT in .env)")
    ap.add_argument("--lon", type=float, default=_envf(env, "RADAR_LON"),
                    help="receiver longitude (default: RADAR_LON in .env)")
    ap.add_argument("--radius-nm", type=float, default=250,
                    help="clip overlays to this radius (give yourself room to zoom out)")
    ap.add_argument("--airport-types", default="large_airport,medium_airport",
                    help="comma list: large_airport,medium_airport,small_airport")
    ap.add_argument("--artcc-types", default="ARTCC",
                    help="comma list of TYPE_CODE to keep: ARTCC,TRSA,ADIZ,FIR,CTA…")
    ap.add_argument("--artcc-level", default="U", choices=["U", "L", "both"],
                    help="ARTCC sector boundary: U=high (default), L=low, both")
    args = ap.parse_args()
    if args.lat is None or args.lon is None:
        ap.error("no location — set RADAR_LAT/RADAR_LON in .env (copy .env.example) or pass --lat/--lon")

    generate(args.lat, args.lon, args.radius_nm,
             tuple(args.airport_types.split(",")),
             tuple(args.artcc_types.split(",")), args.artcc_level)
    print("Reload the scope.")


if __name__ == "__main__":
    main()
