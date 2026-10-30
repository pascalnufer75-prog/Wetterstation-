/* Wetterstation-Dashboard */
"use strict";

// ====================================================================== Hilfen
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const DAY = 86400000;
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const MONTHS_LONG = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const DIRS = ["N", "NNO", "NO", "ONO", "O", "OSO", "SO", "SSO", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const PALETTE = ["#2563eb", "#f97316", "#10b981", "#a855f7", "#ef4444", "#eab308", "#06b6d4", "#64748b", "#ec4899", "#84cc16"];
const C = { temp: "#f97316", dew: "#14b8a6", feels: "#f43f5e", hum: "#06b6d4", press: "#8b5cf6", wind: "#10b981",
  gust: "#a3e635", rain: "#3b82f6", tank: "#0891b2", solar: "#f59e0b", uv: "#a855f7", indoor: "#e879f9" };

const nfCache = {};
function nf(v, d = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  const f = nfCache[d] || (nfCache[d] = new Intl.NumberFormat("de-CH", { minimumFractionDigits: d, maximumFractionDigits: d }));
  return f.format(v);
}
const pad = (n) => String(n).padStart(2, "0");
const fmtTime = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDate = (t) => { const d = new Date(t); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; };
const fmtDateTime = (t) => `${fmtDate(t)} ${fmtTime(t)}`;
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dirName = (deg) => (deg === null || deg === undefined ? "–" : DIRS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]);
const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, "0");
const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let STATIC_MODE = false;  // true auf GitHub Pages: Daten kommen als CSV aus dem Zweig "daten"
async function detectMode() {
  try {
    const r = await fetch("api/info", { cache: "no-store" });
    STATIC_MODE = !(r.ok && (r.headers.get("content-type") || "").includes("json"));
  } catch (e) { STATIC_MODE = true; }
  document.body.classList.toggle("static-mode", STATIC_MODE);
}
async function api(path, opts) {
  if (STATIC_MODE) return StaticBackend.request(path, opts);
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
const history = (from, to, bucket = "auto") =>
  api(`api/history?from=${Math.floor(from / 1000)}&to=${Math.floor(to / 1000)}&bucket=${bucket}`);

let SETTINGS = { roof_area: 36, runoff_coefficient: 1, tank_capacity: 0 };
let INFO = null;

// ====================================================================== Chart.js Grundeinstellungen
Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
Chart.defaults.font.size = 12;
Chart.defaults.color = css("--muted");
Chart.defaults.borderColor = alpha("#94a3b8", 0.18);
Chart.defaults.maintainAspectRatio = false;
Chart.defaults.animation.duration = 500;
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.plugins.legend.labels.boxWidth = 8;
Chart.defaults.plugins.legend.labels.boxHeight = 8;
Chart.defaults.plugins.tooltip.backgroundColor = "rgba(15,23,42,.92)";
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 8;
Chart.defaults.elements.point.radius = 0;
Chart.defaults.elements.point.hoverRadius = 4;
Chart.defaults.elements.line.borderWidth = 2;
Chart.defaults.elements.line.tension = 0.3;
Chart.defaults.interaction = { mode: "index", intersect: false };

const charts = {};
function chart(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id), config);
  return charts[id];
}

function timeAxis(bucket) {
  const unit = { raw: undefined, "10min": undefined, hour: undefined, day: "day", month: "month", year: "year" }[bucket];
  return {
    type: "time",
    time: {
      unit,
      tooltipFormat: bucket === "day" ? "EEE dd.MM.yyyy" : bucket === "month" ? "MM.yyyy" : bucket === "year" ? "yyyy" : "dd.MM.yyyy HH:mm",
      displayFormats: { minute: "HH:mm", hour: "HH:mm", day: "dd.MM.", week: "dd.MM.", month: "MM.yyyy", quarter: "MM.yyyy", year: "yyyy" },
    },
    grid: { display: false },
    ticks: { maxRotation: 0, autoSkipPadding: 18 },
  };
}

const pts = (rows, key) => rows.map((r) => ({ x: r.t, y: r[key] ?? null }));
const hasKey = (rows, key) => rows.some((r) => r[key] !== undefined && r[key] !== null);

/* Grösste Lücke, die noch verbunden wird: grösser = Ausfall der Station, bleibt als Lücke sichtbar */
let SPAN = 3 * 3600e3;
const spanFor = (bucket) => ({ day: 3 * DAY, month: 62 * DAY, year: 732 * DAY }[bucket] || 3 * 3600e3);
function line(label, rows, key, color, extra = {}) {
  return { type: "line", label, data: pts(rows, key), borderColor: color, backgroundColor: color, spanGaps: SPAN, ...extra };
}
/* Min/Max-Band: zwei Datensätze, der zweite füllt bis zum ersten */
function band(label, rows, key, color) {
  if (!hasKey(rows, key + "_min")) return [];
  const base = { type: "line", borderWidth: 0, pointRadius: 0, pointHoverRadius: 0, spanGaps: SPAN };
  return [
    { ...base, label: label + " min", data: pts(rows, key + "_min"), borderColor: "transparent", backgroundColor: "transparent", fill: false },
    { ...base, label: label + " max", data: pts(rows, key + "_max"), borderColor: "transparent", backgroundColor: alpha(color, 0.16), fill: "-1" },
  ];
}
function cumulative(rows, key) {
  let s = 0;
  let started = false;  // vor den ersten Regendaten (z.B. Importe ohne Regen): keine Linie
  return rows.map((r) => {
    const v = r[key];
    if (v !== undefined && v !== null) { started = true; s += v; }
    return { x: r.t, y: started ? s : null };
  });
}
const hasRain = (rows) => rows.some((r) => r.rain_mm !== undefined && r.rain_mm !== null);
const legendNoBand = { labels: { filter: (i) => !/ (min|max)$/.test(i.text) } };

// ====================================================================== Navigation
const loaded = {};
function showTab(name) {
  if (!$("#tab-" + name)) name = "live";
  $$(".tab").forEach((s) => (s.hidden = s.id !== "tab-" + name));
  $$("#tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === name));
  const init = { live: initLive, history: loadHistory, compare: loadCompare, tank: loadTank, data: loadData, settings: loadSettings }[name];
  if (name === "live" || !loaded[name]) { loaded[name] = true; init(); }
  else if (name !== "settings") init();
}
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// ====================================================================== Übersicht
let latestData = null;
async function refreshLatest() {
  try {
    const d = await api("api/latest");
    latestData = d;
    SETTINGS = d.settings;
    renderStatus(d);
    renderLive(d);
  } catch (e) {
    $("#status").className = "status err";
    $("#statusText").textContent = "Server nicht erreichbar";
  }
}

function renderStatus(d) {
  const s = d.status, st = $("#status");
  $("#stationName").textContent = d.settings.station_name || "Wetterstation";
  document.title = d.settings.station_name || "Wetterstation";
  const last = d.current ? d.current.ts * 1000 : null;
  const age = last ? Math.round((Date.now() - last) / 1000) : null;
  const ageTxt = age === null ? "noch keine Daten" : age < 90 ? `aktualisiert vor ${age} s`
    : age < 3600 ? `letzte Messung vor ${Math.round(age / 60)} min` : `letzte Messung ${fmtDateTime(last)}`;
  const stale = age !== null && age > (s.static ? 3 * 3600 : 1800);
  if (s.demo) { st.className = "status demo"; $("#statusText").textContent = `Demo-Modus · ${ageTxt}`; }
  else if (s.last_error) { st.className = "status err"; $("#statusText").textContent = `Fehler: ${s.last_error}`; }
  else if (stale) { st.className = "status err"; $("#statusText").textContent = `keine neuen Daten · ${ageTxt}`; }
  else { st.className = "status ok"; $("#statusText").textContent = ageTxt; }

  const b = $("#banner");
  if (s.static && !d.current) {
    b.hidden = false;
    b.innerHTML = "Noch keine Messwerte vorhanden. GitHub Actions fragt die Station alle 5 Minuten ab – bitte etwas Geduld.";
  } else if (!s.demo && !d.settings.source_url) {
    b.hidden = false;
    b.innerHTML = 'Noch keine Live-URL hinterlegt. Trage die Adresse deiner Station unter <a href="#settings">Einstellungen</a> ein.';
  } else b.hidden = true;
}

function setTrend(el, delta, unit, digits = 1, thresh = 0.2) {
  if (delta === null || delta === undefined) { el.textContent = ""; el.className = "trend"; return; }
  const up = delta > thresh, down = delta < -thresh;
  el.className = "trend" + (up ? " up" : down ? " down" : "");
  el.textContent = `${up ? "▲" : down ? "▼" : "▶"} ${delta > 0 ? "+" : ""}${nf(delta, digits)} ${unit}/h`;
}

function beaufort(kmh) {
  const lim = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
  const names = ["Windstille", "leiser Zug", "leichte Brise", "schwache Brise", "mässige Brise", "frische Brise",
    "starker Wind", "steifer Wind", "stürmischer Wind", "Sturm", "schwerer Sturm", "orkanartiger Sturm", "Orkan"];
  let b = lim.findIndex((l) => kmh < l);
  if (b < 0) b = 12;
  return `${b} Bft · ${names[b]}`;
}
function uvText(uv) {
  if (uv === null || uv === undefined) return "";
  return uv < 3 ? "niedrig" : uv < 6 ? "mässig" : uv < 8 ? "hoch" : uv < 11 ? "sehr hoch" : "extrem";
}

function renderLive(d) {
  const c = d.current || {}, t = d.today, tr = d.trends;
  const rain = Object.fromEntries(d.rain.map((r) => [r.key, r]));
  $("#tNow").textContent = nf(c.temp_out, 1);
  setTrend($("#tTrend"), tr.temp_1h, "°C");
  $("#tFeels").textContent = nf(c.feels_like, 1) + "°";
  $("#tDew").textContent = nf(c.dewpoint, 1) + "°";
  $("#tMin").textContent = t.temp_min ? `${nf(t.temp_min.value, 1)}°` : "–";
  $("#tMax").textContent = t.temp_max ? `${nf(t.temp_max.value, 1)}°` : "–";
  $("#tMin").title = t.temp_min ? "um " + fmtTime(t.temp_min.t) : "";
  $("#tMax").title = t.temp_max ? "um " + fmtTime(t.temp_max.t) : "";

  $("#hNow").textContent = nf(c.hum_out, 0);
  $("#humArc").style.strokeDashoffset = 126 - 126 * Math.min(1, (c.hum_out || 0) / 100);
  $("#hTrend").textContent = tr.hum_1h === null ? "" : `${tr.hum_1h > 0 ? "+" : ""}${nf(tr.hum_1h, 0)} %/h`;
  $("#hMin").textContent = t.hum_min ? nf(t.hum_min.value, 0) : "–";
  $("#hMax").textContent = t.hum_max ? nf(t.hum_max.value, 0) : "–";

  $("#pNow").textContent = nf(c.pressure, 1);
  const p3 = tr.pressure_3h;
  $("#pTrend").innerHTML = p3 === null ? "–" :
    `<b>${p3 > 0 ? "+" : ""}${nf(p3, 1)} hPa</b> in 3 h · ${p3 > 3.6 ? "stark steigend ⇈" : p3 > 1.6 ? "steigend ↑" : p3 < -3.6 ? "stark fallend ⇊" : p3 < -1.6 ? "fallend ↓" : "stabil →"}`;

  $("#wNow").textContent = nf(c.wind_speed, 1);
  $("#wGust").textContent = nf(c.wind_gust, 1);
  $("#wGustMax").textContent = t.gust_max ? nf(t.gust_max.value, 1) : "–";
  $("#wBeaufort").textContent = c.wind_speed !== undefined && c.wind_speed !== null ? beaufort(c.wind_speed) : "";
  $("#wDirTxt").textContent = dirName(c.wind_dir);
  $("#windArrow").style.transform = `rotate(${(c.wind_dir || 0) + 180}deg)`; // Pfeil zeigt, wohin der Wind weht

  $("#rToday").textContent = nf(rain.today?.mm, 1);
  $("#rRate").textContent = nf(c.rain_rate, 1);
  $("#rRateMax").textContent = t.rain_rate_max ? nf(t.rain_rate_max.value, 1) : "–";
  $("#rYest").textContent = nf(rain.yesterday?.mm, 1);
  $("#rWeek").textContent = nf(rain.week?.mm, 1);

  $("#sNow").textContent = nf(c.solar, 0);
  $("#uvNow").textContent = nf(c.uv, 1);
  $("#uvTxt").textContent = uvText(c.uv);
  $("#uvMax").textContent = t.uv_max ? nf(t.uv_max.value, 1) : "–";
  $("#uvMarker").style.left = `calc(${Math.min(100, ((c.uv || 0) / 11) * 100)}% - 2px)`;

  $("#indoorCard").hidden = c.temp_in === undefined || c.temp_in === null;
  $("#solarCard").hidden = (c.solar === undefined || c.solar === null) && (c.uv === undefined || c.uv === null);
  $("#iTemp").textContent = nf(c.temp_in, 1);
  $("#iHum").textContent = nf(c.hum_in, 0);

  renderTank(rain, c);
}

function renderTank(rain, c) {
  const area = SETTINGS.roof_area, coef = SETTINGS.runoff_coefficient;
  $("#tankRoof").textContent = `· ${nf(area, area % 1 ? 1 : 0)} m² Dach${coef < 1 ? ` · Beiwert ${nf(coef, 2)}` : ""}`;
  $("#lToday").textContent = nf(rain.today?.liters, 0);
  $("#mmToday").textContent = `${nf(rain.today?.mm, 1)} mm Regen · 1 mm = ${nf(area * coef, 0)} L`;
  const list = ["yesterday", "week", "month", "year"].map((k) => rain[k]).filter(Boolean);
  const names = { yesterday: "Gestern", week: "Letzte 7 Tage", month: MONTHS_LONG[new Date().getMonth()], year: `Jahr ${new Date().getFullYear()}` };
  const max = Math.max(1, ...list.map((r) => r.liters));
  $("#tankList").innerHTML = list.map((r) =>
    `<li><div class="bar" style="width:${(r.liters / max) * 100}%"></div><span>${names[r.key]}<em>${nf(r.mm, 1)} mm</em></span><b>${nf(r.liters, 0)} L</b></li>`).join("");

  // Füllstand der Grafik: Zufluss heute im Verhältnis zum Tankvolumen (oder 1000 L)
  const cap = SETTINGS.tank_capacity > 0 ? SETTINGS.tank_capacity : 1000;
  const lvl = Math.min(1, (rain.today?.liters || 0) / cap);
  const shown = rain.today?.liters > 0 ? Math.max(0.04, lvl) : 0.015;
  $("#waterGroup").setAttribute("transform", `translate(0,${146 - 124 * shown})`);
  $("#tankSvg").querySelector("title")?.remove();
  $("#tankSvg").insertAdjacentHTML("afterbegin", `<title>Zufluss heute: ${nf(rain.today?.liters, 0)} L von ${nf(cap, 0)} L Skala</title>`);

  const raining = (c.rain_rate || 0) > 0 || (c.rain_mm || 0) > 0;
  const g = $("#rainDrops");
  if (raining && !g.childElementCount) {
    g.innerHTML = Array.from({ length: 9 }, (_, i) =>
      `<line x1="${22 + i * 10}" y1="-6" x2="${20 + i * 10}" y2="2" style="animation-delay:${(i * 0.37) % 1}s"/>`).join("");
  } else if (!raining) g.innerHTML = "";
}

async function load24h() {
  const now = Date.now();
  const [d, h] = await Promise.all([history(now - DAY, now + 60e3, "10min"), history(now - DAY, now + 60e3, "hour")]);
  const rows = d.rows, hr = h.rows;
  SPAN = spanFor("10min");
  const x = timeAxis("10min");
  x.min = now - DAY; x.max = now;

  chart("sparkTemp", {
    type: "line",
    data: { datasets: [line("Temperatur", rows, "temp_out", C.temp, { fill: "start", backgroundColor: alpha(C.temp, 0.12), borderWidth: 2 })] },
    options: { plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { ...x, display: false }, y: { display: false } }, animation: false },
  });
  chart("sparkPress", {
    type: "line",
    data: { datasets: [line("Luftdruck", rows, "pressure", C.press, { fill: "start", backgroundColor: alpha(C.press, 0.1) })] },
    options: { plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { ...x, display: false }, y: { display: false } }, animation: false },
  });
  chart("c24Temp", {
    type: "line",
    data: { datasets: [...band("Temperatur", rows, "temp_out", C.temp), line("Temperatur", rows, "temp_out", C.temp),
      line("Gefühlt", rows, "feels_like", C.feels, { borderDash: [4, 4], borderWidth: 1.5 }), line("Taupunkt", rows, "dewpoint", C.dew, { borderWidth: 1.5 })] },
    options: { plugins: { legend: legendNoBand }, scales: { x, y: { ticks: { callback: (v) => v + "°" } } } },
  });
  chart("c24Rain", {
    data: { datasets: [
      { type: "bar", label: "Regen [mm]", data: pts(hr, "rain_mm"), backgroundColor: alpha(C.rain, 0.75), borderRadius: 3, yAxisID: "y" },
      { type: "line", label: "Tank kumuliert [L]", data: cumulative(hr, "rain_l"), borderColor: C.tank, backgroundColor: alpha(C.tank, 0.1), fill: "start", stepped: true, yAxisID: "y2" },
    ] },
    options: { scales: { x: { ...timeAxis("hour"), min: now - DAY, max: now, offset: false }, y: { beginAtZero: true, title: { display: true, text: "mm/h" }, suggestedMax: 1 },
      y2: { position: "right", beginAtZero: true, grid: { display: false }, title: { display: true, text: "Liter" }, suggestedMax: 20 } } },
  });
  chart("c24Wind", {
    type: "line",
    data: { datasets: [line("Wind", rows, "wind_speed", C.wind, { fill: "start", backgroundColor: alpha(C.wind, 0.12) }),
      line("Böen max", rows, "wind_gust_max", C.gust, { borderWidth: 1.5 })] },
    options: { scales: { x, y: { beginAtZero: true, title: { display: true, text: "km/h" } } } },
  });
  chart("c24Press", {
    type: "line",
    data: { datasets: [line("Luftdruck [hPa]", rows, "pressure", C.press, { yAxisID: "y" }), line("Luftfeuchte [%]", rows, "hum_out", C.hum, { yAxisID: "y2", borderWidth: 1.5 })] },
    options: { scales: { x, y: { title: { display: true, text: "hPa" } }, y2: { position: "right", min: 0, max: 100, grid: { display: false }, title: { display: true, text: "%" } } } },
  });
}

async function loadRecords() {
  const r = await api("api/records");
  const items = [
    ["Höchste Temperatur", r.temp_max, (v) => nf(v, 1) + " °C", "warm"],
    ["Tiefste Temperatur", r.temp_min, (v) => nf(v, 1) + " °C", "cold"],
    ["Stärkste Böe", r.gust_max, (v) => nf(v, 1) + " km/h"],
    ["Nassester Tag", r.wettest_day, (v, x) => `${nf(v, 1)} mm · ${nf(x.liters, 0)} L`, "", true],
    ["Stärkster Regen", r.rain_rate_max, (v) => nf(v, 1) + " mm/h"],
    ["Höchster Luftdruck", r.pressure_max, (v) => nf(v, 1) + " hPa"],
    ["Tiefster Luftdruck", r.pressure_min, (v) => nf(v, 1) + " hPa"],
    ["Max. Sonnenstrahlung", r.solar_max, (v) => nf(v, 0) + " W/m²"],
  ];
  $("#records").innerHTML = items.filter((i) => i[1]).map(([l, x, f, cls, dateOnly]) =>
    `<div class="rec"><div class="d">${l}</div><div class="v ${cls || ""}">${f(x.value, x)}</div><div class="d">${dateOnly || x.date_only ? fmtDate(x.t) : fmtDateTime(x.t)}</div></div>`).join("");
}

let liveTimer = null;
function initLive() {
  clearInterval(liveTimer);
  refreshLatest().then(() => load24h()).catch(console.error);
  loadRecords().catch(console.error);
  liveTimer = setInterval(() => { if (!$("#tab-live").hidden) load24h().catch(console.error); }, 120e3);
}

// ====================================================================== Verlauf
const hist = { days: 7, from: null, to: null, bucket: "auto" };

function histRange() {
  if (hist.from && hist.to) return [hist.from, hist.to];
  const now = Date.now();
  if (hist.days === "all") return [INFO?.first || now - 365 * DAY, now + 60e3];
  return [now - hist.days * DAY, now + 60e3];
}

$("#histPresets").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  $$("#histPresets button").forEach((x) => x.classList.toggle("on", x === b));
  hist.days = b.dataset.days === "all" ? "all" : +b.dataset.days;
  hist.from = hist.to = null;
  loadHistory();
});
for (const id of ["#histFrom", "#histTo"]) {
  $(id).addEventListener("change", () => {
    if (!$("#histFrom").value || !$("#histTo").value) return;
    hist.from = new Date($("#histFrom").value + "T00:00").getTime();
    hist.to = new Date($("#histTo").value + "T00:00").getTime() + DAY;
    $$("#histPresets button").forEach((x) => x.classList.remove("on"));
    loadHistory();
  });
}
$("#histBucket").addEventListener("change", (e) => { hist.bucket = e.target.value; loadHistory(); });

async function loadHistory() {
  if (!INFO) INFO = await api("api/info");
  const [from, to] = histRange();
  $("#histFrom").value = isoDate(new Date(from));
  $("#histTo").value = isoDate(new Date(to - 1));
  const d = await history(from, to, hist.bucket);
  const rows = d.rows, bk = d.bucket;
  SPAN = spanFor(bk);
  const names = { raw: "Rohdaten", "10min": "10-Minuten-Werte", hour: "Stundenwerte", day: "Tageswerte", month: "Monatswerte", year: "Jahreswerte" };
  $("#histInfo").textContent = `${rows.length} ${names[bk]}`;
  const x = { ...timeAxis(bk), min: from, max: Math.min(to, Date.now()) };
  const gust = hasKey(rows, "wind_gust_max") ? "wind_gust_max" : "wind_gust";
  const windMax = hasKey(rows, "wind_speed_max") ? "wind_speed_max" : null;

  renderSummary(rows);
  chart("hTemp", {
    type: "line",
    data: { datasets: [...band("Temperatur", rows, "temp_out", C.temp), line("Temperatur", rows, "temp_out", C.temp),
      line("Taupunkt", rows, "dewpoint", C.dew, { borderWidth: 1.5 }), line("Gefühlt", rows, "feels_like", C.feels, { borderWidth: 1.2, borderDash: [4, 4], hidden: true })] },
    options: { plugins: { legend: legendNoBand }, scales: { x, y: { ticks: { callback: (v) => v + "°" } } } },
  });
  chart("hRain", {
    data: { datasets: [
      { type: "bar", label: "Regen [mm]", data: pts(rows, "rain_mm"), backgroundColor: alpha(C.rain, 0.8), borderRadius: 3, yAxisID: "y" },
      { type: "line", label: "Regentank kumuliert [L]", data: cumulative(rows, "rain_l"), borderColor: C.tank, backgroundColor: alpha(C.tank, 0.1), fill: "start", yAxisID: "y2", tension: 0 },
    ] },
    options: { plugins: { tooltip: { callbacks: { footer: (it) => {
      const r = rows[it[0].dataIndex]; return r ? `Zufluss in diesem Intervall: ${nf(r.rain_l, 0)} L` : ""; } } } },
    scales: { x, y: { beginAtZero: true, title: { display: true, text: "mm" } }, y2: { position: "right", beginAtZero: true, grid: { display: false }, title: { display: true, text: "Liter" } } } },
  });
  chart("hWind", {
    type: "line",
    data: { datasets: [line("Wind Mittel", rows, "wind_speed", C.wind, { fill: "start", backgroundColor: alpha(C.wind, 0.12) }),
      ...(windMax ? [line("Wind Max", rows, windMax, alpha(C.wind, 0.6), { borderWidth: 1, hidden: true })] : []),
      line("Böen", rows, gust, C.gust, { borderWidth: 1.5 })] },
    options: { scales: { x, y: { beginAtZero: true, title: { display: true, text: "km/h" } } } },
  });
  chart("hPress", {
    type: "line",
    data: { datasets: [...band("Luftdruck", rows, "pressure", C.press), line("Luftdruck", rows, "pressure", C.press)] },
    options: { plugins: { legend: { display: false } }, scales: { x, y: { title: { display: true, text: "hPa" } } } },
  });
  chart("hHum", {
    type: "line",
    data: { datasets: [...band("Luftfeuchte", rows, "hum_out", C.hum), line("Luftfeuchte", rows, "hum_out", C.hum)] },
    options: { plugins: { legend: { display: false } }, scales: { x, y: { min: 0, max: 100, title: { display: true, text: "%" } } } },
  });
  chart("hSolar", {
    type: "line",
    data: { datasets: [line(bk === "raw" ? "Strahlung" : "Strahlung Mittel", rows, "solar", C.solar, { fill: "start", backgroundColor: alpha(C.solar, 0.15) }),
      ...(hasKey(rows, "solar_max") ? [line("Strahlung Max", rows, "solar_max", alpha(C.solar, 0.6), { borderWidth: 1 })] : []),
      line("UV-Index", rows, hasKey(rows, "uv_max") ? "uv_max" : "uv", C.uv, { yAxisID: "y2", borderWidth: 1.5 })] },
    options: { scales: { x, y: { beginAtZero: true, title: { display: true, text: "W/m²" } }, y2: { position: "right", beginAtZero: true, grid: { display: false }, title: { display: true, text: "UV" } } } },
  });
  $("#hIndoor").closest(".card").hidden = !hasKey(rows, "temp_in");
  chart("hIndoor", {
    type: "line",
    data: { datasets: [line("Temperatur innen [°C]", rows, "temp_in", C.indoor), line("Luftfeuchte innen [%]", rows, "hum_in", C.hum, { yAxisID: "y2", borderWidth: 1.5 })] },
    options: { scales: { x, y: { title: { display: true, text: "°C" } }, y2: { position: "right", grid: { display: false }, title: { display: true, text: "%" } } } },
  });
  const rose = await api(`api/windrose?from=${Math.floor(from / 1000)}&to=${Math.floor(to / 1000)}`);
  renderRose(rose);
}

function stats(rows) {
  const w = (k) => {
    let s = 0, n = 0;
    for (const r of rows) if (r[k] !== undefined && r[k] !== null) { const c = r.n || 1; s += r[k] * c; n += c; }
    return n ? s / n : null;
  };
  const ext = (k, fn) => {
    const v = rows.map((r) => r[k + (fn === Math.max ? "_max" : "_min")] ?? r[k]).filter((v) => v !== undefined && v !== null);
    return v.length ? fn(...v) : null;
  };
  const gusts = rows.map((r) => r.wind_gust_max ?? r.wind_gust).filter((v) => v !== undefined && v !== null);
  return {
    tAvg: w("temp_out"), tMax: ext("temp_out", Math.max), tMin: ext("temp_out", Math.min),
    rain: hasRain(rows) ? sum(rows.map((r) => r.rain_mm)) : null,
    liters: hasRain(rows) ? sum(rows.map((r) => r.rain_l)) : null,
    gust: gusts.length ? Math.max(...gusts) : null, hum: w("hum_out"), press: w("pressure"), solar: w("solar"),
  };
}

function renderSummary(rows) {
  const s = stats(rows);
  const items = [["Ø Temperatur", nf(s.tAvg, 1), "°C"], ["Maximum", nf(s.tMax, 1), "°C"], ["Minimum", nf(s.tMin, 1), "°C"],
    ["Niederschlag", nf(s.rain, 1), "mm"], ["Regentank", nf(s.liters, 0), "L"], ["Stärkste Böe", nf(s.gust, 0), "km/h"], ["Ø Luftfeuchte", nf(s.hum, 0), "%"]];
  $("#histSummary").innerHTML = items.map(([l, v, u]) => `<div class="card"><div class="card-title">${l}</div><div class="val">${v}<small>${u}</small></div></div>`).join("");
}

function renderRose(r) {
  const R = 120, cx = 150, cy = 150;
  const colors = ["#bbf7d0", "#4ade80", "#22c55e", "#eab308", "#f97316", "#dc2626"];
  if (!r.total) { $("#rose").innerHTML = '<span class="muted">keine Winddaten</span>'; return; }
  const totals = r.counts.map((c) => sum(c));
  const max = Math.max(...totals) || 1;
  let svg = `<svg viewBox="0 0 300 330">`;
  for (const f of [0.25, 0.5, 0.75, 1]) svg += `<circle cx="${cx}" cy="${cy}" r="${R * f}" fill="none" stroke="currentColor" opacity=".12"/>`;
  svg += `<text x="${cx + 4}" y="${cy - R - 4}" style="text-anchor:start">${nf((max / r.total) * 100, 0)} %</text>`;
  r.counts.forEach((cls, i) => {
    let acc = 0;
    const a0 = ((i * 22.5 - 9 - 90) * Math.PI) / 180, a1 = ((i * 22.5 + 9 - 90) * Math.PI) / 180;
    cls.forEach((n, k) => {
      if (!n) return;
      const r0 = (acc / max) * R; acc += n; const r1 = (acc / max) * R;
      const p = (rad, a) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
      svg += `<path d="M${p(r0, a0)} L${p(r1, a0)} A${r1},${r1} 0 0 1 ${p(r1, a1)} L${p(r0, a1)} A${r0},${r0} 0 0 0 ${p(r0, a0)}Z" fill="${colors[k]}"><title>${DIRS[i]}: ${nf((n / r.total) * 100, 1)} % bei ${r.classes[k]}${r.classes[k + 1] ? "–" + r.classes[k + 1] : "+"} km/h</title></path>`;
    });
  });
  ["N", "O", "S", "W"].forEach((t, i) => {
    const a = ((i * 90 - 90) * Math.PI) / 180;
    svg += `<text x="${cx + (R + 14) * Math.cos(a)}" y="${cy + (R + 14) * Math.sin(a) + 4}" style="font-weight:700">${t}</text>`;
  });
  r.classes.forEach((c, k) => {
    svg += `<rect x="${12 + k * 47}" y="300" width="10" height="10" rx="2" fill="${colors[k]}"/><text x="${12 + k * 47 + 14}" y="309" style="text-anchor:start">${c}${r.classes[k + 1] ? "–" + r.classes[k + 1] : "+"}</text>`;
  });
  svg += `<text x="${cx}" y="326">km/h · Windstille ${nf((r.calm / r.total) * 100, 0)} %</text></svg>`;
  $("#rose").innerHTML = svg;
}

// ====================================================================== Vergleich
const cmp = { mode: "year", periods: { year: [], month: [], day: [] } };
const cmpCache = {};

function periodRange(mode, key) {
  if (mode === "year") return [new Date(+key, 0, 1), new Date(+key + 1, 0, 1)];
  if (mode === "month") { const [y, m] = key.split("-").map(Number); return [new Date(y, m - 1, 1), new Date(y, m, 1)]; }
  const [y, m, d] = key.split("-").map(Number);
  return [new Date(y, m - 1, d), new Date(y, m - 1, d + 1)];
}
function periodLabel(mode, key) {
  if (mode === "year") return key;
  if (mode === "month") { const [y, m] = key.split("-").map(Number); return `${MONTHS_LONG[m - 1]} ${y}`; }
  return fmtDate(periodRange(mode, key)[0]);
}
/* x-Position innerhalb des Zeitraums: Jahr = Monate (0–12), Monat = Tag (1–31), Tag = Stunde (0–24) */
function xPos(mode, t, end) {
  const d = new Date(t);
  if (mode === "year") {
    const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return d.getMonth() + (d.getDate() - 1 + (end ? 1 : 0.5)) / dim;
  }
  if (mode === "month") return d.getDate() + (end ? 0.5 : 0);
  return d.getHours() + d.getMinutes() / 60 + (end ? 1 : 0.5);
}

function defaultPeriods(mode) {
  const now = new Date();
  if (mode === "year") {
    const first = INFO?.first ? new Date(INFO.first).getFullYear() : now.getFullYear();
    const ys = []; for (let y = now.getFullYear(); y >= first && ys.length < 5; y--) ys.push(String(y));
    return ys.reverse();
  }
  if (mode === "month") {
    const m = `${pad(now.getMonth() + 1)}`;
    const out = [`${now.getFullYear() - 1}-${m}`, `${now.getFullYear()}-${m}`];
    return INFO?.first && new Date(INFO.first) > new Date(now.getFullYear() - 1, now.getMonth() + 1, 0) ? [out[1]] : out;
  }
  const y = new Date(now - DAY);
  return [isoDate(y), isoDate(now)];
}

function setupCmpPicker() {
  const inp = $("#cmpPick"), now = new Date();
  if (cmp.mode === "year") { inp.type = "number"; inp.min = 1990; inp.max = now.getFullYear(); inp.value = now.getFullYear() - 1; inp.style.width = "90px"; }
  else if (cmp.mode === "month") { inp.type = "month"; inp.value = `${now.getFullYear() - 1}-${pad(now.getMonth() + 1)}`; inp.style.width = ""; }
  else { inp.type = "date"; inp.value = isoDate(new Date(now - 7 * DAY)); inp.style.width = ""; }
}

$("#cmpMode").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  $$("#cmpMode button").forEach((x) => x.classList.toggle("on", x === b));
  cmp.mode = b.dataset.mode;
  loadCompare();
});
$("#cmpMetric").addEventListener("change", () => loadCompare());
$("#cmpAdd").addEventListener("click", () => {
  const v = $("#cmpPick").value; if (!v) return;
  const list = cmp.periods[cmp.mode];
  if (!list.includes(v)) { list.push(v); list.sort(); }
  loadCompare();
});
$("#cmpChips").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-k]"); if (!b) return;
  cmp.periods[cmp.mode] = cmp.periods[cmp.mode].filter((k) => k !== b.dataset.k);
  loadCompare();
});

async function cmpRows(mode, key, bucket) {
  const id = `${mode}|${key}|${bucket}`;
  const [a, b] = periodRange(mode, key);
  const fresh = b > Date.now() - 2 * DAY;
  if (!cmpCache[id] || fresh) cmpCache[id] = (await history(a.getTime(), b.getTime(), bucket)).rows;
  return cmpCache[id];
}

async function loadCompare() {
  if (!INFO) INFO = await api("api/info");
  setupCmpPicker();
  const mode = cmp.mode;
  if (!cmp.periods[mode].length) cmp.periods[mode] = defaultPeriods(mode);
  const keys = cmp.periods[mode];
  const metric = $("#cmpMetric").value, cum = metric.endsWith("_cum"), field = cum ? metric.replace("_cum", "") : metric;
  const isBar = !cum && (field === "rain_mm" || field === "rain_l");
  const fine = { year: "day", month: "day", day: "hour" }[mode];
  const chartBucket = mode === "year" && !cum ? "month" : fine;

  $("#cmpChips").innerHTML = keys.map((k, i) =>
    `<span class="chip"><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(periodLabel(mode, k))}<button data-k="${esc(k)}" title="entfernen">×</button></span>`).join("");

  const data = await Promise.all(keys.map(async (k) => ({ k, chart: await cmpRows(mode, k, chartBucket), fine: await cmpRows(mode, k, fine) })));
  const metricLabel = $("#cmpMetric").selectedOptions[0].textContent;
  $("#cmpTitle").textContent = `${metricLabel} – ${{ year: "nach Monat", month: "nach Tag", day: "nach Stunde" }[mode]}`;

  const datasets = data.map(({ k, chart: rows }, i) => {
    const col = PALETTE[i % PALETTE.length];
    let s = 0;
    const points = rows.filter((r) => r[field] !== undefined && r[field] !== null || cum).map((r) => ({
      x: isBar && mode === "year" ? new Date(r.t).getMonth() + 0.5 : xPos(mode, r.t, cum),
      y: cum ? (s += r[field] || 0) : r[field],
    }));
    if (cum && points.length) points.unshift({ x: mode === "month" ? 0.5 : 0, y: 0 });
    return isBar
      ? { type: "bar", label: periodLabel(mode, k), data: points, backgroundColor: alpha(col, 0.85), borderRadius: 3 }
      : { type: "line", label: periodLabel(mode, k), data: points, borderColor: col, backgroundColor: col, tension: cum ? 0.1 : 0.3, borderWidth: 2.2 };
  });

  const xs = {
    year: { min: 0, max: 12, ticks: [...Array(12)].map((_, i) => i + 0.5), label: (v) => MONTHS[Math.floor(v)] },
    month: { min: 0.5, max: 31.5, ticks: [...Array(31)].map((_, i) => i + 1), label: (v) => (v % 5 === 0 || v === 1 ? `${v}.` : "") },
    day: { min: 0, max: 24, ticks: [...Array(25)].map((_, i) => i), label: (v) => (v % 3 === 0 ? `${pad(v)}:00` : "") },
  }[mode];
  chart("cmpChart", {
    data: { datasets },
    options: {
      parsing: false, normalized: true,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      plugins: { tooltip: { callbacks: {
        title: (it) => { const v = it[0].parsed.x; return mode === "year" ? (cum ? `${MONTHS_LONG[Math.min(11, Math.floor(v))]}` : MONTHS_LONG[Math.floor(v)]) : mode === "month" ? `${Math.floor(v)}. Tag` : `${pad(Math.floor(v))}:00`; },
        label: (it) => `${it.dataset.label}: ${nf(it.parsed.y, field.startsWith("rain_l") ? 0 : 1)}`,
      } } },
      scales: {
        x: { type: "linear", min: xs.min, max: xs.max, offset: false, grid: { display: mode !== "year" },
          afterBuildTicks: (ax) => { ax.ticks = xs.ticks.map((value) => ({ value })); }, ticks: { autoSkip: false, maxRotation: 0, callback: xs.label } },
        y: { beginAtZero: isBar || cum || field.startsWith("wind") || field === "solar" },
      },
    },
  });

  // Tabelle
  const rowsHtml = data.map(({ k, fine: rows }, i) => {
    const s = stats(rows);
    const rainDays = mode === "day" || !hasRain(rows) ? null : rows.filter((r) => (r.rain_mm || 0) >= 1).length;
    return `<tr><td><i style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${PALETTE[i % PALETTE.length]};margin-right:8px"></i>${esc(periodLabel(mode, k))}</td>
      <td>${nf(s.tAvg, 1)}</td><td class="warm">${nf(s.tMax, 1)}</td><td class="cold">${nf(s.tMin, 1)}</td>
      <td>${nf(s.rain, 1)}</td><td><b>${nf(s.liters, 0)}</b></td><td>${rainDays === null ? "–" : rainDays}</td>
      <td>${nf(s.gust, 0)}</td><td>${nf(s.hum, 0)}</td><td>${nf(s.solar, 0)}</td></tr>`;
  }).join("");
  $("#cmpTable").innerHTML = `<thead><tr><th>Zeitraum</th><th>Ø Temp °C</th><th>Max °C</th><th>Min °C</th><th>Regen mm</th><th>Tank Liter</th><th>Regentage ≥1 mm</th><th>Böe max km/h</th><th>Ø Feuchte %</th><th>Ø Sonne W/m²</th></tr></thead><tbody>${rowsHtml}</tbody>`;
}

// ====================================================================== Regentank
let tankGran = "month";
$("#tankGran").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  $$("#tankGran button").forEach((x) => x.classList.toggle("on", x === b));
  tankGran = b.dataset.g;
  loadTank();
});

async function loadTank() {
  const [lat, info] = await Promise.all([api("api/latest"), api("api/info")]);
  INFO = info; SETTINGS = lat.settings;
  const area = SETTINGS.roof_area, coef = SETTINGS.runoff_coefficient, cap = SETTINGS.tank_capacity;
  $("#formulaText").innerHTML = `Liter = Niederschlag [mm] × <b>${nf(area, area % 1 ? 1 : 0)} m²</b> Dachfläche` +
    (coef < 1 ? ` × <b>${nf(coef, 2)}</b> Abflussbeiwert` : "") + `<br>→ jeder Millimeter Regen bringt <b>${nf(area * coef, 1)} Liter</b> in den Tank.` +
    `<br><span class="muted small">Dachfläche und Abflussbeiwert lassen sich unter Einstellungen ändern.</span>`;
  const names = { today: "Heute", yesterday: "Gestern", week: "Letzte 7 Tage", month: MONTHS_LONG[new Date().getMonth()], days30: "Letzte 30 Tage", year: `Jahr ${new Date().getFullYear()}`, all: "Seit Messbeginn" };
  $("#tankKpis").innerHTML = lat.rain.map((r) => `<div class="kpi"><div class="l">${names[r.key]}</div><div class="v">${nf(r.liters, 0)}<small> L</small></div>
    <div class="l">${nf(r.mm, 1)} mm${cap > 0 && r.liters > 0 ? ` · ${nf(r.liters / cap, 1)}× Tank` : ""}</div></div>`).join("");

  const now = Date.now();
  const first = info.first || now - 365 * DAY;
  let from, bucket;
  if (tankGran === "day") { from = new Date(new Date(now - 59 * DAY).toDateString()).getTime(); bucket = "day"; }
  else if (tankGran === "month") { const f = new Date(first); from = new Date(f.getFullYear(), f.getMonth(), 1).getTime(); bucket = "month"; }
  else { from = new Date(new Date(first).getFullYear(), 0, 1).getTime(); bucket = "year"; }
  const [d, daily, monthly] = await Promise.all([
    history(from, now + 60e3, bucket),
    history(new Date(new Date(first).getFullYear(), 0, 1).getTime(), now + 60e3, "day"),
    history(new Date(new Date(first).getFullYear(), new Date(first).getMonth(), 1).getTime(), now + 60e3, "month"),
  ]);
  $("#tankChartTitle").textContent = { day: "Zufluss pro Tag (letzte 60 Tage)", month: "Zufluss pro Monat", year: "Zufluss pro Jahr" }[tankGran];
  $("#tankInfo").textContent = `Gesamt im Diagramm: ${nf(sum(d.rows.map((r) => r.rain_l)), 0)} L`;
  const mmByT = Object.fromEntries(d.rows.map((r) => [r.t, r.rain_mm]));
  chart("tankChart", {
    type: "bar",
    data: { datasets: [{ label: "Regentank Zufluss [L]", data: pts(d.rows, "rain_l"), backgroundColor: alpha(C.tank, 0.85), hoverBackgroundColor: C.tank, borderRadius: 4 }] },
    options: {
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (it) => `${nf(it.parsed.y, 0)} Liter · ${nf(mmByT[it.raw.x], 1)} mm` } } },
      scales: { x: { ...timeAxis(bucket), offset: true }, y: { beginAtZero: true, title: { display: true, text: "Liter" }, ticks: { callback: (v) => nf(v, 0) } } },
    },
  });

  // Kumulierter Jahresverlauf
  const byYear = {};
  for (const r of daily.rows) if (r.rain_l !== undefined) (byYear[new Date(r.t).getFullYear()] ||= []).push(r);
  const years = Object.keys(byYear).sort();
  chart("tankCum", {
    type: "line",
    data: { datasets: years.map((y, i) => {
      let s = 0;
      const col = PALETTE[i % PALETTE.length];
      const data = [{ x: 0, y: 0 }, ...byYear[y].map((r) => ({ x: xPos("year", r.t, true), y: (s += r.rain_l || 0) }))];
      return { label: `${y} (${nf(s, 0)} L)`, data, borderColor: col, backgroundColor: col, tension: 0.1, borderWidth: y == new Date().getFullYear() ? 3 : 1.8 };
    }) },
    options: {
      parsing: false,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      plugins: { tooltip: { callbacks: { title: (it) => MONTHS_LONG[Math.min(11, Math.floor(it[0].parsed.x))], label: (it) => `${it.dataset.label.split(" ")[0]}: ${nf(it.parsed.y, 0)} L` } } },
      scales: {
        x: { type: "linear", min: 0, max: 12, grid: { display: false }, afterBuildTicks: (ax) => { ax.ticks = [...Array(12)].map((_, i) => ({ value: i + 0.5 })); },
          ticks: { autoSkip: false, maxRotation: 0, callback: (v) => MONTHS[Math.floor(v)] } },
        y: { beginAtZero: true, title: { display: true, text: "Liter" }, ticks: { callback: (v) => nf(v, 0) } },
      },
    },
  });

  // Monatstabelle (neueste zuerst)
  const mrows = [...monthly.rows].reverse();
  const maxL = Math.max(1, ...mrows.map((r) => r.rain_l || 0));
  $("#tankTable").innerHTML = `<thead><tr><th>Monat</th><th>Regen mm</th><th>Zufluss Liter</th><th style="width:40%"></th></tr></thead><tbody>` +
    mrows.map((r) => { const dt = new Date(r.t); return `<tr><td>${MONTHS_LONG[dt.getMonth()]} ${dt.getFullYear()}</td><td>${nf(r.rain_mm, 1)}</td><td><b>${nf(r.rain_l, 0)}</b></td>
      <td style="text-align:left"><span class="bar-cell" style="width:${((r.rain_l || 0) / maxL) * 100}%"></span></td></tr>`; }).join("") +
    `</tbody><tfoot><tr><td>Total</td><td>${nf(sum(mrows.map((r) => r.rain_mm)), 1)}</td><td>${nf(sum(mrows.map((r) => r.rain_l)), 0)}</td><td></td></tr></tfoot>`;
}

// ====================================================================== Daten
async function loadData() {
  const info = (INFO = await api("api/info"));
  const mb = (info.size_bytes / 1048576).toFixed(1);
  $("#dbInfo").innerHTML = `<dt>Datei</dt><dd>${esc(info.file)}</dd><dt>Messungen</dt><dd>${nf(info.count, 0)}</dd>
    <dt>Erste Messung</dt><dd>${info.first ? fmtDateTime(info.first) : "–"}</dd><dt>Letzte Messung</dt><dd>${info.last ? fmtDateTime(info.last) : "–"}</dd>
    <dt>Grösse</dt><dd>${mb} MB</dd><dt>Abfrage</dt><dd>${info.static ? "alle 5 min durch GitHub Actions" : `alle ${info.settings.poll_interval} s`}${info.demo ? " (Demo)" : ""}</dd>`;
  if (!$("#exFrom").value) {
    $("#exFrom").value = isoDate(new Date(info.first || Date.now() - 30 * DAY));
    $("#exTo").value = isoDate(new Date());
  }
}
$("#exportForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const from = new Date(f.get("from") + "T00:00").getTime() / 1000;
  const to = new Date(f.get("to") + "T00:00").getTime() / 1000 + 86400;
  if (STATIC_MODE) return StaticBackend.exportTable(f.get("format"), f.get("bucket"), from, to);
  location.href = `api/export?format=${f.get("format")}&bucket=${f.get("bucket")}&from=${from}&to=${to}`;
});
$("#dlSqlite").addEventListener("click", async (e) => {
  if (!STATIC_MODE) return;
  e.preventDefault();
  const a = e.currentTarget, txt = a.textContent;
  a.textContent = "Datenbank wird erstellt …";
  try { await StaticBackend.exportSqlite(); } catch (err) { alert("Fehler: " + err.message); }
  a.textContent = txt;
});

// ====================================================================== Einstellungen
async function loadSettings() {
  const info = await api("api/info");
  const s = info.settings, form = $("#settingsForm");
  for (const [k, v] of Object.entries(s)) if (form.elements[k]) form.elements[k].value = v;
  if (info.static) {
    $("#sourceInfo").innerHTML = `<dt>Station</dt><dd><a href="${esc(s.source_url)}" target="_blank" rel="noopener">${esc(s.source_url || "–")}</a></dd>
      <dt>Letzte Messung</dt><dd>${info.last ? fmtDateTime(info.last) : "–"}</dd>
      <dt>Messungen</dt><dd>${nf(info.count, 0)}</dd>
      ${info.status.last_error ? `<dt>Letzter Fehler</dt><dd class="msg err">${esc(info.status.last_error)}</dd>` : ""}`;
  }
}
$("#settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const msg = $("#settingsMsg");
  try {
    const r = await api("api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    SETTINGS = r.settings;
    msg.className = "msg ok"; msg.textContent = "Gespeichert ✓";
    Object.keys(loaded).forEach((k) => { if (k !== "settings") loaded[k] = false; });
    refreshLatest();
  } catch (err) { msg.className = "msg err"; msg.textContent = err.message; }
});
$("#testSource").addEventListener("click", async () => {
  const f = $("#settingsForm").elements, out = $("#testResult");
  out.innerHTML = "Rufe Daten ab …";
  const r = await api(`api/test-source?url=${encodeURIComponent(f.source_url.value)}&adapter=${f.adapter.value}`);
  if (!r.ok) { out.innerHTML = `<span class="msg err">Fehler: ${esc(r.error)}</span>`; return; }
  const L = { temp_out: "Temperatur aussen", hum_out: "Luftfeuchte aussen", dewpoint: "Taupunkt", feels_like: "Gefühlt", temp_in: "Temperatur innen",
    hum_in: "Luftfeuchte innen", pressure: "Luftdruck", wind_speed: "Wind", wind_gust: "Böen", wind_dir: "Windrichtung", rain_rate: "Regenrate",
    rain_day: "Regen heute (Zähler)", rain_total: "Regen gesamt (Zähler)", solar: "Sonnenstrahlung", uv: "UV-Index" };
  const U = { temp_out: "°C", dewpoint: "°C", feels_like: "°C", temp_in: "°C", hum_out: "%", hum_in: "%", pressure: "hPa", wind_speed: "km/h",
    wind_gust: "km/h", wind_dir: "°", rain_rate: "mm/h", rain_day: "mm", rain_total: "mm", solar: "W/m²", uv: "" };
  out.innerHTML = `<p class="msg ok">Verbindung ok – erkannte Werte:</p><table class="tbl">` +
    Object.entries(r.values).map(([k, v]) => `<tr><td>${L[k] || k}</td><td>${nf(v, 1)} ${U[k] || ""}</td></tr>`).join("") + "</table>";
});

// ====================================================================== Start
(async () => {
  await detectMode();
  try { INFO = await api("api/info"); } catch (e) { /* Status zeigt den Fehler */ }
  showTab(location.hash.slice(1) || "live");
  if (location.hash && location.hash !== "#live") refreshLatest();
  setInterval(refreshLatest, 30e3);
  // Kompass-Teilstriche
  $("#compassTicks").innerHTML = [...Array(36)].map((_, i) => {
    const a = (i * 10 * Math.PI) / 180, r1 = i % 9 === 0 ? 36 : 40;
    return `<line x1="${50 + r1 * Math.sin(a)}" y1="${50 - r1 * Math.cos(a)}" x2="${50 + 44 * Math.sin(a)}" y2="${50 - 44 * Math.cos(a)}"/>`;
  }).join("");
  if (STATIC_MODE) $("#footStore").textContent = "Daten gesammelt von GitHub Actions";
  $("#footInfo").textContent = INFO ? `${nf(INFO.count, 0)} Messungen seit ${INFO.first ? fmtDate(INFO.first) : "–"}` : "";
})();
