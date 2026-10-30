#!/usr/bin/env python3
"""Weathercloud-Export (CSV) in die gesammelten Daten übernehmen.

    python3 import_weathercloud.py Weathercloud_Guxli_2026-09.csv [weitere.csv …] --data pfad/zu/data

Der Export ist UTF-16, mit Semikolon getrennt, Dezimalkomma und Zeit in der Zeitzone aus der
Kopfzeile, z.B. "Datum (Europe/Zurich)". Bereits vorhandene Messungen (gleicher Zeitpunkt)
werden nicht überschrieben. Zeilen ganz ohne Messwerte (Ausfälle der Station) werden übersprungen.
"""

import argparse
import csv
import glob
import os
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import collect
import server

# Spaltenname (ohne Einheit, klein) -> (Feld, Umrechnung)
COLUMNS = [
    (r"^temperatur$|^temperature$", "temp_out"),
    (r"^luftfeuchtigkeit$|^humidity$", "hum_out"),
    (r"^luftdruck$|^pressure$|^barometer$", "pressure"),
    (r"^taupunkt$|^dew ?point$", "dewpoint"),
    (r"^windgeschwindigkeit$|^durchschnittliche windgeschwindigkeit$|^wind speed$|^average wind speed$", "wind_speed"),
    (r"^windb(ö|oe)e$|^b(ö|oe)e$|^wind gust$|^gust$", "wind_gust"),
    (r"^windrichtung$|^durchschnittliche windrichtung$|^wind direction$", "wind_dir"),
    (r"^regenrate$|^niederschlagsrate$|^rain rate$", "rain_rate"),
    (r"^regen$|^niederschlag$|^rain$", "rain_day"),
    (r"^sonnenstrahlung$|^solarstrahlung$|^solar radiation$", "solar"),
    (r"^uv(-index)?$|^uv index$", "uv"),
]


def read_export(path):
    raw = open(path, "rb").read()
    for enc in ("utf-16", "utf-16-le", "utf-8-sig", "latin-1"):
        try:
            text = raw.decode(enc)
            if ";" in text[:200]:
                break
        except UnicodeDecodeError:
            continue
    lines = [l for l in text.splitlines() if l.strip()]
    head = lines[0].split(";")
    tz_match = re.search(r"\(([^)]+/[^)]+)\)", head[0])
    tz = ZoneInfo(tz_match.group(1) if tz_match else "UTC")

    mapping = {}  # Spaltenindex -> (Feld, Einheit)
    for i, h in enumerate(head[1:], 1):
        name = re.sub(r"\s*\(.*\)\s*$", "", h).strip().lower()
        unit = (re.search(r"\(([^)]*)\)", h) or [None, ""])[1]
        for pattern, field in COLUMNS:
            if re.search(pattern, name):
                mapping[i] = (field, unit)
                break
        else:
            if name:
                print(f"  Spalte ignoriert: {h!r}")
    print(f"  erkannt: {', '.join(f'{head[i]!r} -> {f}' for i, (f, _) in mapping.items())}")

    rows = []
    for line in lines[1:]:
        cells = line.split(";")
        values = {}
        for i, (field, unit) in mapping.items():
            if i < len(cells) and cells[i].strip():
                v = float(cells[i].strip().replace(".", "").replace(",", "."))
                values[field] = round(server.adapters.to_metric(server.adapters.KIND[field], v, unit), 3)
        if not values:
            continue  # Ausfall der Station
        local = datetime.strptime(cells[0].strip(), "%d/%m/%Y %H:%M:%S").replace(tzinfo=tz)
        rows.append((int(local.timestamp()), values))
    return rows


def load_existing(data_dir):
    existing = {}
    for path in glob.glob(os.path.join(data_dir, "????-??.csv")):
        with open(path, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                existing[int(r["ts"])] = r
    return existing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--data", default="data")
    args = ap.parse_args()

    existing = load_existing(args.data)
    imported = {}
    for path in args.files:
        print(f"Lese {path}")
        for ts, values in read_export(path):
            if ts in existing or ts in imported:
                continue
            v = dict(values)
            if v.get("dewpoint") is None:
                d = server.dewpoint(v.get("temp_out"), v.get("hum_out"))
                if d is not None:
                    v["dewpoint"] = round(d, 2)
            imported[ts] = v

    # Regen-Zuwachs nur berechnen, wenn der Export einen Regenzähler enthält
    if any("rain_day" in v for v in imported.values()):
        tracker = server.RainTracker()
        for ts in sorted(imported):
            imported[ts]["rain_mm"] = tracker.increment(ts, imported[ts])

    by_month = {}
    for ts, r in existing.items():
        by_month.setdefault(datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m"), {})[ts] = r
    for ts, v in imported.items():
        row = {"ts": ts, **{c: ("" if v.get(c) is None else v[c]) for c in collect.COLUMNS[1:]}}
        by_month.setdefault(datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m"), {})[ts] = row

    os.makedirs(args.data, exist_ok=True)
    for month, rows in by_month.items():
        with open(os.path.join(args.data, f"{month}.csv"), "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=collect.COLUMNS, extrasaction="ignore")
            w.writeheader()
            for ts in sorted(rows):
                w.writerow(rows[ts])
    collect.write_index(args.data)
    if imported:
        first, last = min(imported), max(imported)
        print(f"Übernommen: {len(imported)} Messungen von {datetime.fromtimestamp(first)} bis {datetime.fromtimestamp(last)}")
    else:
        print("Nichts Neues übernommen.")


if __name__ == "__main__":
    main()
