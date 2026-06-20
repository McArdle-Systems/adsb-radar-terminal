"""envload — tiny .env reader shared by serve.py and fetch_overlays.py.
No external deps. Real environment variables override .env values."""
import os

KEYS = ("RADAR_HOST", "RADAR_LAT", "RADAR_LON", "RADAR_LABEL", "RADAR_SBS_PORT")


def load_env(path=None):
    here = os.path.dirname(os.path.abspath(__file__))
    path = path or os.path.join(here, ".env")
    env = {}
    if os.path.exists(path):
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    for k in KEYS:                       # process env wins over the file
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env
