"""Parser für die Live-Daten verschiedener Wetterstationen.

Alle Adapter liefern ein Dict mit den kanonischen Feldern in metrischen Einheiten:

    temp_out, temp_in, dewpoint, feels_like   °C
    hum_out, hum_in                           %
    pressure                                  hPa (relativ / auf Meereshöhe)
    wind_speed, wind_gust                     km/h
    wind_dir                                  Grad (0 = Nord)
    rain_rate                                 mm/h
    rain_day                                  mm (Tageszähler, Reset um Mitternacht)
    rain_total                                mm (fortlaufender Gesamtzähler)
    solar                                     W/m²
    uv                                        UV-Index

Fehlende Werte werden einfach weggelassen.
"""

import json
import re
from urllib.parse import parse_qsl

FIELDS = [
    "temp_out", "hum_out", "dewpoint", "feels_like", "temp_in", "hum_in",
    "pressure", "wind_speed", "wind_gust", "wind_dir", "rain_rate",
    "rain_day", "rain_total", "solar", "uv",
]

# Typ jeder Grösse, für die Einheitenumrechnung
KIND = {
    "temp_out": "temp", "temp_in": "temp", "dewpoint": "temp", "feels_like": "temp",
    "hum_out": "none", "hum_in": "none", "wind_dir": "none", "uv": "none", "solar": "none",
    "pressure": "press", "wind_speed": "speed", "wind_gust": "speed",
    "rain_rate": "rate", "rain_day": "rain", "rain_total": "rain",
}

_NUM = re.compile(r"[-+]?\d+(?:[.,]\d+)?")


def num(v):
    """Zahl aus int/float/String ('12.3 mm', '1,5') lesen, sonst None."""
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    m = _NUM.search(str(v))
    return float(m.group().replace(",", ".")) if m else None


# --------------------------------------------------------------------------- Einheiten

def to_metric(kind, value, unit):
    """Wert der Grösse `kind` mit Einheit `unit` (String, frei formatiert) umrechnen."""
    if value is None:
        return None
    u = (unit or "").lower().replace(" ", "").replace("°", "").replace("º", "")
    if kind == "temp":
        if u in ("f", "℉", "fahrenheit", "degf"):
            return (value - 32) * 5 / 9
    elif kind == "press":
        if u in ("inhg", "in", "inch"):
            return value * 33.8639
        if u == "mmhg":
            return value * 1.33322
        if u == "kpa":
            return value * 10
    elif kind == "speed":
        if u in ("mph", "mi/h"):
            return value * 1.609344
        if u in ("m/s", "ms", "mps"):
            return value * 3.6
        if u in ("kn", "kt", "knots", "knot", "kts"):
            return value * 1.852
    elif kind in ("rain", "rate"):
        if u in ("in", "inch", "inches", "in/h", "in/hr", "inch/hr", "inch/h"):
            return value * 25.4
        if u in ("cm", "cm/h"):
            return value * 10
        if u in ("mm/min",):
            return value * 60
    return value


def _unit_from_key(key):
    """Einheit aus Schlüsselnamen wie 'tempf', 'windspeedmph', 'baromin' ableiten."""
    k = key.lower()
    for suffix, unit in (("mph", "mph"), ("inhg", "inhg"), ("baromin", "inhg"), ("rainin", "in"),
                         ("_in", "in"), ("kmh", "km/h"), ("ms", "m/s"), ("hpa", "hpa"),
                         ("f", "f"), ("c", "c"), ("mm", "mm")):
        if k.endswith(suffix):
            return unit
    return ""


# --------------------------------------------------------------------------- Generisch (JSON / key=value)

# Je Feld: Liste von Regex auf dem normalisierten Pfad (Kleinbuchstaben, nur [a-z0-9.]),
# gefolgt von Ausschluss-Regex. Erster Treffer gewinnt.
_INDOOR = r"(indoor|inside|intemp|inhum|tempin|humin|wh25|interior|innen)"
GENERIC_RULES = {
    "temp_in": ([r"(^|\.)(indoor\.temperature|intemp\w*|tempin\w*|temp_?in|indoortemp\w*|insidetemp\w*)$"], None),
    "hum_in": ([r"(^|\.)(indoor\.humidity|inhumi\w*|humin|hum_?in|indoorhum\w*|insidehum\w*)$"], None),
    "dewpoint": ([r"(^|\.)(dew\w*|taupunkt)$"], None),
    "feels_like": ([r"(^|\.)(feels\w*|apparent\w*|heatindex\w*|windchill\w*|gefuehlt\w*)$"], None),
    "temp_out": ([r"(^|\.)(outdoor\.temperature|outtemp\w*|tempout|temp_?out|tempf|tempc|temp|temperature|air_?temp\w*|temperatur)$"],
                 _INDOOR + r"|soil|leaf|pool|water|wn3|ch\d|temp\d|feels|dew|chill|heat|apparent"),
    "hum_out": ([r"(^|\.)(outdoor\.humidity|outhum\w*|humidity|humid|hum|rh|luftfeuchte?)$"],
                _INDOOR + r"|soil|leaf|hum\d|ch\d"),
    "pressure": ([r"(^|\.)(relative|baromrelin|baromrel\w*|pressure_?rel\w*|rel)$",
                  r"(^|\.)(barom\w*|pressure\w*|baro\w*|press|sealevelpressure|qnh|luftdruck)$"],
                 r"absolute|abs$|baromabs|trend|absolut"),
    "wind_gust": ([r"(^|\.)(wind_?gust\w*|gust\w*|windgust|boe)$"], r"max_daily|maxdaily|daily|dir"),
    "wind_dir": ([r"(^|\.)(wind_?dir\w*|winddirection|direction|bearing|wdir|winddir_avg10m)$"], None),
    "wind_speed": ([r"(^|\.)(wind_?speed\w*|windspd\w*|windavg\w*|wind_?avg|wspd|wind)$"],
                   r"gust|dir|max|chill"),
    "rain_rate": ([r"(^|\.)(rain_?rate\w*|rainrate|preciprate|rate|regenrate)$"], r"max|piezo"),
    "rain_day": ([r"(^|\.)(daily\w*|rain_?day\w*|dailyrain\w*|raintoday|today|preciptotal|rain_?today|rainday|tagesregen)$"],
                 r"max|gust|piezo"),
    "rain_total": ([r"(^|\.)(totalrain\w*|rain_?total|raintotal|total|rain_?counter|rainall)$"], r"piezo|max"),
    "solar": ([r"(^|\.)(solar\w*|radiation|solarradiation|globalrad\w*|sun)$"], r"(^|\.)uv\w*$|max"),
    "uv": ([r"(^|\.)(uv\w*|uvindex|uvi)$"], r"max"),
}


def _flatten(obj, prefix="", out=None):
    """Verschachteltes JSON in {pfad: wert} umwandeln, inkl. Einheiten-Geschwister."""
    if out is None:
        out = {}
    if isinstance(obj, dict):
        unit = obj.get("unit") or obj.get("units") or obj.get("u")
        for k, v in obj.items():
            if k in ("unit", "units", "u"):
                continue
            p = f"{prefix}.{k}" if prefix else str(k)
            if k in ("value", "val", "v") and prefix:
                p = prefix  # {"temperature": {"value": 12, "unit": "°C"}} -> "temperature"
            if isinstance(v, (dict, list)):
                _flatten(v, p, out)
            else:
                out[p] = (v, unit if isinstance(unit, str) else None)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _flatten(v, f"{prefix}.{i}" if prefix else str(i), out)
    return out


def _norm(path):
    return re.sub(r"\.\d+(?=\.|$)", "", re.sub(r"[^a-z0-9._]", "", path.lower()))


def parse_generic_pairs(pairs, mapping=None, units=None):
    """pairs: {pfad: (wert, einheit)} -> kanonisches Dict."""
    mapping = mapping or {}
    units = units or {}
    result = {}
    norm = {}
    for path, (val, unit) in pairs.items():
        n = num(val)
        if n is not None:
            norm.setdefault(_norm(path), (path, n, unit))

    for field in FIELDS:
        hit = None
        if field in mapping:  # explizite Zuordnung aus config.json
            want = mapping[field]
            for np_, (path, n, unit) in norm.items():
                if path == want or np_ == _norm(want):
                    hit = (path, n, unit)
                    break
        else:
            includes, exclude = GENERIC_RULES[field]
            for inc in includes:
                for np_, item in norm.items():
                    if re.search(inc, np_) and not (exclude and re.search(exclude, np_)):
                        hit = item
                        break
                if hit:
                    break
        if not hit:
            continue
        path, n, unit = hit
        unit = units.get(field) or unit or _unit_from_key(path.split(".")[-1])
        result[field] = to_metric(KIND[field], n, unit)

    # Imperiale Gesamtausgabe (z.B. Weather Underground "imperial") erkennen
    paths = " ".join(norm)
    if "imperial" in paths and not units:
        for f, kind in KIND.items():
            if f in result and kind in ("temp", "speed", "press", "rain", "rate"):
                result[f] = to_metric(kind, result[f], {"temp": "f", "speed": "mph", "press": "inhg",
                                                        "rain": "in", "rate": "in/h"}[kind])
    return result


# --------------------------------------------------------------------------- Spezifische Formate

def parse_ecowitt_local(data):
    """Ecowitt/Froggit Gateway: http://<ip>/get_livedata_info"""
    ids = {"0x02": "temp_out", "0x07": "hum_out", "0x03": "dewpoint", "0x0A": "wind_dir",
           "0x0B": "wind_speed", "0x0C": "wind_gust", "0x15": "solar", "0x17": "uv",
           "0x0E": "rain_rate", "0x10": "rain_day", "0x13": "rain_total", "3": "feels_like"}
    out = {}

    def take(item):
        f = ids.get(str(item.get("id")))
        if not f:
            return
        raw = item.get("val")
        unit = item.get("unit") or re.sub(r"[-+\d.,\s]", "", str(raw))
        out[f] = to_metric(KIND[f], num(raw), unit)

    for item in data.get("common_list", []):
        take(item)
    for key in ("piezoRain", "rain"):
        for item in data.get(key, []) or []:
            if str(item.get("id")) in ("0x0E", "0x10", "0x13"):
                f = ids[str(item.get("id"))]
                if f not in out:
                    take(item)
    for wh in data.get("wh25", []) or []:
        if "intemp" in wh:
            out["temp_in"] = to_metric("temp", num(wh["intemp"]), wh.get("unit"))
        if "inhumi" in wh:
            out["hum_in"] = num(wh["inhumi"])
        if "rel" in wh:
            out["pressure"] = to_metric("press", num(wh["rel"]), re.sub(r"[-\d.\s]", "", str(wh["rel"])))
    if out.get("wind_dir") is not None:
        out["wind_dir"] %= 360
    return out


WEATHERCLOUD_RE = re.compile(r"weathercloud\.net(?:/[^?#]*?)?(?:/d|[?&]code=)(\d{6,})", re.I)


def weathercloud_code(url):
    """Geräte-ID aus https://app.weathercloud.net/d1234567890 oder …?code=1234567890"""
    m = WEATHERCLOUD_RE.search(url or "")
    return m.group(1) if m else None


def parse_weathercloud(data):
    """Weathercloud: app.weathercloud.net/device/values?code=<ID> (Wind in m/s)."""
    if not isinstance(data, dict):
        raise ValueError("Weathercloud lieferte keine Messwerte")

    def g(*keys):
        for k in keys:
            if num(data.get(k)) is not None:
                return num(data.get(k))
        return None
    ms = lambda v: None if v is None else v * 3.6  # noqa: E731
    out = {
        "temp_out": g("temp"), "hum_out": g("hum"), "dewpoint": g("dew"),
        "feels_like": g("thw", "chill", "heat"), "pressure": g("bar"),
        "wind_speed": ms(g("wspdavg", "wspd")), "wind_gust": ms(g("wspdhi", "wspd")),
        "wind_dir": g("wdiravg", "wdir"), "rain_rate": g("rainrate"), "rain_day": g("rain"),
        "solar": g("solarrad"), "uv": g("uvi"), "temp_in": g("tempin"), "hum_in": g("humin"),
    }
    if g("epoch"):
        out["_ts"] = int(g("epoch"))
    return out


def parse_clientraw(text):
    """Weather Display clientraw.txt (Wind in Knoten)."""
    p = text.split()
    if len(p) < 14 or p[0] != "12345":
        raise ValueError("Kein clientraw.txt-Format")

    def g(i):
        return num(p[i]) if i < len(p) else None
    out = {
        "wind_speed": g(1) and g(1) * 1.852, "wind_gust": g(2) and g(2) * 1.852, "wind_dir": g(3),
        "temp_out": g(4), "hum_out": g(5), "pressure": g(6), "rain_day": g(7),
        "rain_rate": g(10) and g(10) * 60, "temp_in": g(12), "hum_in": g(13),
        "solar": g(127), "uv": g(79), "dewpoint": g(72), "feels_like": g(130),
    }
    if g(1) == 0:
        out["wind_speed"] = 0.0
    if g(2) == 0:
        out["wind_gust"] = 0.0
    return out


def parse_cumulus_realtime(text):
    """Cumulus/CumulusMX realtime.txt"""
    p = text.split()
    if len(p) < 20:
        raise ValueError("Kein realtime.txt-Format")

    def g(i):
        return num(p[i]) if i < len(p) else None
    wu, tu, pu, ru = p[13], p[14], p[15], p[16]
    tu = "f" if "f" in tu.lower() else "c"
    out = {
        "temp_out": to_metric("temp", g(2), tu), "hum_out": g(3), "dewpoint": to_metric("temp", g(4), tu),
        "wind_speed": to_metric("speed", g(5), wu), "wind_dir": g(7),
        "rain_rate": to_metric("rate", g(8), ru), "rain_day": to_metric("rain", g(9), ru),
        "pressure": to_metric("press", g(10), pu.replace("hPa", "hpa")),
        "temp_in": to_metric("temp", g(22), tu), "hum_in": g(23),
        "wind_gust": to_metric("speed", g(40), wu), "uv": g(43), "solar": g(45),
        "feels_like": to_metric("temp", g(54), tu),
    }
    return out


def parse_keyvalue(text):
    """'temp=12.3&hum=80' oder Zeilen 'temp: 12.3'."""
    if "=" in text and "&" in text:
        pairs = parse_qsl(text.strip().lstrip("?"))
    else:
        pairs = re.findall(r"^\s*([\w.\- ]+?)\s*[:=]\s*(.+?)\s*$", text, re.M)
    return {k: (v, None) for k, v in pairs}


# --------------------------------------------------------------------------- Einstieg

def parse(body, adapter="auto", mapping=None, units=None):
    """Rohdaten (bytes/str) der Station in kanonische Werte umwandeln."""
    text = body.decode("utf-8", "replace") if isinstance(body, bytes) else body
    stripped = text.strip()

    data = None
    if stripped[:1] in "{[":
        try:
            data = json.loads(stripped)
        except ValueError:
            data = None

    if adapter == "weathercloud":
        out = parse_weathercloud(data)
    elif adapter == "ecowitt_local" or (adapter == "auto" and isinstance(data, dict) and "common_list" in data):
        out = parse_ecowitt_local(data)
    elif adapter == "clientraw" or (adapter == "auto" and stripped.startswith("12345 ")):
        out = parse_clientraw(stripped)
    elif adapter == "cumulus" or (adapter == "auto" and data is None and
                                  re.match(r"^\d{2}[-/.]\d{2}[-/.]\d{2,4} \d{2}:\d{2}", stripped)):
        out = parse_cumulus_realtime(stripped)
    elif data is not None:
        out = parse_generic_pairs(_flatten(data), mapping, units)
    else:
        out = parse_generic_pairs(parse_keyvalue(stripped), mapping, units)

    ts = out.get("_ts")
    out = {k: round(v, 3) for k, v in out.items() if v is not None and k in FIELDS}
    if not out:
        raise ValueError("Keine bekannten Messwerte in der Antwort gefunden")
    if ts:
        out["_ts"] = ts  # Messzeitpunkt laut Station (Unix-Sekunden)
    return out
