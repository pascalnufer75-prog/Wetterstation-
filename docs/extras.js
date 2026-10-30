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
let FC = { nowCode: null, dayMax: null, nightMin: null };  // aus der Prognose (für Nächte und die Tageszeile)

function weatherState(c, s, recentRain) {
  const lat = +s.latitude || DEFAULT_LAT, lon = +s.longitude || DEFAULT_LON;
  const t = c.ts ? c.ts * 1000 : Date.now();
  const elev = sunElevation(t, lat, lon);
  const night = elev < -4, dusk = !night && elev < 4;
  const raining = (c.rain_rate || 0) > 0 || recentRain > 0;
  const snow = raining && c.temp_out !== undefined && c.temp_out <= 1;
  let fog = (c.hum_out || 0) >= 97 && c.dewpoint !== undefined && c.temp_out - c.dewpoint < 0.8;
  // Bewölkung: gemessene Strahlung im Vergleich zum klaren Himmel (nur tagsüber aussagekräftig),
  // nachts aus dem Wettercode der Prognose für die aktuelle Stunde
  let cloud = null;
  if (c.solar !== undefined && elev > 8) {
    const clear = 1000 * Math.pow(Math.sin(elev * Math.PI / 180), 1.15) * 0.92;
    cloud = Math.max(0, Math.min(1, 1 - c.solar / clear));
  } else if (FC.nowCode !== null) {
    const k = FC.nowCode;
    cloud = k <= 1 ? 0.1 : k === 2 ? 0.5 : k === 3 ? 0.9 : k === 45 || k === 48 ? 0.8 : 0.85;
    if ((k === 45 || k === 48) && (c.hum_out || 0) >= 94) fog = true;
  }
  if (raining) cloud = Math.max(cloud ?? 0, 0.85);
  const rate = c.rain_rate || (recentRain > 0 ? 1 : 0);
  let phrase = null;
  if (snow) phrase = rate > 2 ? "es schneit stark" : "es schneit";
  else if (raining) phrase = rate >= 8 ? "es regnet stark" : rate >= 2 ? "es regnet" : "es regnet leicht";
  else if (fog) phrase = "neblig";
  else if (cloud !== null) phrase = cloud < 0.2 ? (night ? "klar" : "sonnig") : cloud < 0.5 ? "leicht bewölkt" : cloud < 0.8 ? "bewölkt" : "bedeckt";
  const notes = [];
  if ((c.wind_gust || 0) >= 60) notes.push("stürmisch");
  else if ((c.wind_speed || 0) >= 25) notes.push("windig");
  if (c.temp_out !== undefined && c.temp_out < 0 && !snow) notes.push("Frost");
  const text = phrase ? phrase[0].toUpperCase() + phrase.slice(1) : night ? "Nacht" : "–";
  return { elev, night, dusk, raining, snow, fog, cloud, rate, phrase, notes, text, frost: (c.temp_out ?? 5) < 0 };
}

// ====================================================================== Illustration des Hauses
const scene = { st: null, c: {}, parts: [], raf: null, last: 0, built: false };

// Illustration (1448×1086): Umriss des Himmels über den Baumkronen und Lage der Fenster
const ART_W = 1448, ART_H = 1086;
const SKY_EDGE = [[320, 56], [360, 87], [400, 99], [440, 79], [480, 13], [520, 53], [560, 104], [600, 160], [640, 106], [680, 103], [720, 119],
  [760, 179], [800, 240], [840, 251], [880, 342], [920, 314], [960, 389], [1000, 291], [1040, 257], [1080, 256], [1120, 286], [1160, 342],
  [1200, 373], [1240, 473], [1280, 409], [1320, 475], [1360, 494], [1400, 470], [1448, 550]];
const WINDOWS = [[108, 667, 70, 106], [600, 670, 66, 106], [958, 728, 36, 78]];   // x, y, Breite, Höhe der Scheiben
const HOUSE_CX = 600, HOUSE_CY = 640;                                                // Bildausschnitt auf das Haus zentrieren

function buildHouseArt() {
  const svg = document.getElementById("houseArt");
  if (!svg) return;
  const skyPts = ["0,0", `${ART_W},0`, ...SKY_EDGE.slice().reverse().map(([x, y]) => `${x},${Math.max(0, y - 14)}`), "300,0"].join(" ");
  const r = Math.random, stars = Array.from({ length: 110 }, () =>
    `<circle cx="${(300 + r() * 1148).toFixed(0)}" cy="${(r() * 520).toFixed(0)}" r="${(0.8 + r() * 1.6).toFixed(1)}" style="animation-delay:${(r() * 4).toFixed(1)}s"/>`).join("");
  svg.setAttribute("viewBox", `0 0 ${ART_W} ${ART_H}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
  svg.innerHTML = `
  <defs>
    <clipPath id="skyClip"><polygon points="${skyPts}"/></clipPath>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop id="skyA" offset="0" stop-color="#2d7dd2"/><stop id="skyB" offset="1" stop-color="#b5dcf7"/></linearGradient>
    <linearGradient id="fogG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e6e9ec" stop-opacity=".4"/><stop offset=".75" stop-color="#e6e9ec" stop-opacity=".93"/></linearGradient>
    <linearGradient id="snowG" x1="0" y1="0" x2="0" y2="1"><stop offset=".7" stop-color="#f6f9fc" stop-opacity="0"/><stop offset=".84" stop-color="#f6f9fc" stop-opacity=".8"/><stop offset="1" stop-color="#f6f9fc" stop-opacity=".95"/></linearGradient>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="blur"><feGaussianBlur stdDeviation="18"/></filter>
    <filter id="dim"><feColorMatrix id="satM" type="saturate" values="1"/></filter>
  </defs>
  <image id="artImg" href="haus-illu.jpg" width="${ART_W}" height="${ART_H}" preserveAspectRatio="none" filter="url(#dim)"/>
  <rect id="dark" width="${ART_W}" height="${ART_H}" fill="#000" opacity="0"/>
  <rect id="skyTint" width="${ART_W}" height="620" fill="url(#sky)" opacity="0" clip-path="url(#skyClip)"/>
  <g id="clouds" class="clouds" opacity="0" filter="url(#blur)">
    <ellipse cx="560" cy="120" rx="260" ry="70"/><ellipse cx="980" cy="70" rx="320" ry="80"/><ellipse cx="1300" cy="200" rx="260" ry="70"/>
    <ellipse cx="760" cy="250" rx="220" ry="55"/><ellipse cx="220" cy="80" rx="240" ry="70"/></g>
  <rect id="snowCover" width="${ART_W}" height="${ART_H}" fill="url(#snowG)" opacity="0"/>
  <rect id="tint" width="${ART_W}" height="${ART_H}" fill="#ff9d55" opacity="0"/>
  <rect id="shade" width="${ART_W}" height="${ART_H}" fill="#081230" opacity="0"/>
  <g id="winGlow" opacity="0" filter="url(#glow)">${WINDOWS.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#ffc96a"/>`).join("")}</g>
  <g id="stars" opacity="0" clip-path="url(#skyClip)">${stars}</g>
  <rect id="fog" width="${ART_W}" height="${ART_H}" fill="url(#fogG)" opacity="0"/>`;
  scene.built = true;
  fitHouseArt();
  window.addEventListener("resize", fitHouseArt);
}

/* Bildausschnitt so wählen, dass das Haus im Bild bleibt (statt starr die Bildmitte) */
function fitHouseArt() {
  const svg = document.getElementById("houseArt");
  if (!svg || !svg.clientWidth) return;
  const aspect = svg.clientWidth / svg.clientHeight;
  let w = ART_W, h = ART_H, x = 0, y = 0;
  if (aspect < ART_W / ART_H) { w = ART_H * aspect; x = Math.max(0, Math.min(ART_W - w, HOUSE_CX - w / 2)); }
  else { h = ART_W / aspect; y = Math.max(0, Math.min(ART_H - h, HOUSE_CY - h * 0.55)); }
  svg.setAttribute("viewBox", `${x.toFixed(0)} ${y.toFixed(0)} ${w.toFixed(0)} ${h.toFixed(0)}`);
}

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mixC = (a, b, t) => "#" + hex2rgb(a).map((v, i) => Math.round(v + (hex2rgb(b)[i] - v) * Math.max(0, Math.min(1, t))).toString(16).padStart(2, "0")).join("");

function updateHouseArt(st, c, s) {
  if (!scene.built) buildHouseArt();
  const svg = document.getElementById("houseArt");
  if (!svg) return;
  const now = c.ts ? new Date(c.ts * 1000) : new Date();
  const e = st.elev, k = st.cloud ?? 0;
  const day = Math.max(0, Math.min(1, (e + 6) / 12));               // 0 Nacht … 1 Tag
  const dusk = Math.max(0, 1 - Math.abs(e) / 8);                      // Sonnenauf-/untergang
  // Himmel: das Bild zeigt einen klaren Tag; alles andere wird über die Himmelsfläche gelegt
  let top = mixC("#060d22", "#2d7dd2", day), bot = mixC("#1a2a55", "#9fcff2", day);
  top = mixC(top, "#3a3f72", dusk * 0.5); bot = mixC(bot, "#f29a58", dusk * 0.8);
  top = mixC(top, mixC("#141a26", "#7a8594", day), k * 0.9); bot = mixC(bot, mixC("#252c3a", "#c8ced5", day), k * 0.9);
  if (st.raining) { top = mixC(top, mixC("#10151f", "#4f5a68", day), 0.6); bot = mixC(bot, mixC("#1d2430", "#8d97a2", day), 0.6); }
  if (st.fog) { top = mixC(top, mixC("#2b3038", "#cfd4d8", day), 0.8); bot = mixC(bot, mixC("#3a4048", "#e2e5e8", day), 0.8); }
  svg.querySelector("#skyA").setAttribute("stop-color", top);
  svg.querySelector("#skyB").setAttribute("stop-color", bot);
  const skyA = Math.max(1 - day, dusk * 0.6, k * 0.85, st.raining ? 0.85 : 0, st.fog ? 0.9 : 0);
  svg.querySelector("#skyTint").setAttribute("opacity", skyA.toFixed(2));
  const clouds = svg.querySelector("#clouds");
  clouds.setAttribute("opacity", (Math.max(k, st.raining ? 0.9 : 0) * (0.3 + 0.6 * day)).toFixed(2));
  clouds.style.fill = st.raining || k > 0.85 ? mixC("#3a4150", "#a2aab4", day) : mixC("#5a6275", "#f4f6f8", day);
  // Licht auf der Szene: nachts dunkel und kühl (Haus bleibt erkennbar), bei Wolken flacher, in der Dämmerung warm
  const bright = (0.5 + 0.5 * day) * (1 - k * 0.2 * day) * (st.raining ? 0.88 : 1);
  svg.querySelector("#dark").setAttribute("opacity", (1 - bright).toFixed(2));
  svg.querySelector("#satM").setAttribute("values", Math.max(0.2, 1 - k * 0.4 - (1 - day) * 0.3 - (st.fog ? 0.3 : 0) - (st.frost ? 0.15 : 0)).toFixed(2));
  svg.querySelector("#shade").setAttribute("opacity", ((1 - day) * 0.3).toFixed(2));
  svg.querySelector("#tint").setAttribute("opacity", (dusk * 0.12 * (1 - k)).toFixed(2));
  const h = now.getHours(), lit = (h >= 16 && h <= 23) || (h >= 6 && h <= 8) ? 1 : 0.3;
  svg.querySelector("#winGlow").setAttribute("opacity", ((1 - day) * lit * 0.78).toFixed(2));
  svg.querySelector("#stars").setAttribute("opacity", ((1 - day) * (1 - k) * (st.fog ? 0 : 1)).toFixed(2));
  svg.querySelector("#fog").setAttribute("opacity", st.fog ? 0.9 : 0);
  svg.querySelector("#snowCover").setAttribute("opacity", st.snow ? 1 : 0);
  document.getElementById("sceneCard").classList.toggle("frost", st.frost);
  document.getElementById("sceneCard").classList.toggle("fog", st.fog);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", skyA > 0.5 ? top : "#2d7dd2");
}

function renderScene(c, s, recentRain) {
  const st = weatherState(c, s, recentRain);
  scene.st = st; scene.c = c;
  if (!document.getElementById("sceneCard")) return;
  updateHouseArt(st, c, s);
  const h = new Date().getHours();
  document.getElementById("greeting").textContent = h < 5 ? "Gute Nacht" : h < 11 ? "Guten Morgen" : h < 17 ? "Guten Tag" : h < 22 ? "Guten Abend" : "Gute Nacht";
  const t = c.temp_out !== undefined && c.temp_out !== null ? nf(c.temp_out, 1) : "–";
  const place = (s.station_name || "").replace(/^Meine Wetterstation$/, "") || "am Haus";
  document.getElementById("headline").textContent = st.phrase ? `Es ist ${t}° und ${st.phrase}.` : `Es ist ${t}° ${place.startsWith("am") ? place : "in " + place}.`;
  renderDayline(st);
  initParticles();
  if (!scene.raf) scene.raf = requestAnimationFrame(drawScene);
}

function renderDayline(st = scene.st) {
  const el = document.getElementById("dayline");
  if (!el || !st) return;
  const td = typeof latestData !== "undefined" ? latestData?.today : null;
  const parts = FC.dayMax !== null ? [`Tag ${nf(FC.dayMax, 0)}°`, `Nacht ${nf(FC.nightMin, 0)}°`]
    : td?.temp_min ? [`Heute ${nf(td.temp_min.value, 1)}° bis ${nf(td.temp_max.value, 1)}°`] : [];
  el.textContent = [...parts, ...st.notes].join("  •  ");
}

function initParticles() {
  const cv = document.getElementById("sceneFx"), st = scene.st;
  if (!cv || !st) return;
  const w = cv.clientWidth, h = cv.clientHeight;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const month = new Date().getMonth();
  let n = 0, kind = null;
  if (st.snow) { kind = "snow"; n = Math.round(60 + Math.min(st.rate, 5) * 30); }
  else if (st.raining) { kind = "rain"; n = Math.round(70 + Math.min(st.rate, 15) * 25); }
  else if ((scene.c.wind_speed || 0) > 8 && !st.night && month >= 8 && month <= 10) { kind = "leaf"; n = Math.round(Math.min(scene.c.wind_speed, 50) / 2); }
  if (reduce) n = Math.round(n / 3);
  if (scene.parts.kind === kind && scene.parts.length === n) return;
  const r = Math.random;
  scene.parts = Array.from({ length: n }, () => ({ x: r() * w, y: r() * h, z: 0.4 + r() * 0.6, p: r() * 6.28 }));
  scene.parts.kind = kind;
}

function drawScene(now) {
  scene.raf = requestAnimationFrame(drawScene);
  const cv = document.getElementById("sceneFx");
  if (!cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); initParticles(); }
  const dt = Math.min(0.05, (now - (scene.last || now)) / 1000);
  scene.last = now;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const c = scene.c, kind = scene.parts.kind;
  if (!kind) return;
  // Windrichtung: Wind aus Westen (270°) treibt nach rechts
  const dir = ((c.wind_dir ?? 270) * Math.PI) / 180;
  const wx = -Math.sin(dir) * Math.min(c.wind_speed || 0, 60) * 4;
  for (const p of scene.parts) {
    if (kind === "rain") {
      p.y += (650 + 250 * p.z) * dt; p.x += wx * dt;
      ctx.strokeStyle = `rgba(210,228,255,${0.25 + 0.4 * p.z})`;
      ctx.lineWidth = 1 + p.z;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - wx * 0.02, p.y - 14 * p.z); ctx.stroke();
    } else if (kind === "snow") {
      p.p += dt; p.y += (35 + 40 * p.z) * dt; p.x += (wx * 0.5 + Math.sin(p.p) * 12) * dt;
      ctx.fillStyle = `rgba(255,255,255,${0.5 + 0.5 * p.z})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.2 + 2.2 * p.z, 0, 6.28); ctx.fill();
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

// ====================================================================== Wetter-Symbole (farbig, als SVG)
const ICO = {
  sun: (x, y, r) => `<g stroke="#f8b712" stroke-width="2" stroke-linecap="round">${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
    const c = Math.cos((a * Math.PI) / 180), s = Math.sin((a * Math.PI) / 180);
    return `<line x1="${x + c * (r + 3)}" y1="${y + s * (r + 3)}" x2="${x + c * (r + 6)}" y2="${y + s * (r + 6)}"/>`;
  }).join("")}</g><circle cx="${x}" cy="${y}" r="${r}" fill="#f8b712"/>`,
  moon: (x, y, r) => `<path d="M${x + r * 0.3} ${y - r} A${r} ${r} 0 1 0 ${x + r} ${y + r * 0.35} A${r * 0.8} ${r * 0.8} 0 0 1 ${x + r * 0.3} ${y - r}Z" fill="#e9d98a"/>`,
  cloud: (x, y, s, fill) => `<path transform="translate(${x} ${y}) scale(${s})" d="M-9 6h17a6 6 0 0 0 .5-12 8 8 0 0 0-15.5 2.2A5 5 0 0 0-9 6z" fill="${fill}"/>`,
  drops: (n) => [...Array(n)].map((_, i) => `<line x1="${11 + i * 5}" y1="24" x2="${9.5 + i * 5}" y2="29" stroke="#3b82f6" stroke-width="2" stroke-linecap="round"/>`).join(""),
  flakes: (n) => [...Array(n)].map((_, i) => `<circle cx="${11 + i * 5}" cy="${26 + (i % 2) * 2}" r="1.6" fill="#7fb2e8"/>`).join(""),
  bolt: `<path d="M17 21l-4 6h3l-2 5 6-7h-3l2-4z" fill="#f8b712"/>`,
  fog: `<g stroke="#9aa3ad" stroke-width="2" stroke-linecap="round"><line x1="6" y1="20" x2="26" y2="20"/><line x1="9" y1="24" x2="23" y2="24"/><line x1="7" y1="28" x2="25" y2="28"/></g>`,
};
function wxIcon(code, night) {
  const body = night ? ICO.moon(14, 12, 7) : ICO.sun(13, 12, 5.5), light = "#d3d7de", dark = "#9ea6b2";
  let g;
  if (code === 0) g = night ? ICO.moon(16, 15, 9) : ICO.sun(16, 16, 7);
  else if (code === 1) g = body + ICO.cloud(21, 19, 0.75, light);
  else if (code === 2) g = body + ICO.cloud(18, 18, 1.0, light);
  else if (code === 3) g = ICO.cloud(13, 13, 0.8, dark) + ICO.cloud(18, 18, 1.0, light);
  else if (code === 45 || code === 48) g = ICO.cloud(16, 11, 0.9, light) + ICO.fog;
  else if (code >= 51 && code <= 67) g = ICO.cloud(16, 15, 1.05, code >= 63 ? dark : light) + ICO.drops(code >= 63 ? 3 : 2);
  else if (code >= 71 && code <= 77) g = ICO.cloud(16, 15, 1.05, light) + ICO.flakes(3);
  else if (code >= 80 && code <= 82) g = body + ICO.cloud(18, 16, 1.0, light) + ICO.drops(code === 80 ? 2 : 3);
  else if (code === 85 || code === 86) g = body + ICO.cloud(18, 16, 1.0, light) + ICO.flakes(3);
  else if (code >= 95) g = ICO.cloud(16, 14, 1.05, dark) + ICO.bolt;
  else g = ICO.cloud(16, 16, 1, light);
  return `<svg class="wx" viewBox="0 0 32 32" aria-hidden="true">${g}</svg>`;
}

// ====================================================================== Prognose (MeteoSchweiz-Modell ICON-CH über Open-Meteo)
const WMO = {
  0: "Klar", 1: "Überwiegend klar", 2: "Teilweise bewölkt", 3: "Bedeckt", 45: "Nebel", 48: "Reifnebel",
  51: "Leichter Niesel", 53: "Niesel", 55: "Starker Niesel", 56: "Gefrierender Niesel", 57: "Gefrierender Niesel",
  61: "Leichter Regen", 63: "Regen", 65: "Starker Regen", 66: "Gefrierender Regen", 67: "Gefrierender Regen",
  71: "Leichter Schneefall", 73: "Schneefall", 75: "Starker Schneefall", 77: "Schneegriesel",
  80: "Regenschauer", 81: "Regenschauer", 82: "Heftige Schauer", 85: "Schneeschauer", 86: "Schneeschauer",
  95: "Gewitter", 96: "Gewitter mit Hagel", 99: "Gewitter mit Hagel",
};
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
  const start = Math.max(0, times.findIndex((t) => t > now - 3600e3));
  FC = { nowCode: H.weather_code[start], dayMax: D.temperature_2m_max[0], nightMin: D.temperature_2m_min[0] };
  // Stundenstreifen: nächste 24 Stunden
  let hours = "";
  for (let i = start; i < Math.min(times.length, start + 24); i++) {
    const night = sunElevation(times[i], lat, lon) < -4, mm = H.precipitation[i] || 0;
    hours += `<div class="hr${i === start ? " now" : ""}" title="${WMO[H.weather_code[i]] || ""}">
      <span class="h">${i === start ? "Jetzt" : pad(new Date(times[i]).getHours())}</span><span class="t">${nf(H.temperature_2m[i], 0)}°</span>
      ${wxIcon(H.weather_code[i], night)}
      <span class="p">${mm >= 0.1 ? `<svg viewBox="0 0 10 12"><path d="M5 1s4 4.5 4 7a4 4 0 0 1-8 0c0-2.5 4-7 4-7z"/></svg>${nf(mm, 1)}` : ""}</span></div>`;
  }
  const strip = document.getElementById("hourly");
  if (strip) { strip.innerHTML = hours; strip.hidden = false; }
  const next24 = H.precipitation.slice(start, start + 24).reduce((a, b) => a + (b || 0), 0);
  let days = "";
  for (let i = 0; i < D.time.length; i++) {
    const d = new Date(D.time[i] + "T12:00"), mm = D.precipitation_sum[i] || 0;
    days += `<div class="fc-d" title="${WMO[D.weather_code[i]] || ""}"><b>${i === 0 ? "Heute" : DAYS[d.getDay()]}</b>${wxIcon(D.weather_code[i], false)}
      <span class="cold">${nf(D.temperature_2m_min[i], 0)}°</span><span class="fc-bar"><i style="--a:${(D.temperature_2m_min[i] + 10) / 45};--b:${(D.temperature_2m_max[i] + 10) / 45}"></i></span>
      <span class="warm">${nf(D.temperature_2m_max[i], 0)}°</span>
      <span class="fc-mm">${mm >= 0.1 ? `${nf(mm, 1)} mm · <b>${nf(mm * k, 0)} L</b>` : "trocken"}</span></div>`;
  }
  const total = D.precipitation_sum.reduce((a, b) => a + (b || 0), 0);
  document.querySelector("#forecastCard .fc-body").innerHTML =
    `<div class="fc-tank">Erwarteter Zufluss in den Regentank: <b>${nf(next24 * k, 0)} L</b> in 24 h · <b>${nf(total * k, 0)} L</b> in 5 Tagen</div>
     <div class="fc-days">${days}</div>
     <p class="muted small">Modell: ${model}, via Open-Meteo · <a href="https://www.meteoschweiz.admin.ch/lokalprognose" target="_blank" rel="noopener">Lokalprognose bei MeteoSchweiz</a></p>`;
  if (scene.c && typeof latestData !== "undefined" && latestData) renderScene(scene.c, latestData.settings, scene.c.rain_mm || 0);
}

// ====================================================================== Sonne & Mond (SunCalc, im Browser berechnet)
const PHASES = [[0.03, "Neumond"], [0.22, "Zunehmende Sichel"], [0.28, "Erstes Viertel"], [0.47, "Zunehmender Mond"],
  [0.53, "Vollmond"], [0.72, "Abnehmender Mond"], [0.78, "Letztes Viertel"], [0.97, "Abnehmende Sichel"], [1.01, "Neumond"]];
const phaseName = (p) => PHASES.find(([lim]) => p < lim)[1];
const hm = (d) => (d && !isNaN(d) ? fmtTime(d) : "–");
const dur = (ms) => `${Math.floor(ms / 3600e3)} h ${pad(Math.round((ms % 3600e3) / 60e3))} min`;

/* Mondscheibe: beleuchteter Teil für Phase p (0 Neumond, 0.5 Vollmond), Nordhalbkugel: zunehmend rechts hell */
function moonSvg(p, size = 72) {
  const r = 30, c = 36, f = (1 - Math.cos(2 * Math.PI * p)) / 2;  // beleuchteter Anteil
  const rx = Math.abs(1 - 2 * f) * r, waxing = p < 0.5;
  const outer = waxing ? 1 : 0, term = waxing ? (f < 0.5 ? 0 : 1) : (f < 0.5 ? 1 : 0);
  const lit = f < 0.01 ? "" : f > 0.99 ? `<circle cx="${c}" cy="${c}" r="${r}" class="moon-lit"/>` :
    `<path d="M${c} ${c - r} A${r} ${r} 0 0 ${outer} ${c} ${c + r} A${rx.toFixed(2)} ${r} 0 0 ${term} ${c} ${c - r}Z" class="moon-lit"/>`;
  return `<svg viewBox="0 0 72 72" width="${size}" height="${size}" aria-hidden="true"><circle cx="${c}" cy="${c}" r="${r}" class="moon-dark"/>${lit}</svg>`;
}

function nextPhase(target, from) {  // nächster Zeitpunkt, an dem die Mondphase target (0 oder 0.5) erreicht
  let prev = SunCalc.getMoonIllumination(from).phase;
  for (let t = from.getTime() + 3600e3; t < from.getTime() + 31 * DAY; t += 3600e3) {
    const p = SunCalc.getMoonIllumination(new Date(t)).phase;
    const crossed = target === 0 ? p < prev : prev < 0.5 && p >= 0.5;
    if (crossed) return new Date(t);
    prev = p;
  }
  return null;
}

function renderSkyCard(s) {
  const box = document.getElementById("skyCard");
  if (!box || !window.SunCalc) return;
  const lat = +s.latitude || DEFAULT_LAT, lon = +s.longitude || DEFAULT_LON, now = new Date();
  const t = SunCalc.getTimes(now, lat, lon), ty = SunCalc.getTimes(new Date(now - DAY), lat, lon);
  const day = t.sunset - t.sunrise, diff = Math.round((day - (ty.sunset - ty.sunrise)) / 60e3);
  // Sonnenbogen: Position zwischen Auf- und Untergang
  const frac = Math.max(0, Math.min(1, (now - t.sunrise) / day)), up = now > t.sunrise && now < t.sunset;
  const ang = Math.PI * (1 - frac), sx = 110 + 90 * Math.cos(ang), sy = 100 - 80 * Math.sin(ang);
  const sunArc = `<svg viewBox="0 0 220 118" class="sun-arc" aria-hidden="true">
      <path d="M20 100 A90 80 0 0 1 200 100" class="arc-bg"/>
      ${up ? `<path d="M20 100 A90 80 0 0 1 ${sx.toFixed(1)} ${sy.toFixed(1)}" class="arc-done"/>` : ""}
      <line x1="8" y1="100" x2="212" y2="100" class="arc-horizon"/>
      ${up ? `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="9" class="arc-sun"/>` : ""}
      <text x="20" y="116" class="arc-t">${hm(t.sunrise)}</text><text x="200" y="116" class="arc-t">${hm(t.sunset)}</text></svg>`;
  const m = SunCalc.getMoonIllumination(now), mt = SunCalc.getMoonTimes(now, lat, lon);
  const mp = SunCalc.getMoonPosition(now, lat, lon);
  const full = nextPhase(0.5, now), neu = nextPhase(0, now);
  const dd = (d) => (d ? `${DAYS[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.` : "–");
  box.querySelector(".sky-body").innerHTML = `
    <div class="sky-col">
      ${sunArc}
      <dl class="info sky-info">
        <dt>Sonnenaufgang</dt><dd>${hm(t.sunrise)}</dd><dt>Sonnenuntergang</dt><dd>${hm(t.sunset)}</dd>
        <dt>Tageslänge</dt><dd>${dur(day)} <span class="muted small">(${diff >= 0 ? "+" : ""}${diff} min)</span></dd>
        <dt>Dämmerung</dt><dd>${hm(t.dawn)} / ${hm(t.dusk)}</dd>
        <dt>Sonnenhöhe</dt><dd>${nf(sunElevation(now.getTime(), lat, lon), 1)}°</dd>
      </dl>
    </div>
    <div class="sky-col">
      <div class="moon-row">${moonSvg(m.phase, 84)}<div><div class="moon-name">${phaseName(m.phase)}</div>
        <div class="muted">${nf(m.fraction * 100, 0)} % beleuchtet</div></div></div>
      <dl class="info sky-info">
        <dt>Mondaufgang</dt><dd>${mt.rise ? hm(mt.rise) : mt.alwaysUp ? "ganzer Tag sichtbar" : "–"}</dd>
        <dt>Monduntergang</dt><dd>${mt.set ? hm(mt.set) : mt.alwaysDown ? "nicht sichtbar" : "–"}</dd>
        <dt>Jetzt</dt><dd>${mp.altitude > 0 ? `${nf((mp.altitude * 180) / Math.PI, 0)}° über dem Horizont` : "unter dem Horizont"}</dd>
        <dt>Nächster Vollmond</dt><dd>${dd(full)}</dd><dt>Nächster Neumond</dt><dd>${dd(neu)}</dd>
      </dl>
    </div>`;
  renderSceneMoon(lat, lon, now, m, mp);
}

/* Mond im Hausbild: nachts an seiner Himmelsposition (Azimut -> links/rechts, Höhe -> oben/unten) */
function renderSceneMoon(lat, lon, now, m, mp) {
  const el = document.getElementById("sceneMoon");
  if (!el) return;
  const st = scene.st;
  const show = st && (st.night || st.dusk) && mp.altitude > 0.05 && (st.cloud ?? 0) < 0.85 && !st.fog && !st.raining;
  el.hidden = !show;
  if (!show) return;
  const az = ((mp.azimuth * 180) / Math.PI + 180 + 360) % 360;   // 0 = Nord, 180 = Süd
  // im freien Himmel rechts oben, damit Begrüssung und Schlagzeile frei bleiben
  const x = Math.max(62, Math.min(90, 76 + ((az - 180) / 110) * 14));
  const y = Math.max(9, Math.min(30, 30 - ((mp.altitude * 180) / Math.PI) * 0.4));
  el.style.left = x + "%"; el.style.top = y + "%";
  el.innerHTML = moonSvg(m.phase, 46);
}
