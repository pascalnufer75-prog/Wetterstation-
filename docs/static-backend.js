/* Wetterstation – "Server im Browser" für GitHub Pages.
   Liest die Messwerte (CSV pro Monat), die GitHub Actions im Zweig "daten" ablegt,
   und beantwortet dieselben api/...-Anfragen wie server.py. */
"use strict";

const StaticBackend = (() => {
  const FIELDS = ["temp_out", "hum_out", "dewpoint", "feels_like", "temp_in", "hum_in", "pressure", "wind_speed", "wind_gust",
    "wind_dir", "rain_rate", "rain_day", "rain_total", "solar", "uv", "rain_mm"];
  const AGG = {
    temp_out: ["avg", "min", "max"], hum_out: ["avg", "min", "max"], dewpoint: ["avg", "min", "max"], feels_like: ["avg", "min", "max"],
    temp_in: ["avg", "min", "max"], hum_in: ["avg", "min", "max"], pressure: ["avg", "min", "max"], wind_speed: ["avg", "max"],
    wind_gust: ["max"], rain_rate: ["max"], solar: ["avg", "max"], uv: ["avg", "max"],
  };
  const DEFAULTS = { station_name: "Meine Wetterstation", source_url: "", adapter: "auto", poll_interval: 600,
    roof_area: 36, runoff_coefficient: 1, tank_capacity: 0, latitude: null, longitude: null, elevation: null };
  const LS_KEY = "wetterstation-einstellungen";

  // ---- Wo liegen die Daten?  Auf <user>.github.io/<repo>/ aus der Adresse, sonst aus <meta name="wetter-repo">
  const gh = location.hostname.match(/^([^.]+)\.github\.io$/);
  const ghRepo = gh && location.pathname.split("/").filter(Boolean)[0];
  const metaRepo = document.querySelector('meta[name="wetter-repo"]')?.content;
  const slug = gh && ghRepo ? `${gh[1]}/${ghRepo}` : metaRepo;
  const RAW = slug ? `https://raw.githubusercontent.com/${slug}` : null;
  const DATA_URL = RAW ? `${RAW}/daten/data/` : "data/";
  const CONFIG_URL = RAW ? `${RAW}/main/config.json` : "../config.json";

  let rows = [];               // [{ts, temp_out, ...}] nach Zeit sortiert
  // Tageswerte (Min/Mittel/Max) für Tage ohne Einzelmessungen, z.B. aus Weathercloud-Diagrammen
  // abgelesen. Jeder Tag zählt bei Mittelwerten wie 144 Messungen (10-Minuten-Takt).
  let daily = [];              // [{ts (12:00 Ortszeit), day, temp_out_min, temp_out, temp_out_max, hum_out, ...}]
  const DAILY_WEIGHT = 144;
  const dayKey = (ts) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const monthCache = {};       // "2026-10" -> rows
  let index = null, repoConfig = {}, loadedAt = 0, bytes = 0;

  const bust = () => `?t=${Math.floor(Date.now() / 60000)}`;

  function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/);
    const head = lines.shift().split(",");
    return lines.map((l) => {
      const c = l.split(","), r = {};
      head.forEach((h, i) => { if (c[i] !== "" && c[i] !== undefined) r[h] = +c[i]; });
      return r;
    });
  }

  async function load(force = false) {
    if (!force && Date.now() - loadedAt < 60e3 && rows.length) return;
    const [idx, cfg] = await Promise.all([
      fetch(DATA_URL + "index.json" + bust()).then((r) => (r.ok ? r.json() : { months: [] })).catch(() => ({ months: [] })),
      Object.keys(repoConfig).length ? repoConfig : fetch(CONFIG_URL + bust()).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    index = idx; repoConfig = cfg;
    const months = idx.months || [];
    const latest = months[months.length - 1];
    await Promise.all(months.map(async (m) => {
      if (monthCache[m] && m !== latest) return;  // abgeschlossene Monate nur einmal laden
      const r = await fetch(`${DATA_URL}${m}.csv${m === latest ? bust() : ""}`);
      if (!r.ok) return;
      const text = await r.text();
      monthCache[m] = parseCsv(text);
      monthCache[m].bytes = text.length;
    }));
    rows = months.flatMap((m) => monthCache[m] || []).sort((a, b) => a.ts - b.ts);
    if (idx.tageswerte) {
      const r = await fetch(DATA_URL + "tageswerte.csv" + bust()).catch(() => null);
      const withTemp = new Set(rows.filter((x) => x.temp_out !== undefined).map((x) => dayKey(x.ts)));
      const lines = r && r.ok ? (await r.text()).trim().split(/\r?\n/) : [];
      const head = (lines.shift() || "").split(",");  // datum, dann Felder wie temp_out_min, temp_out, temp_out_max, ...
      daily = lines.map((l) => {
        const c = l.split(","), [y, m, d] = c[0].split("-").map(Number);
        const ts = new Date(y, m - 1, d, 12).getTime() / 1000, o = { ts, day: dayKey(ts) };
        head.forEach((h, i) => { if (i > 0 && c[i] !== "" && c[i] !== undefined) o[h] = +c[i]; });
        return o;
      }).filter((x) => !withTemp.has(x.day));  // echte Messungen haben Vorrang
    }
    bytes = months.reduce((s, m) => s + (monthCache[m]?.bytes || 0), 0);
    loadedAt = Date.now();
  }

  function settings() {
    let local = {};
    try { local = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch (e) { /* privates Fenster */ }
    const s = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (repoConfig[k] !== undefined) s[k] = repoConfig[k];
    s.source_url = index?.source || s.source_url;
    return { ...s, ...local, source_url: s.source_url, poll_interval: 600 };
  }
  const liters = (mm) => (mm || 0) * settings().roof_area * settings().runoff_coefficient;
  const r2 = (x, d = 2) => (x === null || x === undefined ? x : Math.round(x * 10 ** d) / 10 ** d);
  const range = (from, to) => {
    let lo = 0, hi = rows.length;
    while (lo < hi) { const m = (lo + hi) >> 1; rows[m].ts < from ? (lo = m + 1) : (hi = m); }
    const out = [];
    for (let i = lo; i < rows.length && rows[i].ts < to; i++) out.push(rows[i]);
    return out;
  };

  function autoBucket(span) {
    if (span <= 2 * 86400) return "raw";
    if (span <= 10 * 86400) return "10min";
    if (span <= 62 * 86400) return "hour";
    if (span <= 3 * 365 * 86400) return "day";
    return "month";
  }
  function bucketStart(ts, b) {
    if (b === "10min") return Math.floor(ts / 600) * 600 * 1000;
    const d = new Date(ts * 1000);
    if (b === "hour") return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
    if (b === "day") return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (b === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    return new Date(d.getFullYear(), 0, 1).getTime();
  }

  function history(from, to, bucket) {
    if (bucket === "auto") {
      bucket = autoBucket(to - from);
      // Enthält der Zeitraum nur Tageswerte (abgelesene Tage), wären sie in Stundenansichten unsichtbar
      if (["raw", "10min", "hour"].includes(bucket) && daily.some((d) => d.ts >= from && d.ts < to)) bucket = "day";
    }
    const sel = range(from, to);
    if (bucket === "raw") {
      return { bucket, rows: sel.map((r) => {
        const o = { t: r.ts * 1000 };
        for (const f of FIELDS) if (r[f] !== undefined) o[f] = r[f];
        if (r.rain_mm !== undefined) o.rain_l = r2(liters(r.rain_mm));
        return o;
      }) };
    }
    const groups = new Map(), dayGroups = new Map();
    for (const r of sel) {
      const k = bucketStart(r.ts, bucket);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push(r);
    }
    if (["day", "month", "year"].includes(bucket)) {  // Tageswerte passen nur in Tages- oder gröbere Gruppen
      for (const d of daily) {
        if (d.ts < from || d.ts >= to) continue;
        const k = bucketStart(d.ts, bucket);
        if (!groups.has(k)) groups.set(k, []);
        if (!dayGroups.has(k)) dayGroups.set(k, []);
        dayGroups.get(k).push(d);
      }
    }
    const out = [];
    for (const [t, g] of [...groups].sort((a, b) => a[0] - b[0])) {
      const days = dayGroups.get(t) || [];
      const o = { t, n: g.length + days.length * DAILY_WEIGHT };
      for (const [f, aggs] of Object.entries(AGG)) {
        const v = g.map((r) => r[f]).filter((x) => x !== undefined);
        // Tageswert eines Feldes: Mittel unter f, Extreme unter f_min / f_max (fehlt eines, gilt das Mittel)
        const dget = (d, a) => (a === "avg" ? d[f] : d[`${f}_${a}`] ?? d[f]);
        const dv = days.filter((d) => aggs.some((a) => dget(d, a) !== undefined));
        if (!v.length && !dv.length) continue;
        for (const a of aggs) {
          const key = a === "avg" ? f : `${f}_${a}`;
          const dvals = dv.map((d) => dget(d, a)).filter((x) => x !== undefined);
          if (!v.length && !dvals.length) continue;
          if (a === "avg") {
            const total = v.reduce((s, x) => s + x, 0) + dvals.reduce((s, x) => s + x * DAILY_WEIGHT, 0);
            o[key] = r2(total / (v.length + dvals.length * DAILY_WEIGHT));
          } else {
            const all = [...v, ...dvals];
            o[key] = r2(a === "min" ? Math.min(...all) : Math.max(...all));
          }
        }
      }
      const dirs = [...g.filter((r) => r.wind_dir !== undefined).map((r) => [r.wind_dir, 1]),
        ...days.filter((d) => d.wind_dir !== undefined).map((d) => [d.wind_dir, DAILY_WEIGHT])];
      if (dirs.length) {
        const sx = dirs.reduce((s, [d, w]) => s + w * Math.sin((d * Math.PI) / 180), 0);
        const cx = dirs.reduce((s, [d, w]) => s + w * Math.cos((d * Math.PI) / 180), 0);
        o.wind_dir = r2(((Math.atan2(sx, cx) * 180) / Math.PI + 360) % 360);
      }
      if (g.some((r) => r.rain_mm !== undefined)) {  // ältere Importe ohne Regen: "keine Daten" statt 0
        o.rain_mm = r2(g.reduce((s, r) => s + (r.rain_mm || 0), 0));
        o.rain_l = r2(liters(o.rain_mm), 1);
      }
      out.push(o);
    }
    return { bucket, rows: out };
  }

  const rainSum = (from, to = Infinity) => r2(range(from, to).reduce((s, r) => s + (r.rain_mm || 0), 0));
  function rainOverview() {
    const now = new Date(), mid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const s = (d) => Math.floor(d.getTime() / 1000);
    const per = [
      ["today", s(mid)], ["yesterday", s(mid) - 86400, s(mid)], ["week", s(now) - 7 * 86400],
      ["month", s(new Date(now.getFullYear(), now.getMonth(), 1))], ["days30", s(now) - 30 * 86400],
      ["year", s(new Date(now.getFullYear(), 0, 1))], ["all", 0],
    ];
    return per.map(([key, a, b]) => { const mm = rainSum(a, b); return { key, label: key, mm, liters: r2(liters(mm), 1) }; });
  }

  function extreme(list, f, max) {
    let best = null;
    for (const r of list) if (r[f] !== undefined && (best === null || (max ? r[f] > best[f] : r[f] < best[f]))) best = r;
    return best ? { value: best[f], t: best.ts * 1000 } : null;
  }

  function latest() {
    const cur = rows[rows.length - 1] || null;
    const now = Date.now() / 1000;
    const d = new Date();
    const today = range(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000, Infinity);
    const ago = (f, sec) => {
      if (!cur || cur[f] === undefined) return null;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].ts <= cur.ts - sec && rows[i][f] !== undefined) {
        return cur.ts - rows[i].ts > sec * 2 ? null : r2(cur[f] - rows[i][f]);
      }
      return null;
    };
    return {
      current: cur,
      today: {
        temp_min: extreme(today, "temp_out", false), temp_max: extreme(today, "temp_out", true),
        gust_max: extreme(today, "wind_gust", true), hum_min: extreme(today, "hum_out", false),
        hum_max: extreme(today, "hum_out", true), solar_max: extreme(today, "solar", true),
        uv_max: extreme(today, "uv", true), rain_rate_max: extreme(today, "rain_rate", true),
      },
      trends: { temp_1h: ago("temp_out", 3600), pressure_3h: ago("pressure", 3 * 3600), hum_1h: ago("hum_out", 3600) },
      rain: rainOverview(),
      status: { last_ok: index?.updated || null, last_error: index?.last_error || null, demo: false, static: true, now: Math.floor(now) },
      settings: settings(),
    };
  }

  function records() {
    const byDay = new Map();
    for (const r of rows) {
      const k = bucketStart(r.ts, "day");
      byDay.set(k, (byDay.get(k) || 0) + (r.rain_mm || 0));
    }
    let wet = null;
    for (const [t, mm] of byDay) if (mm > 0 && (!wet || mm > wet.value)) wet = { value: r2(mm, 1), t, liters: Math.round(liters(mm)) };
    // Tageswerte haben keine Uhrzeit: Rekord dann nur mit Datum anzeigen
    const withDaily = (field, key, max) => {
      const fromRows = extreme(rows, field, max);
      const fromDaily = extreme(daily.filter((d) => d[key] !== undefined).map((d) => ({ ts: d.ts, [field]: d[key] })), field, max);
      if (!fromDaily) return fromRows;
      if (!fromRows || (max ? fromDaily.value > fromRows.value : fromDaily.value < fromRows.value)) return { ...fromDaily, date_only: true };
      return fromRows;
    };
    return {
      temp_max: withDaily("temp_out", "temp_out_max", true), temp_min: withDaily("temp_out", "temp_out_min", false),
      gust_max: withDaily("wind_gust", "wind_gust_max", true), pressure_max: withDaily("pressure", "pressure_max", true),
      pressure_min: withDaily("pressure", "pressure_min", false), rain_rate_max: extreme(rows, "rain_rate", true),
      solar_max: withDaily("solar", "solar_max", true), wettest_day: wet,
    };
  }

  function windRose(from, to) {
    const classes = [0, 5, 10, 20, 30, 50];
    const counts = Array.from({ length: 16 }, () => classes.map(() => 0));
    let total = 0, calm = 0;
    for (const r of range(from, to)) {
      if (r.wind_dir === undefined || r.wind_speed === undefined) continue;
      total++;
      if (r.wind_speed < 1) { calm++; continue; }
      const sector = Math.floor((((r.wind_dir % 360) + 11.25) / 22.5)) % 16;
      let cls = 0;
      classes.forEach((c, i) => { if (r.wind_speed >= c) cls = i; });
      counts[sector][cls]++;
    }
    return { classes, counts, total, calm };
  }

  function info() {
    return {
      count: rows.length, first: rows[0] ? rows[0].ts * 1000 : null, last: rows.length ? rows[rows.length - 1].ts * 1000 : null,
      size_bytes: bytes, file: "GitHub, Zweig „daten“ (CSV pro Monat)", settings: settings(),
      status: { last_ok: index?.updated || null, last_error: index?.last_error || null }, demo: false, static: true,
      raw_url: DATA_URL,
    };
  }

  async function request(path, opts = {}) {
    const url = new URL(path, location.href);
    const q = Object.fromEntries(url.searchParams);
    const ep = url.pathname.split("/api/")[1];
    if (ep === "settings" && opts.method === "POST") {
      const body = JSON.parse(opts.body || "{}");
      const keep = {};
      for (const k of ["station_name", "roof_area", "runoff_coefficient", "tank_capacity"]) {
        if (body[k] === undefined || body[k] === "") continue;
        keep[k] = k === "station_name" ? String(body[k]) : +body[k];
      }
      if (keep.roof_area !== undefined && !(keep.roof_area > 0)) throw new Error("Dachfläche muss grösser als 0 sein");
      if (keep.runoff_coefficient !== undefined && !(keep.runoff_coefficient > 0 && keep.runoff_coefficient <= 1)) throw new Error("Abflussbeiwert muss zwischen 0.05 und 1 liegen");
      try { localStorage.setItem(LS_KEY, JSON.stringify(keep)); } catch (e) { throw new Error("Speichern im Browser nicht möglich"); }
      return { ok: true, settings: settings() };
    }
    await load(ep === "latest");
    const now = Math.floor(Date.now() / 1000);
    const to = q.to ? +q.to : now + 1, from = q.from ? +q.from : to - 86400;
    switch (ep) {
      case "latest": return latest();
      case "history": { const h = history(from, to, q.bucket || "auto"); return { ...h, from: from * 1000, to: to * 1000 }; }
      case "windrose": return windRose(from, to);
      case "records": return records();
      case "info": return info();
      case "test-source": return { ok: false, error: "Im Browser nicht möglich – die Station wird von GitHub Actions abgefragt." };
      default: throw new Error("unbekannter Endpunkt " + ep);
    }
  }

  // ---- Downloads (werden im Browser erzeugt)
  const LABELS = {
    temp_out: "Temperatur aussen [°C]", hum_out: "Luftfeuchte aussen [%]", dewpoint: "Taupunkt [°C]", feels_like: "Gefühlte Temperatur [°C]",
    temp_in: "Temperatur innen [°C]", hum_in: "Luftfeuchte innen [%]", pressure: "Luftdruck [hPa]", wind_speed: "Wind [km/h]",
    wind_gust: "Böen [km/h]", wind_dir: "Windrichtung [°]", rain_rate: "Regenrate [mm/h]", rain_day: "Regen Tageszähler [mm]",
    rain_total: "Regen Gesamtzähler [mm]", rain_mm: "Regen [mm]", rain_l: "Regentank Zufluss [L]", solar: "Sonnenstrahlung [W/m²]", uv: "UV-Index",
  };
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  function download(name, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function exportTable(format, bucket, from, to) {
    await load();
    const h = history(from, to, bucket);
    const tag = new Date().toISOString().slice(0, 10);
    if (format === "json") {
      const body = { station: settings().station_name, bucket: h.bucket, roof_area_m2: settings().roof_area,
        runoff_coefficient: settings().runoff_coefficient, units: LABELS, rows: h.rows.map((r) => ({ ...r, time: stamp(r.t) })) };
      return download(`wetterstation-${h.bucket}-${tag}.json`, new Blob([JSON.stringify(body)], { type: "application/json" }));
    }
    const keys = [];
    for (const r of h.rows) for (const k of Object.keys(r)) if (!keys.includes(k) && k !== "t" && k !== "n") keys.push(k);
    const order = [];
    for (const k of [...Object.keys(LABELS), ...keys]) for (const c of [k, k + "_min", k + "_max"]) if (keys.includes(c) && !order.includes(c)) order.push(c);
    const label = (k) => { const m = k.match(/^(.*)_(min|max)$/); return LABELS[k] || (m && LABELS[m[1]] ? `${LABELS[m[1]]} ${m[2]}` : k); };
    const lines = [["Zeit", ...order.map(label)].join(";")];
    for (const r of h.rows) lines.push([stamp(r.t), ...order.map((k) => (r[k] ?? ""))].join(";"));
    download(`wetterstation-${h.bucket}-${tag}.csv`, new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
  }

  async function exportSqlite() {
    await load();
    if (!window.initSqlJs) {
      await new Promise((ok, fail) => {
        const s = document.createElement("script");
        s.src = "vendor/sql-wasm.js"; s.onload = ok; s.onerror = fail;
        document.head.appendChild(s);
      });
    }
    const SQL = await window.initSqlJs({ locateFile: (f) => "vendor/" + f });
    const db = new SQL.Database();
    db.run(`CREATE TABLE readings (ts INTEGER PRIMARY KEY, ${FIELDS.map((f) => f + " REAL").join(", ")})`);
    db.run("BEGIN");
    const st = db.prepare(`INSERT OR REPLACE INTO readings VALUES (${["?", ...FIELDS.map(() => "?")].join(",")})`);
    for (const r of rows) st.run([r.ts, ...FIELDS.map((f) => (r[f] === undefined ? null : r[f]))]);
    st.free();
    db.run("COMMIT");
    const s = settings();
    db.run("CREATE TABLE einstellungen (schluessel TEXT PRIMARY KEY, wert TEXT)");
    for (const k of ["station_name", "source_url", "roof_area", "runoff_coefficient"]) db.run("INSERT INTO einstellungen VALUES (?, ?)", [k, String(s[k])]);
    db.run(`CREATE VIEW tageswerte AS SELECT date(ts, 'unixepoch', 'localtime') AS tag,
      round(avg(temp_out),1) AS temp_mittel, min(temp_out) AS temp_min, max(temp_out) AS temp_max,
      round(sum(rain_mm),1) AS regen_mm, round(sum(rain_mm) * ${s.roof_area * s.runoff_coefficient}, 0) AS regentank_liter,
      max(wind_gust) AS boe_max FROM readings GROUP BY tag`);
    const data = db.export();
    db.close();
    download(`wetterstation-${new Date().toISOString().slice(0, 10)}.db`, new Blob([data], { type: "application/vnd.sqlite3" }));
  }

  return { request, exportTable, exportSqlite, DATA_URL };
})();
