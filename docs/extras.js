/* Wetterstation – Live-Bild vom Haus, Wind-Kompass und Prognose */
"use strict";

const DEFAULT_LAT = 46.8, DEFAULT_LON = 8.2;  // Schweiz, nur für den Sonnenstand solange kein Standort gesetzt ist

// ====================================================================== Sonnenstand
function sunElevation(ms, lat, lon) {
  const rad = Math.PI / 180, d = ms / 86400000 - 10957.5;  // Tage seit J2000
  const g = (357.529 + 0.98560028 * d) * rad;
  const L = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const h = (gmst * 15 + lon) * rad - ra;
  return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(h)) / rad;
}

// ====================================================================== Wetterlage aus den Messwerten
function weatherState(c, s, recentRain) {
  const lat = +s.latitude || DEFAULT_LAT, lon = +s.longitude || DEFAULT_LON;
  const t = c.ts ? c.ts * 1000 : Date.now();
  const elev = sunElevation(t, lat, lon);
  const night = elev < -4, dusk = !night && elev < 4;
  const raining = (c.rain_rate || 0) > 0 || recentRain > 0;
  const snow = raining && c.temp_out !== undefined && c.temp_out <= 1;
  const fog = (c.hum_out || 0) >= 97 && c.dewpoint !== undefined && c.temp_out - c.dewpoint < 0.8;
  // Bewölkung: gemessene Strahlung im Vergleich zum klaren Himmel (nur tagsüber aussagekräftig)
  let cloud = null;
  if (c.solar !== undefined && elev > 8) {
    const clear = 1000 * Math.pow(Math.sin(elev * Math.PI / 180), 1.15) * 0.92;
    cloud = Math.max(0, Math.min(1, 1 - c.solar / clear));
  }
  if (raining) cloud = Math.max(cloud ?? 0, 0.85);
  const rate = c.rain_rate || (recentRain > 0 ? 1 : 0);
  let text;
  if (snow) text = rate > 2 ? "Starker Schneefall" : "Schneefall";
  else if (raining) text = rate >= 8 ? "Starker Regen" : rate >= 2 ? "Regen" : "Leichter Regen";
  else if (fog) text = "Nebel";
  else if (night) text = "Nacht";
  else if (cloud === null) text = dusk ? "Dämmerung" : "–";
  else text = cloud < 0.2 ? "Sonnig" : cloud < 0.5 ? "Leicht bewölkt" : cloud < 0.8 ? "Bewölkt" : "Bedeckt";
  if (night && !raining && !fog) text = "Nacht";
  if ((c.wind_gust || 0) >= 60) text += " · stürmisch";
  else if ((c.wind_speed || 0) >= 25) text += " · windig";
  if (c.temp_out !== undefined && c.temp_out < 0 && !snow) text += " · Frost";
  return { elev, night, dusk, raining, snow, fog, cloud, rate, text, frost: (c.temp_out ?? 5) < 0 };
}

// ====================================================================== Live-Bild
const scene = { st: null, c: {}, parts: [], raf: null, last: 0 };

function renderScene(c, s, recentRain) {
  const st = weatherState(c, s, recentRain);
  scene.st = st; scene.c = c;
  const card = document.getElementById("sceneCard");
  if (!card) return;
  const dark = st.night ? 0.62 : st.dusk ? 0.35 : 0;
  const grey = st.cloud === null ? 0 : st.cloud;
  const img = document.getElementById("sceneImg");
  img.style.filter = `brightness(${(1 - dark) * (1 - grey * 0.25)}) saturate(${1 - grey * 0.55 - (st.fog ? 0.3 : 0)})` +
    (st.frost ? " hue-rotate(-8deg)" : "") + (st.night ? " contrast(1.05)" : "");
  card.classList.toggle("night", st.night);
  card.classList.toggle("fog", st.fog);
  card.classList.toggle("frost", st.frost);
  card.style.setProperty("--cloud", grey.toFixed(2));
  document.getElementById("sceneCond").textContent = st.text;
  document.getElementById("sceneTemp").textContent = nf(c.temp_out, 1) + "°";
  const sub = [];
  if (c.hum_out !== undefined) sub.push(`${nf(c.hum_out, 0)} %`);
  if (c.wind_speed !== undefined) sub.push(`Wind ${nf(c.wind_speed, 0)} km/h ${dirName(c.wind_dir)}`);
  if (st.raining) sub.push(`${nf(c.rain_rate, 1)} mm/h`);
  document.getElementById("sceneSub").textContent = sub.join(" · ");
  initParticles();
  if (!scene.raf) scene.raf = requestAnimationFrame(drawScene);
}

function initParticles() {
  const cv = document.getElementById("sceneFx"), st = scene.st;
  if (!cv || !st) return;
  const w = cv.clientWidth, h = cv.clientHeight;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let n = 0, kind = null;
  if (st.snow) { kind = "snow"; n = Math.round(60 + Math.min(st.rate, 5) * 30); }
  else if (st.raining) { kind = "rain"; n = Math.round(70 + Math.min(st.rate, 15) * 25); }
  else if (st.night && (st.cloud ?? 0) < 0.6 && !st.fog) { kind = "star"; n = 70; }
  else if ((scene.c.wind_speed || 0) > 8 && !st.night) { kind = "leaf"; n = Math.round(Math.min(scene.c.wind_speed, 50) / 2); }
  if (reduce && kind !== "star") n = Math.round(n / 3);
  if (scene.parts.kind === kind && scene.parts.length === n) return;
  const r = Math.random;
  scene.parts = Array.from({ length: n }, () => ({ x: r() * w, y: r() * h, z: 0.4 + r() * 0.6, p: r() * 6.28 }));
  scene.parts.kind = kind;
}

function drawScene(now) {
  scene.raf = requestAnimationFrame(drawScene);
  const cv = document.getElementById("sceneFx");
  if (!cv || document.getElementById("tab-live").hidden) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); initParticles(); }
  const dt = Math.min(0.05, (now - (scene.last || now)) / 1000);
  scene.last = now;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const st = scene.st, c = scene.c;
  if (!st) return;
  // Windrichtung: Wind aus Westen (270°) treibt nach rechts
  const dir = ((c.wind_dir ?? 270) * Math.PI) / 180;
  const wx = -Math.sin(dir) * Math.min(c.wind_speed || 0, 60) * 4;
  const kind = scene.parts.kind;
  for (const p of scene.parts) {
    if (kind === "rain") {
      p.y += (650 + 250 * p.z) * dt; p.x += wx * dt;
      ctx.strokeStyle = `rgba(200,225,255,${0.25 + 0.4 * p.z})`;
      ctx.lineWidth = 1 + p.z;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - wx * 0.02, p.y - 14 * p.z); ctx.stroke();
    } else if (kind === "snow") {
      p.p += dt; p.y += (35 + 40 * p.z) * dt; p.x += (wx * 0.5 + Math.sin(p.p) * 12) * dt;
      ctx.fillStyle = `rgba(255,255,255,${0.5 + 0.5 * p.z})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.2 + 2.2 * p.z, 0, 6.28); ctx.fill();
    } else if (kind === "star") {
      if (p.y > h * 0.45) continue;
      const a = 0.35 + 0.35 * Math.sin(now / 900 + p.p * 7);
      ctx.fillStyle = `rgba(255,255,240,${a * (1 - (st.cloud ?? 0))})`;
      ctx.fillRect(p.x, p.y, 1.5 * p.z, 1.5 * p.z);
      continue;
    } else if (kind === "leaf") {
      p.p += dt * 3; p.x += (wx * 0.9 + 15) * dt * p.z; p.y += (25 + Math.sin(p.p) * 30) * dt;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.p);
      ctx.fillStyle = `hsla(${25 + p.z * 20},85%,${45 + p.z * 10}%,0.9)`;
      ctx.beginPath(); ctx.ellipse(0, 0, 4 * p.z + 2, 2 * p.z + 1, 0, 0, 6.28); ctx.fill(); ctx.restore();
    }
    if (p.y > h + 20) { p.y = -20; p.x = Math.random() * w; }
    if (p.x > w + 30) p.x = -30; else if (p.x < -30) p.x = w + 30;
  }
}

// ====================================================================== Wind-Kompass
function renderWindCompass(c, trail, gustMax) {
  const box = document.getElementById("windCompass");
  if (!box) return;
  const R = 130, cx = 150, cy = 150, rad = (d) => ((d - 90) * Math.PI) / 180;
  const P = (r, d) => `${(cx + r * Math.cos(rad(d))).toFixed(1)},${(cy + r * Math.sin(rad(d))).toFixed(1)}`;
  let svg = `<svg viewBox="0 0 300 300" role="img" aria-label="Wind aus ${dirName(c.wind_dir)}, ${nf(c.wind_speed, 1)} km/h">`;
  svg += `<circle cx="${cx}" cy="${cy}" r="${R + 8}" class="wc-bg"/><circle cx="${cx}" cy="${cy}" r="${R - 26}" class="wc-inner"/>`;
  for (let d = 0; d < 360; d += 5) {
    const major = d % 30 === 0, inner = R - (major ? 14 : d % 10 === 0 ? 9 : 5);
    const [x1, y1] = P(R, d).split(","), [x2, y2] = P(inner, d).split(",");
    svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="wc-tick${major ? " major" : ""}"/>`;
  }
  const names = { 0: "N", 45: "NO", 90: "O", 135: "SO", 180: "S", 225: "SW", 270: "W", 315: "NW" };
  for (const [d, n] of Object.entries(names)) {
    const [x, y] = P(R - 27, +d).split(",");
    svg += `<text x="${x}" y="${+y + 4}" class="wc-label${n.length === 1 ? " card" : ""}">${n}</text>`;
  }
  // Spur der letzten Stunde (älter = blasser)
  trail.forEach((d, i) => {
    const [x, y] = P(R + 1, d).split(",");
    svg += `<circle cx="${x}" cy="${y}" r="4" class="wc-trail" style="opacity:${(0.15 + 0.6 * (i + 1) / trail.length).toFixed(2)}"/>`;
  });
  if (c.wind_dir !== undefined && c.wind_dir !== null) {
    const d = c.wind_dir;
    // Marker am Rand: woher der Wind kommt; Pfeil durch die Mitte: wohin er weht
    svg += `<g class="wc-arrow" style="transform:rotate(${d}deg)">
      <path d="M${cx} ${cy - R - 6} l-11 -0 l11 26 l11 -26 z" class="wc-from"/>
      <path d="M${cx} ${cy - R + 34} L${cx} ${cy + R - 40}" class="wc-shaft"/>
      <path d="M${cx} ${cy + R - 26} l-10 -18 l10 5 l10 -5 z" class="wc-head"/></g>`;
  }
  svg += `<circle cx="${cx}" cy="${cy}" r="52" class="wc-center"/>
    <text x="${cx}" y="${cy - 2}" class="wc-speed">${nf(c.wind_speed, 1)}</text>
    <text x="${cx}" y="${cy + 17}" class="wc-unit">km/h</text>
    <text x="${cx}" y="${cy + 34}" class="wc-gust">Böen ${nf(c.wind_gust, 0)}</text></svg>`;
  box.innerHTML = svg;
  document.getElementById("wcFrom").textContent = c.wind_dir === undefined ? "–" : `aus ${dirName(c.wind_dir)} (${nf(c.wind_dir, 0)}°)`;
  document.getElementById("wcBft").textContent = c.wind_speed === undefined ? "" : beaufort(c.wind_speed);
  document.getElementById("wcGustMax").textContent = gustMax ? `${nf(gustMax.value, 1)} km/h um ${fmtTime(gustMax.t)}` : "–";
}

// ====================================================================== Prognose (MeteoSchweiz-Modell ICON-CH über Open-Meteo)
const WMO = {
  0: ["Klar", "☀️", "🌙"], 1: ["Überwiegend klar", "🌤️", "🌙"], 2: ["Teilweise bewölkt", "⛅", "☁️"], 3: ["Bedeckt", "☁️", "☁️"],
  45: ["Nebel", "🌫️"], 48: ["Reifnebel", "🌫️"], 51: ["Leichter Niesel", "🌦️", "🌧️"], 53: ["Niesel", "🌦️", "🌧️"], 55: ["Starker Niesel", "🌧️"],
  56: ["Gefrierender Niesel", "🌧️"], 57: ["Gefrierender Niesel", "🌧️"], 61: ["Leichter Regen", "🌦️", "🌧️"], 63: ["Regen", "🌧️"],
  65: ["Starker Regen", "🌧️"], 66: ["Gefrierender Regen", "🌧️"], 67: ["Gefrierender Regen", "🌧️"], 71: ["Leichter Schneefall", "🌨️"],
  73: ["Schneefall", "🌨️"], 75: ["Starker Schneefall", "❄️"], 77: ["Schneegriesel", "🌨️"], 80: ["Regenschauer", "🌦️", "🌧️"],
  81: ["Regenschauer", "🌧️"], 82: ["Heftige Schauer", "⛈️"], 85: ["Schneeschauer", "🌨️"], 86: ["Schneeschauer", "❄️"],
  95: ["Gewitter", "⛈️"], 96: ["Gewitter mit Hagel", "⛈️"], 99: ["Gewitter mit Hagel", "⛈️"],
};
const wmo = (code, night) => { const w = WMO[code] || ["–", "·"]; return { text: w[0], icon: night && w[2] ? w[2] : w[1] }; };
const DAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
let forecastAt = 0;

async function loadForecast(s, force) {
  const card = document.getElementById("forecastCard");
  if (!card) return;
  const lat = +s.latitude, lon = +s.longitude;
  if (!lat || !lon) {
    card.querySelector(".fc-body").innerHTML = `<p class="muted">Für die Prognose fehlt der Standort. Trage in <code>config.json</code> <code>latitude</code> und <code>longitude</code> ein.</p>`;
    return;
  }
  if (!force && Date.now() - forecastAt < 30 * 60e3) return;
  const elev = +s.elevation ? `&elevation=${+s.elevation}` : "";  // Höhe des Hauses statt Geländemodell
  const base = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}${elev}` +
    "&hourly=temperature_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_gusts_10m_max" +
    "&timezone=Europe%2FZurich&forecast_days=5";
  let data = null, model = "MeteoSchweiz ICON-CH2";
  for (const [url, name] of [[base + "&models=meteoswiss_icon_ch2", "MeteoSchweiz ICON-CH2"], [base, "Open-Meteo (bestes Modell)"]]) {
    try {
      const r = await fetch(url);
      if (r.ok) { data = await r.json(); model = name; break; }
    } catch (e) { /* nächster Versuch */ }
  }
  if (!data || !data.hourly) {
    card.querySelector(".fc-body").innerHTML = `<p class="muted">Prognose zurzeit nicht erreichbar.</p>`;
    return;
  }
  forecastAt = Date.now();
  renderForecast(data, model, s, lat, lon);
}

function renderForecast(data, model, s, lat, lon) {
  const H = data.hourly, D = data.daily, now = Date.now();
  const k = s.roof_area * s.runoff_coefficient;
  const times = H.time.map((t) => new Date(t).getTime());
  const start = times.findIndex((t) => t >= now - 3600e3);
  // nächste 24 h im 3-Stunden-Takt
  let hours = "";
  for (let i = Math.max(0, start); i < Math.min(times.length, start + 24); i += 3) {
    const night = sunElevation(times[i], lat, lon) < -4;
    const w = wmo(H.weather_code[i], night);
    const rain = H.precipitation.slice(i, i + 3).reduce((a, b) => a + (b || 0), 0);
    hours += `<div class="fc-h"><div class="muted">${pad(new Date(times[i]).getHours())} h</div><div class="fc-icon" title="${w.text}">${w.icon}</div>
      <b>${nf(H.temperature_2m[i], 0)}°</b><div class="fc-rain">${rain >= 0.1 ? nf(rain, 1) + " mm" : ""}</div></div>`;
  }
  const next24 = H.precipitation.slice(Math.max(0, start), start + 24).reduce((a, b) => a + (b || 0), 0);
  let days = "";
  for (let i = 0; i < D.time.length; i++) {
    const d = new Date(D.time[i] + "T12:00"), w = wmo(D.weather_code[i], false);
    const mm = D.precipitation_sum[i] || 0;
    days += `<div class="fc-d"><b class="fc-day">${i === 0 ? "Heute" : DAYS[d.getDay()]}</b><span class="fc-icon" title="${w.text}">${w.icon}</span>
      <span class="cold">${nf(D.temperature_2m_min[i], 0)}°</span><span class="fc-bar"><i style="--a:${(D.temperature_2m_min[i] + 10) / 45};--b:${(D.temperature_2m_max[i] + 10) / 45}"></i></span>
      <span class="warm">${nf(D.temperature_2m_max[i], 0)}°</span>
      <span class="fc-mm">${mm >= 0.1 ? `${nf(mm, 1)} mm · <b>${nf(mm * k, 0)} L</b>` : "trocken"}</span></div>`;
  }
  const total = D.precipitation_sum.reduce((a, b) => a + (b || 0), 0);
  document.querySelector("#forecastCard .fc-body").innerHTML =
    `<div class="fc-hours">${hours}</div>
     <div class="fc-tank">Erwarteter Zufluss in den Regentank: <b>${nf(next24 * k, 0)} L</b> in 24 h · <b>${nf(total * k, 0)} L</b> in 5 Tagen</div>
     <div class="fc-days">${days}</div>
     <p class="muted small">Modell: ${model}, via Open-Meteo · <a href="https://www.meteoschweiz.admin.ch/lokalprognose" target="_blank" rel="noopener">Lokalprognose bei MeteoSchweiz</a></p>`;
}
