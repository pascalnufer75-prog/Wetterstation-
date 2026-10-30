#!/usr/bin/env python3
"""Wetterstation – Datensammler, Datenbank und Web-Dashboard.

Benötigt nur Python 3.9+ (keine Zusatzpakete).

    python3 server.py                 # normaler Betrieb mit config.json
    python3 server.py --demo          # Demo mit simulierten Daten (eigene Datenbank)
    python3 server.py --test-url URL  # zeigt, was aus der Live-URL gelesen wird

Danach im Browser: http://localhost:8080
"""

import argparse
import csv
import io
import json
import math
import os
import random
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.request
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import adapters

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
CONFIG_PATH = os.path.join(BASE, "config.json")

DEFAULT_CONFIG = {
    "station_name": "Meine Wetterstation",
    "source_url": "https://app.weathercloud.net/d4526664740",
    "adapter": "auto",          # auto | weathercloud | ecowitt_local | clientraw | cumulus | generic
    "mapping": {},              # optional: {"temp_out": "pfad.im.json", ...}
    "units": {},                # optional: {"temp_out": "f", "wind_speed": "m/s", ...}
    "poll_interval": 60,        # Sekunden
    "roof_area": 36.0,          # m² Dachfläche (Grundfläche, horizontal projiziert)
    "runoff_coefficient": 1.0,  # Abflussbeiwert: 1.0 = jeder Tropfen, Ziegeldach real ~0.8–0.9
    "tank_capacity": 0,         # Liter, 0 = unbekannt
    "port": 8080,
    "database": "wetter.db",
}

DATA_FIELDS = adapters.FIELDS + ["rain_mm"]  # rain_mm = Regen seit letzter Messung


# =========================================================================== Konfiguration

class Config:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.data = dict(DEFAULT_CONFIG)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                self.data.update(json.load(f))
        else:
            self.save()

    def __getitem__(self, k):
        return self.data[k]

    def update(self, values):
        with self.lock:
            self.data.update(values)
            self.save()

    def save(self):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self.data, f, indent=2, ensure_ascii=False)

    def liters(self, mm):
        return (mm or 0) * float(self.data["roof_area"]) * float(self.data["runoff_coefficient"])


# =========================================================================== Datenbank

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS readings (
    ts INTEGER PRIMARY KEY,
    {", ".join(f"{f} REAL" for f in DATA_FIELDS)}
);
"""


def connect(db_path):
    conn = sqlite3.connect(db_path, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.create_function("sind", 1, lambda d: None if d is None else math.sin(math.radians(d)))
    conn.create_function("cosd", 1, lambda d: None if d is None else math.cos(math.radians(d)))
    return conn


def init_db(db_path):
    conn = connect(db_path)
    conn.executescript(SCHEMA)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(readings)")}
    for f in DATA_FIELDS:  # Schema-Erweiterungen bei Updates
        if f not in cols:
            conn.execute(f"ALTER TABLE readings ADD COLUMN {f} REAL")
    conn.commit()
    return conn


def insert_reading(conn, ts, values):
    cols = ["ts"] + [f for f in DATA_FIELDS if f in values]
    conn.execute(
        f"INSERT OR REPLACE INTO readings ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
        [ts] + [values[c] for c in cols[1:]],
    )


# =========================================================================== Regen-Zuwachs

class RainTracker:
    """Berechnet den Regen seit der letzten Messung aus den Zählern der Station.

    Bevorzugt den Gesamtzähler (rain_total), sonst den Tageszähler (rain_day).
    Zähler-Resets (Mitternacht, Neustart der Station) werden erkannt. Liefert die
    Station nur eine Regenrate, wird diese über die Zeit integriert.
    """

    def __init__(self, conn=None, last=None):
        row = last
        if conn is not None:
            row = conn.execute("SELECT ts, rain_day, rain_total FROM readings ORDER BY ts DESC LIMIT 1").fetchone()
        self.last_ts = row["ts"] if row else None
        self.last_day = row["rain_day"] if row else None
        self.last_total = row["rain_total"] if row else None

    def increment(self, ts, v):
        inc = 0.0
        if v.get("rain_total") is not None:
            if self.last_total is not None:
                d = v["rain_total"] - self.last_total
                inc = d if d >= 0 else 0.0  # Zähler zurückgesetzt -> nichts verbuchen
        elif v.get("rain_day") is not None:
            if self.last_day is not None:
                d = v["rain_day"] - self.last_day
                # Tageszähler gesunken = Reset um Mitternacht -> alles seither ist neu
                inc = d if d >= 0 else v["rain_day"]
        elif v.get("rain_rate") is not None and self.last_ts is not None:
            dt = min(ts - self.last_ts, 900)
            inc = v["rain_rate"] * dt / 3600
        self.last_ts = ts
        self.last_day = v.get("rain_day", self.last_day)
        self.last_total = v.get("rain_total", self.last_total)
        return round(max(inc, 0.0), 3)


# =========================================================================== Abgeleitete Grössen

def dewpoint(t, rh):
    if t is None or not rh:
        return None
    a, b = 17.62, 243.12
    g = math.log(rh / 100) + a * t / (b + t)
    return b * g / (a - g)


def feels_like(t, rh, wind_kmh):
    if t is None:
        return None
    if t <= 10 and wind_kmh and wind_kmh > 4.8:
        v = wind_kmh ** 0.16
        return 13.12 + 0.6215 * t - 11.37 * v + 0.3965 * t * v
    if t >= 27 and rh:
        tf = t * 9 / 5 + 32
        hi = (-42.379 + 2.04901523 * tf + 10.14333127 * rh - 0.22475541 * tf * rh - 6.83783e-3 * tf * tf
              - 5.481717e-2 * rh * rh + 1.22874e-3 * tf * tf * rh + 8.5282e-4 * tf * rh * rh
              - 1.99e-6 * tf * tf * rh * rh)
        return (hi - 32) * 5 / 9
    return t


def complete(values):
    v = dict(values)
    if v.get("dewpoint") is None:
        d = dewpoint(v.get("temp_out"), v.get("hum_out"))
        if d is not None:
            v["dewpoint"] = round(d, 2)
    if v.get("feels_like") is None:
        f = feels_like(v.get("temp_out"), v.get("hum_out"), v.get("wind_speed"))
        if f is not None:
            v["feels_like"] = round(f, 2)
    return v


# =========================================================================== Demo-Daten

class Simulator:
    """Plausibles Mitteleuropa-Wetter für den Demo-Modus."""

    def __init__(self, seed=7):
        self.r = random.Random(seed)
        self.t_anom = 0.0
        self.p_anom = 0.0
        self.w = 8.0
        self.dir = 240.0
        self.raining = False
        self.rain_day = 0.0
        self.rain_total = 0.0
        self.day = None
        self.cloud = 0.4

    def step(self, ts, dt=600):
        r = self.r
        d = datetime.fromtimestamp(ts)
        doy = d.timetuple().tm_yday
        hour = d.hour + d.minute / 60
        k = dt / 600
        if self.day != d.date():
            self.day, self.rain_day = d.date(), 0.0
        self.t_anom = self.t_anom * (0.995 ** k) + r.gauss(0, 0.25) * math.sqrt(k)
        self.p_anom = self.p_anom * (0.997 ** k) + r.gauss(0, 0.35) * math.sqrt(k)
        self.cloud = min(1, max(0, self.cloud + r.gauss(0, 0.05) * math.sqrt(k) + (0.01 if self.p_anom < -4 else -0.004)))
        if self.raining:
            self.raining = r.random() > 0.04 * k
        else:
            self.raining = r.random() < (0.002 + 0.01 * max(0, -self.p_anom / 10) + 0.005 * self.cloud) * k
        season = math.sin(2 * math.pi * (doy - 110) / 365)
        daily = math.sin(2 * math.pi * (hour - 9) / 24) * (5 - 3 * self.cloud)
        temp = 10 + 9.5 * season + daily + self.t_anom - (1.5 if self.raining else 0)
        hum = min(99, max(25, 72 - 2.2 * daily - 1.2 * (temp - 10) * 0.5 + 25 * self.cloud * 0.6
                          + (18 if self.raining else 0) + r.gauss(0, 2)))
        self.w = max(0, self.w * 0.9 + (8 + 6 * self.cloud + (6 if self.raining else 0)) * 0.1 + r.gauss(0, 1.5))
        pull = ((245 - self.dir + 180) % 360 - 180) * 0.03
        self.dir = (self.dir + r.gauss(0, 12) + pull) % 360
        elev = math.sin(math.pi * (hour - 6.5 + 1.5 * season) / (13 + 3.5 * season)) if 6.5 - 1.5 * season < hour < 19.5 + 2 * season else 0
        solar = max(0, (500 + 350 * season) * elev * (1 - 0.75 * self.cloud) + r.gauss(0, 10)) if elev > 0 else 0
        rain_mm = 0.0
        if self.raining:
            rain_mm = round(max(0.1, r.expovariate(1 / (0.12 + 0.12 * max(0, season)))) * k, 1)
            self.rain_day += rain_mm
            self.rain_total += rain_mm
        return {
            "temp_out": round(temp, 1), "hum_out": round(hum, 0),
            "pressure": round(1015 + self.p_anom * 2 + r.gauss(0, 0.2), 1),
            "wind_speed": round(self.w, 1), "wind_gust": round(self.w * (1.3 + r.random() * 0.6), 1),
            "wind_dir": round(self.dir), "rain_rate": round(rain_mm * 3600 / dt, 1),
            "rain_day": round(self.rain_day, 1), "rain_total": round(self.rain_total, 1),
            "solar": round(solar), "uv": round(solar / 95, 1),
            "temp_in": round(21 + 0.8 * math.sin(2 * math.pi * (hour - 15) / 24) + 0.1 * temp, 1),
            "hum_in": round(min(65, max(35, 48 + (hum - 70) * 0.2)), 0),
        }


def fill_demo(conn, days=800):
    if conn.execute("SELECT COUNT(*) FROM readings").fetchone()[0] > 0:
        return
    print(f"Erzeuge {days} Tage Demo-Daten …", flush=True)
    sim = Simulator()
    now = int(time.time()) // 600 * 600
    ts = now - days * 86400
    tracker = RainTracker(conn)
    rows = 0
    while ts <= now:
        v = complete(sim.step(ts))
        v["rain_mm"] = tracker.increment(ts, v)
        insert_reading(conn, ts, v)
        ts += 600
        rows += 1
    conn.commit()
    print(f"  {rows} Datensätze angelegt.", flush=True)
    return sim


# =========================================================================== Datensammler

class _Unchanged(Exception):
    pass


class Collector(threading.Thread):
    def __init__(self, cfg, db_path, demo=False, sim=None):
        super().__init__(daemon=True)
        self.cfg, self.db_path, self.demo = cfg, db_path, demo
        self.sim = sim or Simulator(seed=11)
        self.status = {"last_ok": None, "last_error": None, "last_error_time": None, "polls": 0}
        self.wakeup = threading.Event()
        self.last_station_ts = None

    def fetch(self):
        url = self.cfg["source_url"]
        if not url:
            raise RuntimeError("Keine Live-URL konfiguriert (Einstellungen → Datenquelle)")
        return fetch_and_parse(url, self.cfg["adapter"], self.cfg["mapping"], self.cfg["units"])

    def run(self):
        conn = connect(self.db_path)
        tracker = RainTracker(conn)
        while True:
            ts = int(time.time())
            try:
                values = self.sim.step(ts, 60) if self.demo else self.fetch()
                station_ts = values.pop("_ts", None)
                if station_ts and abs(station_ts - ts) < 7 * 86400:
                    if station_ts == self.last_station_ts:
                        raise _Unchanged()  # Station hat noch keine neue Messung hochgeladen
                    self.last_station_ts = ts = station_ts
                values = complete(values)
                values["rain_mm"] = tracker.increment(ts, values)
                insert_reading(conn, ts, values)
                conn.commit()
                self.status["last_ok"] = int(time.time())
                self.status["last_error"] = None
            except _Unchanged:
                self.status["last_ok"] = int(time.time())
                self.status["last_error"] = None
            except Exception as e:  # noqa: BLE001 – Sammler darf nie sterben
                self.status["last_error"] = str(e)
                self.status["last_error_time"] = ts
                print(f"[{datetime.now():%H:%M:%S}] Fehler beim Abruf: {e}", file=sys.stderr, flush=True)
            self.status["polls"] += 1
            interval = 60 if self.demo else max(10, int(self.cfg["poll_interval"]))
            self.wakeup.wait(interval)
            self.wakeup.clear()


def fetch_and_parse(url, adapter="auto", mapping=None, units=None, debug=False):
    headers = {"User-Agent": "Mozilla/5.0 (Wetterstation-Dashboard/1.0)",
               "Accept": "application/json, text/plain, */*"}
    data = None
    code = adapters.weathercloud_code(url)
    if code and adapter in ("auto", "weathercloud"):
        # Die Seite app.weathercloud.net/d<ID> lädt ihre Werte per AJAX von diesem Endpunkt
        url = f"https://app.weathercloud.net/device/values?code={code}"
        headers.update({"X-Requested-With": "XMLHttpRequest", "Referer": f"https://app.weathercloud.net/d{code}",
                        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"})
        data, adapter = f"code={code}".encode(), "weathercloud"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read()
    if debug:
        print(f"Abgerufen: {url}\nAntwort (Anfang):\n{body[:800].decode('utf-8', 'replace')}\n")
    return adapters.parse(body, adapter, mapping, units)


# =========================================================================== Auswertungen

AGG_SPEC = {  # Feld -> Aggregate
    "temp_out": ("avg", "min", "max"), "hum_out": ("avg", "min", "max"),
    "dewpoint": ("avg", "min", "max"), "feels_like": ("avg", "min", "max"),
    "temp_in": ("avg", "min", "max"), "hum_in": ("avg", "min", "max"),
    "pressure": ("avg", "min", "max"), "wind_speed": ("avg", "max"),
    "wind_gust": ("max",), "rain_rate": ("max",), "solar": ("avg", "max"), "uv": ("avg", "max"),
}

BUCKETS = {
    "10min": "ts/600*600",
    "hour": "strftime('%Y-%m-%d %H:00:00', ts, 'unixepoch', 'localtime')",
    "day": "strftime('%Y-%m-%d 00:00:00', ts, 'unixepoch', 'localtime')",
    "month": "strftime('%Y-%m-01 00:00:00', ts, 'unixepoch', 'localtime')",
    "year": "strftime('%Y-01-01 00:00:00', ts, 'unixepoch', 'localtime')",
}


def auto_bucket(span):
    if span <= 2 * 86400:
        return "raw"
    if span <= 10 * 86400:
        return "10min"
    if span <= 62 * 86400:
        return "hour"
    if span <= 3 * 365 * 86400:
        return "day"
    return "month"


def bucket_to_ms(b):
    if isinstance(b, (int, float)):
        return int(b) * 1000
    return int(datetime.strptime(b, "%Y-%m-%d %H:%M:%S").timestamp() * 1000)


def r2(x, n=2):
    return None if x is None else round(x, n)


def query_history(conn, cfg, t0, t1, bucket="auto"):
    if bucket == "auto":
        bucket = auto_bucket(t1 - t0)
    if bucket == "raw":
        rows = conn.execute(f"SELECT ts, {','.join(DATA_FIELDS)} FROM readings WHERE ts>=? AND ts<? ORDER BY ts",
                            (t0, t1)).fetchall()
        out = []
        for r in rows:
            d = {"t": r["ts"] * 1000}
            for f in DATA_FIELDS:
                if r[f] is not None:
                    d[f] = r[f]
            d["rain_l"] = r2(cfg.liters(r["rain_mm"]))
            out.append(d)
        return bucket, out

    sel = []
    for f, aggs in AGG_SPEC.items():
        for a in aggs:
            sel.append(f"{a.upper()}({f}) AS {f}{'' if a == 'avg' else '_' + a}")
    sel.append("SUM(rain_mm) AS rain_mm")
    sel.append("(CASE WHEN COUNT(wind_dir)>0 THEN (degrees(atan2(AVG(sind(wind_dir)), AVG(cosd(wind_dir))))+360)%360 END) AS wind_dir")
    sel.append("COUNT(*) AS n")
    sql = (f"SELECT {BUCKETS[bucket]} AS b, {', '.join(sel)} FROM readings "
           f"WHERE ts>=? AND ts<? GROUP BY b ORDER BY b")
    try:
        rows = conn.execute(sql, (t0, t1)).fetchall()
    except sqlite3.OperationalError:  # SQLite ohne Mathe-Funktionen
        conn.create_function("degrees", 1, lambda x: None if x is None else math.degrees(x))
        conn.create_function("atan2", 2, lambda y, x: None if y is None or x is None else math.atan2(y, x))
        rows = conn.execute(sql, (t0, t1)).fetchall()
    out = []
    for r in rows:
        d = {"t": bucket_to_ms(r["b"])}
        for k in r.keys():
            if k in ("b",) or r[k] is None:
                continue
            d[k] = r2(r[k]) if isinstance(r[k], float) else r[k]
        d["rain_l"] = r2(cfg.liters(r["rain_mm"]), 1)
        out.append(d)
    return bucket, out


def local_midnight(dt=None):
    dt = dt or datetime.now()
    return dt.replace(hour=0, minute=0, second=0, microsecond=0)


def rain_sum(conn, t0, t1=None):
    t1 = t1 or int(time.time()) + 1
    v = conn.execute("SELECT SUM(rain_mm) FROM readings WHERE ts>=? AND ts<?", (int(t0), int(t1))).fetchone()[0]
    return round(v or 0, 2)


def rain_overview(conn, cfg):
    now = datetime.now()
    today = local_midnight(now)
    periods = [
        ("today", "Heute", today, None),
        ("yesterday", "Gestern", today - timedelta(days=1), today),
        ("week", "Letzte 7 Tage", now - timedelta(days=7), None),
        ("month", now.strftime("%B %Y"), today.replace(day=1), None),
        ("days30", "Letzte 30 Tage", now - timedelta(days=30), None),
        ("year", f"Jahr {now.year}", today.replace(month=1, day=1), None),
        ("all", "Seit Messbeginn", datetime(1970, 1, 2), None),
    ]
    out = []
    for key, label, a, b in periods:
        mm = rain_sum(conn, a.timestamp(), b.timestamp() if b else None)
        out.append({"key": key, "label": label, "mm": mm, "liters": round(cfg.liters(mm), 1)})
    return out


def latest(conn, cfg, collector):
    row = conn.execute("SELECT * FROM readings ORDER BY ts DESC LIMIT 1").fetchone()
    cur = {k: row[k] for k in row.keys()} if row else None
    t_today = int(local_midnight().timestamp())
    now = int(time.time())

    def extreme(field, order):
        r = conn.execute(f"SELECT ts, {field} FROM readings WHERE ts>=? AND {field} IS NOT NULL "
                         f"ORDER BY {field} {order} LIMIT 1", (t_today,)).fetchone()
        return {"value": r[field], "t": r["ts"] * 1000} if r else None

    def value_ago(field, seconds):
        r = conn.execute(f"SELECT {field} FROM readings WHERE ts<=? AND {field} IS NOT NULL "
                         f"ORDER BY ts DESC LIMIT 1", (now - seconds,)).fetchone()
        if r and cur and cur.get(field) is not None:
            return round(cur[field] - r[field], 2)
        return None

    today = {
        "temp_min": extreme("temp_out", "ASC"), "temp_max": extreme("temp_out", "DESC"),
        "gust_max": extreme("wind_gust", "DESC"), "hum_min": extreme("hum_out", "ASC"),
        "hum_max": extreme("hum_out", "DESC"), "solar_max": extreme("solar", "DESC"),
        "uv_max": extreme("uv", "DESC"), "rain_rate_max": extreme("rain_rate", "DESC"),
    }
    trends = {"temp_1h": value_ago("temp_out", 3600), "pressure_3h": value_ago("pressure", 3 * 3600),
              "hum_1h": value_ago("hum_out", 3600)}
    return {
        "current": cur, "today": today, "trends": trends, "rain": rain_overview(conn, cfg),
        "status": {**collector.status, "demo": collector.demo, "now": now},
        "settings": public_settings(cfg),
    }


def records(conn, cfg):
    def ext(field, order):
        r = conn.execute(f"SELECT ts, {field} FROM readings WHERE {field} IS NOT NULL "
                         f"ORDER BY {field} {order} LIMIT 1").fetchone()
        return {"value": r[field], "t": r["ts"] * 1000} if r else None

    wet = conn.execute(
        "SELECT strftime('%Y-%m-%d 00:00:00', ts, 'unixepoch', 'localtime') AS d, SUM(rain_mm) AS mm "
        "FROM readings GROUP BY d ORDER BY mm DESC LIMIT 1").fetchone()
    wettest = {"value": round(wet["mm"], 1), "t": bucket_to_ms(wet["d"]),
               "liters": round(cfg.liters(wet["mm"]))} if wet and wet["mm"] else None
    return {
        "temp_max": ext("temp_out", "DESC"), "temp_min": ext("temp_out", "ASC"),
        "gust_max": ext("wind_gust", "DESC"), "pressure_max": ext("pressure", "DESC"),
        "pressure_min": ext("pressure", "ASC"), "rain_rate_max": ext("rain_rate", "DESC"),
        "solar_max": ext("solar", "DESC"), "wettest_day": wettest,
    }


def wind_rose(conn, t0, t1):
    classes = [0, 5, 10, 20, 30, 50]  # km/h
    counts = [[0] * len(classes) for _ in range(16)]
    total = calm = 0
    for d, s in conn.execute("SELECT wind_dir, wind_speed FROM readings WHERE ts>=? AND ts<? "
                             "AND wind_dir IS NOT NULL AND wind_speed IS NOT NULL", (t0, t1)):
        total += 1
        if s < 1:
            calm += 1
            continue
        sector = int(((d % 360) + 11.25) // 22.5) % 16
        cls = max(i for i, c in enumerate(classes) if s >= c)
        counts[sector][cls] += 1
    return {"classes": classes, "counts": counts, "total": total, "calm": calm}


def db_info(conn, db_path):
    r = conn.execute("SELECT COUNT(*) n, MIN(ts) a, MAX(ts) b FROM readings").fetchone()
    size = sum(os.path.getsize(p) for p in (db_path, db_path + "-wal") if os.path.exists(p))
    return {"count": r["n"], "first": r["a"] and r["a"] * 1000, "last": r["b"] and r["b"] * 1000,
            "size_bytes": size, "file": os.path.basename(db_path)}


def public_settings(cfg):
    return {k: cfg[k] for k in ("station_name", "source_url", "adapter", "poll_interval",
                                "roof_area", "runoff_coefficient", "tank_capacity")}


LABELS = {
    "temp_out": "Temperatur aussen [°C]", "hum_out": "Luftfeuchte aussen [%]", "dewpoint": "Taupunkt [°C]",
    "feels_like": "Gefühlte Temperatur [°C]", "temp_in": "Temperatur innen [°C]", "hum_in": "Luftfeuchte innen [%]",
    "pressure": "Luftdruck [hPa]", "wind_speed": "Wind [km/h]", "wind_gust": "Böen [km/h]",
    "wind_dir": "Windrichtung [°]", "rain_rate": "Regenrate [mm/h]", "rain_day": "Regen Tageszähler [mm]",
    "rain_total": "Regen Gesamtzähler [mm]", "rain_mm": "Regen [mm]", "rain_l": "Regentank Zufluss [L]",
    "solar": "Sonnenstrahlung [W/m²]", "uv": "UV-Index",
}


# =========================================================================== HTTP

class App:
    def __init__(self, cfg, db_path, collector):
        self.cfg, self.db_path, self.collector = cfg, db_path, collector


class Handler(BaseHTTPRequestHandler):
    app: App = None
    server_version = "Wetterstation/1.0"

    def log_message(self, fmt, *args):
        pass

    # ---- Hilfen
    def send(self, code, body, ctype="application/json; charset=utf-8", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def range_args(self, q, default_days=1):
        now = int(time.time())
        t1 = int(float(q.get("to", [now + 1])[0]))
        t0 = int(float(q.get("from", [t1 - default_days * 86400])[0]))
        if t1 > 1e11:  # Millisekunden erlaubt
            t0, t1 = t0 // 1000, t1 // 1000
        return t0, t1

    # ---- Routen
    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        a = self.app
        try:
            if url.path.startswith("/api/"):
                conn = connect(a.db_path)
                try:
                    return self.api_get(url.path, q, conn)
                finally:
                    conn.close()
            return self.static(url.path)
        except BrokenPipeError:
            pass
        except Exception as e:  # noqa: BLE001
            self.send(500, {"error": str(e)})

    def api_get(self, path, q, conn):
        a = self.app
        if path == "/api/latest":
            return self.send(200, latest(conn, a.cfg, a.collector))
        if path == "/api/history":
            t0, t1 = self.range_args(q)
            bucket, rows = query_history(conn, a.cfg, t0, t1, q.get("bucket", ["auto"])[0])
            return self.send(200, {"bucket": bucket, "from": t0 * 1000, "to": t1 * 1000, "rows": rows})
        if path == "/api/windrose":
            t0, t1 = self.range_args(q)
            return self.send(200, wind_rose(conn, t0, t1))
        if path == "/api/records":
            return self.send(200, records(conn, a.cfg))
        if path == "/api/info":
            return self.send(200, {**db_info(conn, a.db_path), "settings": public_settings(a.cfg),
                                   "status": a.collector.status, "demo": a.collector.demo})
        if path == "/api/export":
            return self.export(q, conn)
        if path == "/api/test-source":
            url = q.get("url", [a.cfg["source_url"]])[0]
            try:
                values = fetch_and_parse(url, q.get("adapter", ["auto"])[0])
                station_ts = values.pop("_ts", None)
                return self.send(200, {"ok": True, "values": complete(values),
                                       "station_time": station_ts and station_ts * 1000})
            except Exception as e:  # noqa: BLE001
                return self.send(200, {"ok": False, "error": str(e)})
        return self.send(404, {"error": "unbekannter Endpunkt"})

    def export(self, q, conn):
        a = self.app
        fmt = q.get("format", ["csv"])[0]
        stamp = datetime.now().strftime("%Y%m%d-%H%M")
        if fmt == "sqlite":
            with tempfile.TemporaryDirectory() as tmp:
                path = os.path.join(tmp, "x.db")
                dst = sqlite3.connect(path)
                conn.backup(dst)
                dst.close()
                with open(path, "rb") as f:
                    data = f.read()
            return self.send(200, data, "application/vnd.sqlite3",
                             {"Content-Disposition": f'attachment; filename="wetterstation-{stamp}.db"'})
        t0, t1 = self.range_args(q, default_days=36500)
        bucket = q.get("bucket", ["raw"])[0]
        bucket, rows = query_history(conn, a.cfg, t0, t1, bucket)
        if fmt == "json":
            body = {"station": a.cfg["station_name"], "bucket": bucket, "roof_area_m2": a.cfg["roof_area"],
                    "runoff_coefficient": a.cfg["runoff_coefficient"], "units": LABELS,
                    "rows": [{**r, "time": datetime.fromtimestamp(r["t"] / 1000).isoformat()} for r in rows]}
            return self.send(200, body, headers={"Content-Disposition": f'attachment; filename="wetterstation-{bucket}-{stamp}.json"'})
        # CSV: Semikolon + Punkt als Dezimaltrennzeichen (öffnet sauber in Excel de-CH)
        keys = []
        for r in rows:
            for k in r:
                if k not in keys and k not in ("t", "n"):
                    keys.append(k)
        order = []
        for k in list(LABELS) + keys:  # Mittelwert, dann min/max daneben
            for c in (k, k + "_min", k + "_max"):
                if c in keys and c not in order:
                    order.append(c)
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=";", lineterminator="\r\n")

        def label(k):
            base = k.rsplit("_", 1)
            if k not in LABELS and len(base) == 2 and base[0] in LABELS and base[1] in ("min", "max"):
                return f"{LABELS[base[0]]} {base[1]}"
            return LABELS.get(k, k)
        w.writerow(["Zeit"] + [label(k) for k in order])
        for r in rows:
            w.writerow([datetime.fromtimestamp(r["t"] / 1000).strftime("%Y-%m-%d %H:%M:%S")] +
                       ["" if r.get(k) is None else r[k] for k in order])
        data = "﻿" + buf.getvalue()
        return self.send(200, data, "text/csv; charset=utf-8",
                         {"Content-Disposition": f'attachment; filename="wetterstation-{bucket}-{stamp}.csv"'})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/api/settings":
            return self.send(404, {"error": "unbekannter Endpunkt"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length) or b"{}")
            clean = {}
            for k in ("station_name", "source_url", "adapter"):
                if k in data:
                    clean[k] = str(data[k]).strip()
            for k, lo, hi in (("roof_area", 0.1, 100000), ("runoff_coefficient", 0.05, 1.0),
                              ("tank_capacity", 0, 10_000_000), ("poll_interval", 10, 86400)):
                if k in data and data[k] not in ("", None):
                    v = float(data[k])
                    if not lo <= v <= hi:
                        return self.send(400, {"error": f"{k} muss zwischen {lo} und {hi} liegen"})
                    clean[k] = int(v) if k == "poll_interval" else v
            self.app.cfg.update(clean)
            self.app.collector.wakeup.set()
            self.send(200, {"ok": True, "settings": public_settings(self.app.cfg)})
        except Exception as e:  # noqa: BLE001
            self.send(400, {"error": str(e)})

    def static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.normpath(os.path.join(STATIC, path.lstrip("/")))
        if not full.startswith(STATIC) or not os.path.isfile(full):
            return self.send(404, "Nicht gefunden", "text/plain; charset=utf-8")
        ctype = {".html": "text/html", ".js": "application/javascript", ".css": "text/css",
                 ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
                 ".webmanifest": "application/manifest+json", ".ico": "image/x-icon"}.get(
            os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        if ctype.startswith("text") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self.send(200, data, ctype)


# =========================================================================== Start

def main():
    ap = argparse.ArgumentParser(description="Wetterstation-Dashboard")
    ap.add_argument("--demo", action="store_true", help="simulierte Daten in wetter-demo.db")
    ap.add_argument("--port", type=int, help="HTTP-Port (Standard aus config.json, 8080)")
    ap.add_argument("--config", default=CONFIG_PATH)
    ap.add_argument("--test-url", metavar="URL", help="Live-URL abrufen, Ergebnis zeigen und beenden")
    args = ap.parse_args()

    if args.test_url:
        values = fetch_and_parse(args.test_url, debug=True)
        print("Erkannte Werte:")
        station_ts = values.pop("_ts", None)
        if station_ts:
            print(f"  {'Messzeitpunkt der Station':32s} {datetime.fromtimestamp(station_ts)}")
        for k, v in complete(values).items():
            print(f"  {LABELS.get(k, k):32s} {v}")
        return

    cfg = Config(args.config)
    db_name = "wetter-demo.db" if args.demo else cfg["database"]
    db_path = db_name if os.path.isabs(db_name) else os.path.join(BASE, db_name)
    conn = init_db(db_path)
    sim = fill_demo(conn) if args.demo else None
    conn.close()

    collector = Collector(cfg, db_path, demo=args.demo, sim=sim)
    collector.start()
    Handler.app = App(cfg, db_path, collector)
    port = args.port or int(cfg["port"])
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Wetterstation läuft: http://localhost:{port}  (Datenbank: {db_path})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nBeendet.")


if __name__ == "__main__":
    main()
