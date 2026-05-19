// compute.js — coeur de calcul du masque d'ombrage, porte depuis
// horizon_rgealti.py (Python) vers du JavaScript pur (typed arrays).
// Tout tourne dans le navigateur du poste.

export const M_PER_DEG_LAT = 111132.0;
const EARTH_R = 6371000.0;
const REFRACTION_K = 0.13;
const DEG = Math.PI / 180;

// --------------------------------------------------------------------------
// POSITION DU SOLEIL (algorithme NOAA)
// --------------------------------------------------------------------------

function julianDay(d) {
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() + 1;
  const day = d.getUTCDate()
    + (d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600) / 24;
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1))
    + day + B - 1524.5;
}

// dateUTC : objet Date (en UTC). Renvoie {az, el} en degres.
export function solarPosition(lat, lon, dateUTC) {
  const jc = (julianDay(dateUTC) - 2451545.0) / 36525.0;
  const gml = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
  const gma = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const ecc = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const gmaR = gma * DEG;
  const ctr = Math.sin(gmaR) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
    + Math.sin(2 * gmaR) * (0.019993 - 0.000101 * jc)
    + Math.sin(3 * gmaR) * 0.000289;
  const trueLong = gml + ctr;
  const appLong = trueLong - 0.00569
    - 0.00478 * Math.sin((125.04 - 1934.136 * jc) * DEG);
  let obliq = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813)))
    / 60) / 60;
  obliq += 0.00256 * Math.cos((125.04 - 1934.136 * jc) * DEG);
  const obliqR = obliq * DEG;
  const decl = Math.asin(Math.sin(obliqR) * Math.sin(appLong * DEG));

  const vary = Math.tan(obliqR / 2) ** 2;
  const gmlR = gml * DEG;
  const eot = 4 / DEG * (
    vary * Math.sin(2 * gmlR) - 2 * ecc * Math.sin(gmaR)
    + 4 * ecc * vary * Math.sin(gmaR) * Math.cos(2 * gmlR)
    - 0.5 * vary * vary * Math.sin(4 * gmlR)
    - 1.25 * ecc * ecc * Math.sin(2 * gmaR));

  const minutes = dateUTC.getUTCHours() * 60 + dateUTC.getUTCMinutes()
    + dateUTC.getUTCSeconds() / 60;
  const tst = ((minutes + eot + 4 * lon) % 1440 + 1440) % 1440;
  const ha = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;

  const latR = lat * DEG;
  let cosZen = Math.sin(latR) * Math.sin(decl)
    + Math.cos(latR) * Math.cos(decl) * Math.cos(ha * DEG);
  cosZen = Math.max(-1, Math.min(1, cosZen));
  const zenith = Math.acos(cosZen);
  const el = 90 - zenith / DEG;

  const denom = Math.cos(latR) * Math.sin(zenith);
  let az;
  if (Math.abs(denom) > 1e-9) {
    let ca = (Math.sin(latR) * cosZen - Math.sin(decl)) / denom;
    ca = Math.max(-1, Math.min(1, ca));
    az = Math.acos(ca) / DEG;
    az = ha > 0 ? (az + 180) % 360 : (540 - az) % 360;
  } else {
    az = 180;
  }
  return { az, el };
}

// --------------------------------------------------------------------------
// MNT : echantillonnage bilineaire
// --------------------------------------------------------------------------

// dem : {z:Float32Array, w, h, latN, latS, lonW, lonE}
export function makeDem(z, w, h, latN, latS, lonW, lonE) {
  return {
    z, w, h, latN, latS, lonW, lonE,
    dlat: (latN - latS) / h,
    dlon: (lonE - lonW) / w,
  };
}

// Lisse le MNT (moyenne 3x3 repetee) pour gommer le bruit de mesure.
export function smoothDem(dem, passes = 2) {
  const { w, h } = dem;
  let z = Float32Array.from(dem.z);
  for (let p = 0; p < passes; p++) {
    const o = z;
    z = new Float32Array(w * h);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        let s = 0, n = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr >= 0 && rr < h && cc >= 0 && cc < w) {
              const v = o[rr * w + cc];
              if (Number.isFinite(v)) { s += v; n++; }
            }
          }
        }
        z[r * w + c] = n ? s / n : o[r * w + c];
      }
    }
  }
  return { ...dem, z };
}

export function sampleDem(dem, lat, lon) {
  const col = (lon - dem.lonW) / dem.dlon - 0.5;
  const row = (dem.latN - lat) / dem.dlat - 0.5;
  const c0 = Math.floor(col), r0 = Math.floor(row);
  if (r0 < 0 || r0 >= dem.h - 1 || c0 < 0 || c0 >= dem.w - 1) return NaN;
  const fc = col - c0, fr = row - r0;
  const z = dem.z, w = dem.w;
  const v00 = z[r0 * w + c0], v01 = z[r0 * w + c0 + 1];
  const v10 = z[(r0 + 1) * w + c0], v11 = z[(r0 + 1) * w + c0 + 1];
  const top = v00 * (1 - fc) + v01 * fc;
  const bot = v10 * (1 - fc) + v11 * fc;
  return top * (1 - fr) + bot * fr;
}

// --------------------------------------------------------------------------
// HORIZON
// --------------------------------------------------------------------------

// Profil d'horizon (360 valeurs, deg) calcule sur un seul MNT.
export function horizonFromDem(dem, lat0, lon0, zObs, radiusM, resM, minDistM) {
  const mLon = M_PER_DEG_LAT * Math.cos(lat0 * DEG);
  const hor = new Float32Array(360);
  for (let i = 0; i < 360; i++) {
    const a = i * DEG;
    const sinA = Math.sin(a), cosA = Math.cos(a);
    let best = -90;
    for (let d = minDistM; d <= radiusM; d += resM) {
      const lat = lat0 + (d * cosA) / M_PER_DEG_LAT;
      const lon = lon0 + (d * sinA) / mLon;
      const zt = sampleDem(dem, lat, lon);
      if (Number.isNaN(zt)) continue;
      const drop = (1 - REFRACTION_K) * d * d / (2 * EARTH_R);
      const ang = Math.atan2(zt - drop - zObs, d) / DEG;
      if (ang > best) best = ang;
    }
    hor[i] = best;
  }
  return hor;
}

// Combine plusieurs MNT (du plus fin au plus large) -> horizon + altitude sol.
// layers : [{dem, radiusM, resM, minDistM}, ...]
export function computeHorizon(layers, lat0, lon0, eyeHeight) {
  let zGround = NaN;
  for (const ly of layers) {
    const v = sampleDem(ly.dem, lat0, lon0);
    if (!Number.isNaN(v)) { zGround = v; break; }
  }
  if (Number.isNaN(zGround)) throw new Error("Point hors des MNT.");
  const zObs = zGround + eyeHeight;
  const horizon = new Float32Array(360).fill(-90);
  for (const ly of layers) {
    const h = horizonFromDem(ly.dem, lat0, lon0, zObs,
      ly.radiusM, ly.resM, ly.minDistM);
    for (let i = 0; i < 360; i++) if (h[i] > horizon[i]) horizon[i] = h[i];
  }
  return { horizon, zGround };
}

// Contribution des batiments au masque d'horizon (lancer de rayons exact
// sur les murs). buildings : [{ring:[[lon,lat]...], height}].
// dem : MNT pour l'altitude du sol au pied de chaque batiment.
export function buildingsHorizon(buildings, lat0, lon0, zObs, dem) {
  const mLon = M_PER_DEG_LAT * Math.cos(lat0 * DEG);
  const ux = new Float64Array(360), uy = new Float64Array(360);
  for (let i = 0; i < 360; i++) {
    ux[i] = Math.sin(i * DEG); uy[i] = Math.cos(i * DEG);
  }
  const horizon = new Float32Array(360).fill(-90);
  for (const b of buildings) {
    // on ne se masque pas soi-meme : on ignore le batiment de l'observateur
    if (pointInRing(lon0, lat0, b.ring)) continue;
    let sx = 0, sy = 0;
    for (const [lo, la] of b.ring) { sx += lo; sy += la; }
    const clon = sx / b.ring.length, clat = sy / b.ring.length;
    const g = sampleDem(dem, clat, clon);
    if (!Number.isFinite(g)) continue;
    const top = g + b.height;
    const ring = b.ring.map(([lo, la]) =>
      [(lo - lon0) * mLon, (la - lat0) * M_PER_DEG_LAT]);
    const tmin = new Float64Array(360).fill(Infinity);
    for (let k = 0; k < ring.length - 1; k++) {
      const x1 = ring[k][0], y1 = ring[k][1];
      const dx = ring[k + 1][0] - x1, dy = ring[k + 1][1] - y1;
      for (let i = 0; i < 360; i++) {
        const det = -ux[i] * dy + dx * uy[i];
        if (Math.abs(det) < 1e-12) continue;
        const t = (-x1 * dy + dx * y1) / det;
        const w = (ux[i] * y1 - uy[i] * x1) / det;
        if (t > 1e-6 && w >= -1e-9 && w <= 1 + 1e-9 && t < tmin[i]) {
          tmin[i] = t;
        }
      }
    }
    for (let i = 0; i < 360; i++) {
      if (tmin[i] < Infinity) {
        const ang = Math.atan2(top - zObs, tmin[i]) / DEG;
        if (ang > horizon[i]) horizon[i] = ang;
      }
    }
  }
  return horizon;
}

// --------------------------------------------------------------------------
// ENSOLEILLEMENT
// --------------------------------------------------------------------------

export function utcOffset(month) { return (month >= 4 && month <= 10) ? 2 : 1; }

export function horizonAt(azQuery, horizon) {
  const a = ((azQuery % 360) + 360) % 360;
  const i0 = Math.floor(a) % 360;
  const i1 = (i0 + 1) % 360;
  const f = a - Math.floor(a);
  return horizon[i0] * (1 - f) + horizon[i1] * f;
}

// Course du Soleil sur une journee : liste de {az, el, hLocale}.
export function sunTrack(lat, lon, year, month, day, stepMin = 6) {
  const off = utcOffset(month);
  const out = [];
  for (let mn = 0; mn < 1440; mn += stepMin) {
    const utc = new Date(Date.UTC(year, month - 1, day, 0, mn - off * 60));
    const s = solarPosition(lat, lon, utc);
    if (s.el > -1) out.push({ az: s.az, el: s.el, hLocale: mn / 60 });
  }
  return out;
}

// --------------------------------------------------------------------------
// OMBRES PORTEES (pour la vue 3D)
// --------------------------------------------------------------------------

export const SHADOW_KEEP = 0.32;        // lumiere gardee a l'ombre

function sampleGridPx(z, w, h, row, col) {
  const r0 = Math.floor(row), c0 = Math.floor(col);
  if (r0 < 0 || r0 >= h - 1 || c0 < 0 || c0 >= w - 1) return NaN;
  const fr = row - r0, fc = col - c0;
  const v00 = z[r0 * w + c0], v01 = z[r0 * w + c0 + 1];
  const v10 = z[(r0 + 1) * w + c0], v11 = z[(r0 + 1) * w + c0 + 1];
  const top = v00 * (1 - fc) + v01 * fc;
  const bot = v10 * (1 - fc) + v11 * fc;
  return top * (1 - fr) + bot * fr;
}

// Carte d'ombrage (Float32Array, 1 = soleil, SHADOW_KEEP = a l'ombre).
// dem : objet de makeDem. Pixels carres en metres.
export function castShadow(dem, sunAz, sunEl, maxDist) {
  const { z, w, h } = dem;
  const resM = (dem.latN - dem.latS) * M_PER_DEG_LAT / h;
  const out = new Float32Array(w * h);
  if (sunEl <= 0) { out.fill(0.13); return out; }
  const a = sunAz * DEG, tanEl = Math.tan(sunEl * DEG);
  const drow = -Math.cos(a) / resM, dcol = Math.sin(a) / resM;
  const blocker = new Float32Array(w * h).fill(-Infinity);
  let d = resM;
  while (d <= maxDist) {
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const samp = sampleGridPx(z, w, h, r + drow * d, c + dcol * d);
        if (!Number.isNaN(samp)) {
          const app = samp - d * tanEl;
          const idx = r * w + c;
          if (app > blocker[idx]) blocker[idx] = app;
        }
      }
    }
    d += resM * (1.0 + d / 220.0);
  }
  for (let i = 0; i < w * h; i++) {
    out[i] = z[i] >= blocker[i] ? 1.0 : SHADOW_KEEP;
  }
  return out;
}

// --------------------------------------------------------------------------
// BATIMENTS : gravure des emprises dans le MNT (pour les ombres portees)
// --------------------------------------------------------------------------

function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > py) !== (yj > py)
        && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Renvoie une copie du MNT avec les emprises de batiments surelevees de
// leur hauteur reelle. buildings : [{ring:[[lon,lat]...], height}].
export function burnBuildings(dem, buildings) {
  const { z, w, h, lonW, latN, dlon, dlat } = dem;
  const zb = Float32Array.from(z);
  for (const b of buildings) {
    let minC = w, maxC = -1, minR = h, maxR = -1;
    for (const [lon, lat] of b.ring) {
      const c = (lon - lonW) / dlon, r = (latN - lat) / dlat;
      if (c < minC) minC = c; if (c > maxC) maxC = c;
      if (r < minR) minR = r; if (r > maxR) maxR = r;
    }
    const c0 = Math.max(0, Math.floor(minC)), c1 = Math.min(w - 1, Math.ceil(maxC));
    const r0 = Math.max(0, Math.floor(minR)), r1 = Math.min(h - 1, Math.ceil(maxR));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const lon = lonW + (c + 0.5) * dlon;
        const lat = latN - (r + 0.5) * dlat;
        if (pointInRing(lon, lat, b.ring)) {
          const g = z[r * w + c];
          if (Number.isFinite(g)) {
            const top = g + b.height;
            if (top > zb[r * w + c]) zb[r * w + c] = top;
          }
        }
      }
    }
  }
  return zb;
}

// Heures de soleil dans la journee compte tenu du masque.
export function sunHours(lat, lon, year, month, day, horizon) {
  const off = utcOffset(month);
  let visible = 0, aboveH = 0;
  for (let mn = 0; mn < 1440; mn++) {
    const utc = new Date(Date.UTC(year, month - 1, day, 0, mn - off * 60));
    const s = solarPosition(lat, lon, utc);
    if (s.el > 0) {
      aboveH++;
      if (s.el > horizonAt(s.az, horizon)) visible++;
    }
  }
  return { visible: visible / 60, total: aboveH / 60 };
}
