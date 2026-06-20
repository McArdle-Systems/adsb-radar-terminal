#!/usr/bin/env python3
"""
serve.py — static server for the radar page, a CORS-dodging feed proxy, and an
SBS→aircraft.json bridge for readsb/dump1090 BaseStation streams (port 30003).

Configure your feeder host in .env (copy .env.example), then just:
    python serve.py

Or override on the CLI:
    python serve.py --host my-feeder.local        # any fr24/dump1090/readsb host

The SBS bridge (tcp/30003) is on by default; disable with --no-sbs.
Then open http://localhost:8000/

Routes:
    /site.js     browser config injected from .env (keeps personal data uncommitted)
    /feed/<i>    relays config.js endpoints[i] (HTTP feeders, dodges CORS)
    /feed/sbs    aircraft.json assembled live from the SBS stream (readsb)
    /ws          WebSocket live push of updates from the SBS bridge

The SBS stream sends one field per message type (position, velocity, callsign,
altitude arrive separately), so the bridge merges them per ICAO over time.
Disable with --no-sbs.
"""
import argparse
import base64
import hashlib
import json
import os
import queue
import socket
import threading
import time
import urllib.request
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

import fetch_overlays
from envload import load_env

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"   # RFC 6455 magic
BROADCAST_SEC = 0.1                                 # push cadence when data changes
SERVER_TRAIL_SEC = 240                              # per-aircraft history kept for snapshots

# Mirror of config.js `endpoints` (same order). format is unused here — we just
# relay the raw JSON body and let the browser parse it.
ENDPOINTS = [
    "http://{host}:8754/dump1090/data/aircraft.json",
    "http://{host}/tar1090/data/aircraft.json",
    "http://{host}/skyaware/data/aircraft.json",
    "http://{host}:8080/data/aircraft.json",
    "http://{host}:8754/flights.json",
]


class SBSBridge:
    """Consumes a BaseStation (SBS-1) TCP stream and exposes aircraft.json."""

    STALE_SEC = 60

    def __init__(self, host, port):
        self.host = host
        self.port = port
        self.lock = threading.Lock()
        self.table = {}          # icao -> dict of fields + timestamps
        self.connected = False
        self.dirty = False       # set when table changes; gates broadcasts
        self.clients = set()     # set of per-connection queue.Queue
        self.clients_lock = threading.Lock()

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()
        threading.Thread(target=self._broadcast_loop, daemon=True).start()

    # ── WebSocket client registry ───────────────────────────────────────────
    def add_client(self):
        q = queue.Queue(maxsize=64)
        with self.clients_lock:
            self.clients.add(q)
        return q

    def remove_client(self, q):
        with self.clients_lock:
            self.clients.discard(q)

    def _broadcast_loop(self):
        while True:
            time.sleep(BROADCAST_SEC)
            with self.clients_lock:
                clients = list(self.clients)
            if not clients or not self.dirty:
                continue
            self.dirty = False
            msg = json.dumps(self.envelope("update")).encode("utf-8")
            for q in clients:
                try:
                    q.put_nowait(msg)
                except queue.Full:
                    pass     # slow client; it'll catch up on the next snapshot

    def _run(self):
        while True:
            try:
                with socket.create_connection((self.host, self.port), timeout=10) as s:
                    self.connected = True
                    buf = b""
                    s.settimeout(30)
                    while True:
                        data = s.recv(8192)
                        if not data:
                            break
                        buf += data
                        while b"\n" in buf:
                            line, buf = buf.split(b"\n", 1)
                            self._ingest(line.decode("ascii", "replace"))
            except Exception:
                pass
            self.connected = False
            time.sleep(3)        # reconnect backoff

    def _ingest(self, line):
        f = line.split(",")
        if not f or f[0] != "MSG" or len(f) < 18:
            return
        icao = f[4].strip().lower()
        if not icao:
            return
        now = time.time()
        with self.lock:
            rec = self.table.get(icao)
            if rec is None:
                rec = {"hex": icao}
                self.table[icao] = rec
            rec["seen"] = now

            def setf(idx, key, conv):
                if idx < len(f) and f[idx] not in ("", None):
                    try:
                        rec[key] = conv(f[idx])
                    except ValueError:
                        pass

            setf(10, "flight", lambda v: v.strip())
            setf(11, "alt_baro", lambda v: int(float(v)))
            setf(12, "gs", lambda v: float(v))
            setf(13, "track", lambda v: float(v))
            setf(17, "squawk", lambda v: v.strip())
            # position arrives together (MSG type 3); stamp seen_pos + history
            if len(f) > 15 and f[14] and f[15]:
                try:
                    lat, lon = float(f[14]), float(f[15])
                    rec["lat"], rec["lon"], rec["seen_pos"] = lat, lon, now
                    tr = rec.setdefault("trail", [])
                    if not tr or tr[-1][0] != lat or tr[-1][1] != lon:
                        tr.append((lat, lon, now))
                        cutoff = now - SERVER_TRAIL_SEC
                        while tr and tr[0][2] < cutoff:
                            tr.pop(0)
                except ValueError:
                    pass
            self.dirty = True

    def aircraft_json(self, include_trail=False):
        now = time.time()
        out = []
        with self.lock:
            dead = [k for k, r in self.table.items() if now - r["seen"] > self.STALE_SEC]
            for k in dead:
                del self.table[k]
            for r in self.table.values():
                ac = {"hex": r["hex"], "seen": round(now - r["seen"], 1)}
                for k in ("flight", "alt_baro", "gs", "track", "squawk", "lat", "lon"):
                    if k in r:
                        ac[k] = r[k]
                if "seen_pos" in r:
                    ac["seen_pos"] = round(now - r["seen_pos"], 1)
                # full position history, only in snapshots: [lat, lon, ageSec]
                if include_trail and r.get("trail"):
                    ac["trail"] = [[round(la, 5), round(lo, 5), round(now - t, 1)]
                                   for (la, lo, t) in r["trail"]]
                out.append(ac)
        return {"now": now, "messages": 0, "aircraft": out}

    def envelope(self, kind):
        """aircraft.json wrapped with a type tag for the WebSocket channel.
        'snapshot' = full state + trail history on connect (client suppresses
        pings and seeds trails); 'update' = live push (client pings new contacts)."""
        env = self.aircraft_json(include_trail=(kind == "snapshot"))
        env["type"] = kind
        return env


def ensure_overlays(env):
    """If map overlays are missing, generate them in the background from the
    .env location so a fresh checkout needs no manual fetch step."""
    if fetch_overlays.have_overlays():
        return
    try:
        lat = float(env["RADAR_LAT"]); lon = float(env["RADAR_LON"])
    except (KeyError, ValueError, TypeError):
        print("overlays missing and no RADAR_LAT/LON in .env — skipping auto-fetch")
        return

    def work():
        try:
            print("overlays missing — generating in background "
                  "(first run downloads ~20MB of ARTCC data)…")
            fetch_overlays.generate(lat, lon)
            print("overlays ready — they'll appear on the scope within a few seconds.")
        except Exception as e:
            print(f"overlay auto-fetch failed: {e}")
    threading.Thread(target=work, daemon=True).start()


def site_js(env):
    """Browser config injected at runtime from .env — keeps personal values
    (location, feeder host) out of committed files."""
    def num(k):
        try:
            return float(env.get(k))
        except (TypeError, ValueError):
            return 0
    site = {
        "receiver": {"lat": num("RADAR_LAT"), "lon": num("RADAR_LON"),
                     "label": env.get("RADAR_LABEL", "HOME")},
        "host": env.get("RADAR_HOST", ""),
        "mode": "proxy",
    }
    return "window.RADAR_SITE = " + json.dumps(site) + ";\n"


class Handler(SimpleHTTPRequestHandler):
    feeder_host = "localhost"
    sbs = None
    site_body = b"window.RADAR_SITE = {};\n"

    def do_GET(self):
        if self.path == "/site.js" or self.path.startswith("/site.js?"):
            return self._serve_site()
        if self.path.startswith("/ws"):
            return self._serve_ws()
        if self.path.startswith("/feed/sbs"):
            return self._serve_sbs()
        if self.path.startswith("/feed/"):
            return self._proxy()
        return super().do_GET()

    # ── WebSocket: live push of aircraft updates from the SBS bridge ──────────
    def _serve_ws(self):
        if not self.sbs:
            self.send_error(503, "SBS bridge disabled (--no-sbs)")
            return
        key = self.headers.get("Sec-WebSocket-Key")
        if self.headers.get("Upgrade", "").lower() != "websocket" or not key:
            self.send_error(400, "expected a WebSocket upgrade")
            return
        accept = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.wfile.write((
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        self.wfile.flush()
        self.close_connection = True

        q = self.sbs.add_client()
        try:
            self._ws_send(json.dumps(self.sbs.envelope("snapshot")).encode("utf-8"))
            while True:
                try:
                    msg = q.get(timeout=20)
                except queue.Empty:
                    self.wfile.write(b"\x89\x00")   # ping to keep NAT/proxies alive
                    self.wfile.flush()
                    continue
                self._ws_send(msg)
        except (OSError, ValueError):
            pass            # client went away
        finally:
            self.sbs.remove_client(q)

    def _ws_send(self, payload):
        """Send one unmasked text frame (server->client)."""
        n = len(payload)
        header = bytearray([0x81])          # FIN + opcode 0x1 (text)
        if n < 126:
            header.append(n)
        elif n < 65536:
            header.append(126)
            header += n.to_bytes(2, "big")
        else:
            header.append(127)
            header += n.to_bytes(8, "big")
        self.wfile.write(header)
        self.wfile.write(payload)
        self.wfile.flush()

    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_site(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/javascript")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(self.site_body)))
        self.end_headers()
        self.wfile.write(self.site_body)

    def _serve_sbs(self):
        if not self.sbs:
            self.send_error(503, "SBS bridge disabled (--no-sbs)")
            return
        self._send_json(self.sbs.aircraft_json())

    def _proxy(self):
        try:
            idx = int(self.path.rsplit("/", 1)[1])
            url = ENDPOINTS[idx].format(host=self.feeder_host)
        except (ValueError, IndexError):
            self.send_error(404, "bad feed index")
            return
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "radar-scope/1.0"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                body = resp.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_error(502, f"feeder fetch failed: {e}")

    def log_message(self, fmt, *args):  # quieter logs: skip the 1/s feed polls
        if self.path.startswith("/feed/"):
            return
        super().log_message(fmt, *args)


def main():
    env = load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=env.get("RADAR_HOST"),
                    help="feeder hostname/IP (default: RADAR_HOST in .env)")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--sbs-host", default=None, help="SBS source host (default: --host)")
    ap.add_argument("--sbs-port", type=int, default=int(env.get("RADAR_SBS_PORT") or 30003),
                    help="SBS/BaseStation port")
    ap.add_argument("--no-sbs", action="store_true", help="disable the SBS bridge")
    args = ap.parse_args()
    if not args.host:
        ap.error("no feeder host — set RADAR_HOST in .env (copy .env.example) or pass --host")

    Handler.feeder_host = args.host
    Handler.site_body = site_js(env).encode("utf-8")
    ensure_overlays(env)
    if not args.no_sbs:
        bridge = SBSBridge(args.sbs_host or args.host, args.sbs_port)
        bridge.start()
        Handler.sbs = bridge
        print(f"SBS bridge: {bridge.host}:{bridge.port} -> /feed/sbs (HTTP) + /ws (live push)")

    httpd = ThreadingHTTPServer(("0.0.0.0", args.port), partial(Handler))
    print(f"radar scope: http://localhost:{args.port}/  (proxying feeder {args.host})")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
