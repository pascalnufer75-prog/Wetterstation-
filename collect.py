#!/usr/bin/env python3
"""Einmaliger Abruf der Station – für GitHub Actions (oder cron).

Hängt eine neue Messung an data/JJJJ-MM.csv an und aktualisiert data/index.json.
Schreibt nichts, wenn die Station seit dem letzten Abruf keinen neuen Wert hatte.

    python3 collect.py --data pfad/zu/data
"""

import argparse
import csv
import glob
import json
import os
import sys
import time
from datetime import datetime, timezone

import server

COLUMNS = ["ts"] + server.DATA_FIELDS


def read_last_row(data_dir):
    files = sorted(glob.glob(os.path.join(data_dir, "????-??.csv")))
    for path in reversed(files):
        with open(path, newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        if rows:
            last = rows[-1]
            return {k: (float(v) if v not in ("", None) else None) for k, v in last.items()}
    return None


def write_index(data_dir, **extra):
    path = os.path.join(data_dir, "index.json")
    index = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            index = json.load(f)
    index["months"] = sorted(os.path.basename(p)[:7] for p in glob.glob(os.path.join(data_dir, "????-??.csv")))
    index.update(extra)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(index, f, indent=1, ensure_ascii=False)
    return index


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data", help="Ordner für die CSV-Dateien")
    ap.add_argument("--config", default=server.CONFIG_PATH)
    args = ap.parse_args()
    os.makedirs(args.data, exist_ok=True)
    cfg = server.Config(args.config)
    now = int(time.time())

    try:
        values = server.fetch_and_parse(cfg["source_url"], cfg["adapter"], cfg["mapping"], cfg["units"], debug=True)
    except Exception as e:  # noqa: BLE001
        print(f"Fehler beim Abruf: {e}", file=sys.stderr)
        old = {}
        p = os.path.join(args.data, "index.json")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                old = json.load(f)
        if old.get("last_error") != str(e):  # nur bei neuem Fehlertext schreiben
            write_index(args.data, last_error=str(e), last_error_time=now)
        return

    station_ts = values.pop("_ts", None)
    ts = int(station_ts) if station_ts and abs(station_ts - now) < 7 * 86400 else now
    last = read_last_row(args.data)
    if last and last["ts"] is not None and ts <= int(last["ts"]):
        print(f"Keine neue Messung (Station: {datetime.fromtimestamp(ts)}).")
        return

    values = server.complete(values)
    values["rain_mm"] = server.RainTracker(last=last).increment(ts, values)
    month = datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m")
    path = os.path.join(args.data, f"{month}.csv")
    new = not os.path.exists(path)
    with open(path, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(COLUMNS)
        w.writerow([ts] + ["" if values.get(c) is None else values[c] for c in COLUMNS[1:]])
    write_index(args.data, updated=ts, last_error=None, source=cfg["source_url"])
    print(f"Gespeichert: {datetime.fromtimestamp(ts, timezone.utc):%Y-%m-%d %H:%M} UTC  "
          + ", ".join(f"{k}={v}" for k, v in values.items()))


if __name__ == "__main__":
    main()
