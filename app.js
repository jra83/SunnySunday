// app.js — interface : carte, recherche, et calcul de l'ensoleillement
// (masque + vue 3D affiches ensemble et lies) en un seul bouton.
import { completeAddress, fetchDem, fetchBuildings } from "./ign.js";
import { computeHorizon, buildingsHorizon, sunTrack, sunHours }
  from "./compute.js";
import { start3d, updateSun } from "./viewer3d.js";

const NEAR = { radiusM: 1500, resM: 3, minDistM: 20 };
const FAR  = { radiusM: 25000, resM: 25, minDistM: 1000 };
const BUILD_RADIUS = 400;
const EYE_HEIGHT = 3.0;
const YEAR = new Date().getFullYear();
const DATES = [
  { name: "Solstice d'été",   m: 6,  d: 21, color: "#e8a33d" },
  { name: "Équinoxe",         m: 3,  d: 20, color: "#4a90d9" },
  { name: "Solstice d'hiver", m: 12, d: 21, color: "#c0504d" },
];
const IGN_ORTHO = "https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0"
  + "&REQUEST=GetTile&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal"
  + "&TILEMATRIXSET=PM&FORMAT=image/jpeg"
  + "&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}";

let point = null, marker = null, map = null;
let lastMask = null, cur3dSun = null;

// ---------------------------------------------------------------- carte
function initMap() {
  map = L.map("map").setView([43.5424, 5.4925], 16);
  // tuiles ortho IGN dispo jusqu'au zoom 19 ; au-dela on agrandit la z19
  L.tileLayer(IGN_ORTHO, { maxNativeZoom: 19, maxZoom: 21,
    attribution: "© IGN" }).addTo(map);
  map.on("click", e => setPoint(e.latlng.lat, e.latlng.lng));
}
function setPoint(lat, lon) {
  point = { lat, lon };
  if (marker) marker.remove();
  marker = L.marker([lat, lon]).addTo(map);
  document.getElementById("coord").textContent =
    `Point : ${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

// -------------------------------------------------- autocompletion adresse
const addr = document.getElementById("addr");
const sugg = document.getElementById("sugg");
let timer = null;
addr.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const res = await completeAddress(addr.value);
    sugg.innerHTML = "";
    for (const it of res) {
      const div = document.createElement("div");
      div.className = "sugg-item";
      div.textContent = it.label;
      div.onclick = () => {
        addr.value = it.label;
        sugg.innerHTML = "";
        // zoom adapte : adresse precise -> proche ; commune -> vue large
        const z = it.kind === "housenumber" ? 19
          : (it.kind === "street") ? 17
          : (it.kind === "lieu-dit habité") ? 16 : 13;
        map.setView([it.lat, it.lon], z);
        setPoint(it.lat, it.lon);
      };
      sugg.appendChild(div);
    }
  }, 350);
});
document.addEventListener("click", e => {
  if (!e.target.closest(".search")) sugg.innerHTML = "";
});

// ------------------------------------------------------- calcul (1 bouton)
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
const barEl = document.getElementById("bar");
// la barre avance d'un cran a chaque message de statut : 4 etapes ici
// + 8 dans start3d + le message final = ~13 crans.
const TOTAL_STEPS = 13;
let curStep = 0;
const setStatus = m => {
  statusEl.textContent = m;
  curStep++;
  barEl.style.width = Math.min(100, curStep / TOTAL_STEPS * 100) + "%";
};
const reveal = id => document.getElementById(id).classList.add("show");

document.getElementById("btnCalc").addEventListener("click", async () => {
  if (!point) {
    setStatus("Choisis d'abord un lieu : clique sur la carte ou cherche "
      + "une adresse.");
    return;
  }
  const b = document.getElementById("btnCalc");
  b.disabled = true;
  curStep = 0;
  barEl.style.width = "0%";
  progressEl.classList.add("show");
  try {
    const t0 = performance.now();
    // --- masque d'ombrage ---
    setStatus("Téléchargement du relief proche : collines, vallons, pentes...");
    const near = await fetchDem(point.lat, point.lon, NEAR.radiusM, NEAR.resM);
    setStatus("Téléchargement des montagnes et reliefs lointains "
      + "jusqu'à 25 km (un peu de patience)...");
    const far = await fetchDem(point.lat, point.lon, FAR.radiusM, FAR.resM);
    setStatus("Repérage des bâtiments alentour...");
    const buildings = await fetchBuildings(point.lat, point.lon, BUILD_RADIUS);
    setStatus("Calcul des ombres du relief et des bâtiments...");
    await new Promise(r => setTimeout(r, 20));
    const { horizon, zGround } = computeHorizon(
      [{ dem: near, ...NEAR }, { dem: far, ...FAR }],
      point.lat, point.lon, EYE_HEIGHT);
    const bHor = buildingsHorizon(buildings, point.lat, point.lon,
      zGround + EYE_HEIGHT, near);
    // horizon du relief AU-DELA de la zone 3D detaillee (220 m) : la vue 3D
    // s'en sert pour assombrir la scene quand le soleil passe derriere un
    // relief lointain (collines / montagnes jusqu'a 25 km).
    const { horizon: farHorizon3d } = computeHorizon(
      [{ dem: near, radiusM: NEAR.radiusM, resM: NEAR.resM, minDistM: 220 },
       { dem: far,  radiusM: FAR.radiusM,  resM: FAR.resM,  minDistM: 1500 }],
      point.lat, point.lon, EYE_HEIGHT);
    const total = new Float32Array(360);
    for (let i = 0; i < 360; i++) total[i] = Math.max(horizon[i], bHor[i]);
    lastMask = { terrain: horizon, total, lat: point.lat, lon: point.lon };
    drawMask(horizon, total, point.lat, point.lon, cur3dSun);
    showHours(point.lat, point.lon, total, zGround);
    reveal("panelMask");

    // --- vue 3D --- (panneau revele AVANT : sinon le canvas a une taille
    // nulle et la 3D reste grise)
    reveal("panel3d");
    await new Promise(r => requestAnimationFrame(r));
    await start3d(point.lat, point.lon, setStatus, onSunMoved, farHorizon3d);
    setStatus(`Ensoleillement calculé en `
      + `${((performance.now() - t0) / 1000).toFixed(1)} s `
      + `(${buildings.length} bâtiments).`);
    barEl.style.width = "100%";
    setTimeout(() => progressEl.classList.remove("show"), 1200);
  } catch (e) {
    setStatus("Erreur : " + e.message);
    progressEl.classList.remove("show");
  }
  b.disabled = false;
});

function onSunMoved(az, el) {
  cur3dSun = { az, el };
  if (lastMask) {
    drawMask(lastMask.terrain, lastMask.total, lastMask.lat, lastMask.lon,
      cur3dSun);
  }
}

document.getElementById("s_hour").addEventListener("input", updateSun);
document.getElementById("s_day").addEventListener("input", updateSun);

// --------------------------------------------------------- dessin du masque
function drawMask(terr, total, lat, lon, curSun) {
  const cv = document.getElementById("mask");
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  const padL = 46, padR = 14, padT = 14, padB = 30;
  const pw = W - padL - padR, ph = H - padT - padB;
  const elMax = 75;
  const X = az => padL + (az / 360) * pw;
  const Y = el => padT + (1 - Math.max(0, el) / elMax) * ph;

  ctx.fillStyle = "#1e2128";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#333"; ctx.fillStyle = "#8b909a";
  ctx.font = "11px sans-serif"; ctx.lineWidth = 1;
  for (let el = 0; el <= elMax; el += 15) {
    ctx.beginPath(); ctx.moveTo(padL, Y(el)); ctx.lineTo(W - padR, Y(el));
    ctx.stroke();
    ctx.fillText(el + "°", 8, Y(el) + 4);
  }
  const dirs = ["N", "NE", "E", "SE", "S", "SO", "O", "NO", "N"];
  for (let k = 0; k < dirs.length; k++) {
    ctx.strokeStyle = "#2c2f37";
    ctx.beginPath(); ctx.moveTo(X(k * 45), padT); ctx.lineTo(X(k * 45), Y(0));
    ctx.stroke();
    ctx.fillText(dirs[k], X(k * 45) - 6, H - 10);
  }

  const fillPoly = (arr, color) => {
    ctx.beginPath();
    ctx.moveTo(X(0), Y(0));
    for (let i = 0; i <= 360; i++) ctx.lineTo(X(i), Y(arr[i % 360]));
    ctx.lineTo(X(360), Y(0));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  fillPoly(total, "rgba(95,112,142,0.92)");
  fillPoly(terr, "rgba(150,150,160,0.9)");

  for (const d of DATES) {
    const tr = sunTrack(lat, lon, YEAR, d.m, d.d, 6).filter(p => p.el > 0);
    ctx.strokeStyle = d.color; ctx.lineWidth = 2;
    ctx.beginPath();
    tr.forEach((p, i) => {
      const x = X(p.az), y = Y(p.el);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = d.color; ctx.font = "10px sans-serif";
    for (const p of tr) {
      const hh = Math.round(p.hLocale);
      if (Math.abs(p.hLocale - hh) < 1e-9 && hh >= 5 && hh <= 21) {
        const x = X(p.az), y = Y(p.el);
        ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 2 * Math.PI); ctx.fill();
        ctx.fillText(hh + "h", x + 4, y - 4);
      }
    }
  }

  if (curSun && curSun.el > 0) {
    const x = X(curSun.az), y = Y(curSun.el);
    ctx.beginPath(); ctx.arc(x, y, 7, 0, 2 * Math.PI);
    ctx.fillStyle = "#ffd23f"; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = "11px sans-serif";
    ctx.fillText("3D", x + 10, y + 4);
  }

  ctx.font = "11px sans-serif";
  ctx.fillStyle = "rgba(150,150,160,0.9)";
  ctx.fillRect(W - 190, 16, 12, 12);
  ctx.fillStyle = "#8b909a"; ctx.fillText("relief", W - 174, 26);
  ctx.fillStyle = "rgba(95,112,142,0.92)";
  ctx.fillRect(W - 130, 16, 12, 12);
  ctx.fillStyle = "#8b909a"; ctx.fillText("bâtiments", W - 114, 26);
}

// --------------------------------------------------------- cartes "heures"
function showHours(lat, lon, horizon, zGround) {
  const box = document.getElementById("hours");
  box.innerHTML = "";
  const mk = (t, v) => {
    const c = document.createElement("div");
    c.className = "card";
    c.innerHTML = `<div class="t">${t}</div><div class="v">${v}</div>`;
    box.appendChild(c);
  };
  mk("Altitude du sol", `${zGround.toFixed(1)} m`);
  for (const d of DATES) {
    const r = sunHours(lat, lon, YEAR, d.m, d.d, horizon);
    mk(d.name, `${r.visible.toFixed(2)} h <small>/ ${r.total.toFixed(2)} h</small>`);
  }
}

initMap();
