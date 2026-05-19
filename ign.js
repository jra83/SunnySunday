// ign.js — acces direct aux services IGN depuis le navigateur.
// CORS ouvert (access-control-allow-origin: *) -> aucun proxy / serveur requis.

import { M_PER_DEG_LAT, makeDem } from "./compute.js";

const WMS  = "https://data.geopf.fr/wms-r/wms";
const WFS  = "https://data.geopf.fr/wfs/ows";
const GEOC = "https://data.geopf.fr/geocodage/completion";
const SEARCH = "https://data.geopf.fr/geocodage/search";
const MNT_LAYER = "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES";   // RGE ALTI

// --- autocompletion d'adresse ---------------------------------------------
export async function completeAddress(text) {
  if (text.trim().length < 4) return [];
  const url = `${GEOC}?text=${encodeURIComponent(text)}&maximumResponses=8`;
  try {
    const r = await fetch(url);
    const d = await r.json();
    return (d.results || []).map(it => ({
      label: it.fulltext, lat: it.y, lon: it.x, kind: it.kind || "",
    }));
  } catch (e) {
    return [];
  }
}

// --- geocodage precis d'une adresse (point exact) -------------------------
export async function geocode(text) {
  const url = `${SEARCH}?q=${encodeURIComponent(text)}&limit=1`;
  try {
    const r = await fetch(url);
    const d = await r.json();
    const f = (d.features || [])[0];
    if (!f || !f.geometry) return null;
    const [lon, lat] = f.geometry.coordinates;     // GeoJSON : lon, lat
    return { lat, lon };
  } catch (e) {
    return null;
  }
}

// --- telechargement d'un MNT (WMS, format BIL float32) --------------------
// Renvoie un objet dem (cf. compute.makeDem). width/height <= 2048.
export async function fetchDem(lat, lon, radiusM, resM, layer = MNT_LAYER) {
  const mLon = M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);
  const dlat = radiusM / M_PER_DEG_LAT;
  const dlon = radiusM / mLon;
  const latN = lat + dlat, latS = lat - dlat;
  const lonW = lon - dlon, lonE = lon + dlon;
  const w = Math.min(2048, Math.max(2, Math.round(2 * radiusM / resM)));
  const h = w;

  const params = new URLSearchParams({
    SERVICE: "WMS", VERSION: "1.3.0", REQUEST: "GetMap",
    LAYERS: layer, STYLES: "", CRS: "EPSG:4326",
    BBOX: `${latS},${lonW},${latN},${lonE}`,   // WMS 1.3.0 EPSG:4326 -> lat,lon
    WIDTH: w, HEIGHT: h, FORMAT: "image/x-bil;bits=32",
  });
  const resp = await fetch(`${WMS}?${params}`);
  if (!resp.ok) throw new Error(`WMS ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const z = new Float32Array(buf);            // little-endian (BIL <f4)
  if (z.length !== w * h) {
    throw new Error(`MNT inattendu : ${z.length} != ${w * h}`);
  }
  // nettoyage no-data (pas de terrain < 0 m ici)
  for (let i = 0; i < z.length; i++) {
    if (z[i] < 0 || z[i] > 4000) z[i] = NaN;
  }
  return makeDem(z, w, h, latN, latS, lonW, lonE);
}

// --- orthophoto calee sur l'emprise d'un MNT (texture pour la 3D) ---------
export async function fetchOrthoForDem(dem, px = 1024) {
  const params = new URLSearchParams({
    SERVICE: "WMS", VERSION: "1.3.0", REQUEST: "GetMap",
    LAYERS: "HR.ORTHOIMAGERY.ORTHOPHOTOS", STYLES: "", CRS: "EPSG:4326",
    BBOX: `${dem.latS},${dem.lonW},${dem.latN},${dem.lonE}`,
    WIDTH: px, HEIGHT: px, FORMAT: "image/jpeg",
  });
  const resp = await fetch(`${WMS}?${params}`);
  if (!resp.ok) throw new Error(`Ortho WMS ${resp.status}`);
  return await createImageBitmap(await resp.blob());
}

// --- batiments BD TOPO (emprise + hauteur reelle) -------------------------
// Renvoie [{ring:[[lon,lat],...], height}]
export async function fetchBuildings(lat, lon, radiusM) {
  const mLon = M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);
  const dlat = radiusM / M_PER_DEG_LAT, dlon = radiusM / mLon;
  const bbox = `${lat - dlat},${lon - dlon},${lat + dlat},${lon + dlon}`;
  let feats = [], start = 0;
  while (true) {
    const params = new URLSearchParams({
      SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature",
      TYPENAMES: "BDTOPO_V3:batiment", SRSNAME: "EPSG:4326",
      BBOX: bbox, OUTPUTFORMAT: "application/json",
      COUNT: 1000, STARTINDEX: start,
    });
    const r = await fetch(`${WFS}?${params}`);
    if (!r.ok) throw new Error(`WFS ${r.status}`);
    const d = await r.json();
    const got = d.features || [];
    feats = feats.concat(got);
    start += got.length;
    if (got.length < 1000 || start >= (d.numberMatched ?? start)) break;
  }
  const out = [];
  for (const ft of feats) {
    const g = ft.geometry || {};
    let height = parseFloat(ft.properties && ft.properties.hauteur);
    if (!(height > 0.5 && height < 300)) height = 6.0;     // defaut
    let polys = null;
    if (g.type === "Polygon") polys = [g.coordinates];
    else if (g.type === "MultiPolygon") polys = g.coordinates;
    else continue;
    for (const poly of polys) {
      if (poly && poly[0] && poly[0].length >= 4) {
        out.push({ ring: poly[0], height });
      }
    }
  }
  return out;
}

// --- parcelles cadastrales -> liste d'anneaux exterieurs (lon,lat) --------
export async function fetchParcels(lat, lon, radiusM) {
  const mLon = M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);
  const dlat = radiusM / M_PER_DEG_LAT, dlon = radiusM / mLon;
  const bbox = `${lat - dlat},${lon - dlon},${lat + dlat},${lon + dlon}`;
  let feats = [], start = 0;
  while (true) {
    const params = new URLSearchParams({
      SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature",
      TYPENAMES: "CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle",
      SRSNAME: "EPSG:4326", BBOX: bbox, OUTPUTFORMAT: "application/json",
      COUNT: 1000, STARTINDEX: start,
    });
    const r = await fetch(`${WFS}?${params}`);
    if (!r.ok) throw new Error(`WFS parcelles ${r.status}`);
    const d = await r.json();
    const got = d.features || [];
    feats = feats.concat(got);
    start += got.length;
    if (got.length < 1000 || start >= (d.numberMatched ?? start)) break;
  }
  const rings = [];
  for (const ft of feats) {
    const g = ft.geometry || {};
    let polys = null;
    if (g.type === "Polygon") polys = [g.coordinates];
    else if (g.type === "MultiPolygon") polys = g.coordinates;
    else continue;
    for (const poly of polys) {
      if (poly && poly[0] && poly[0].length >= 4) rings.push(poly[0]);
    }
  }
  return rings;
}
