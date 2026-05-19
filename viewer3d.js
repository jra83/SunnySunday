// viewer3d.js — vue 3D : terrain (orthophoto + ombre portee a CONTRASTE
// CONSTANT, lisible quelle que soit la hauteur du soleil) + batiments
// extrudes avec ombrage GPU (ombres sur les murs) + parcelles cadastrales.
// Un fondu gere la tombee de la nuit sans faire disparaitre la limite d'ombre.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  fetchDem, fetchOrthoForDem, fetchBuildings, fetchParcels,
} from "./ign.js";
import {
  smoothDem, sampleDem, castShadow, burnBuildings, solarPosition,
  utcOffset, M_PER_DEG_LAT, sunTrack, horizonAt,
} from "./compute.js";

const ZONE_R = 220, ZONE_RES = 2, ORTHO_PX = 2048;
// relief de contexte : une surface a maillage degressif jusqu'a 8 km
// autour de la zone detaillee. FAR3D_RES = pas du MNT de contexte.
const FAR3D_R = 8000, FAR3D_RES = 70;
const SHADOW_MAX = 700;
const SUN_BASE = 1.5, AMB_BASE = 0.5;     // eclairage GPU des batiments

let renderer, scene, camera, controls, sunLight, ambient;
let dem, demShadow, ortho, lat0, lon0, zmin;
let terrainCanvas, terrainCtx, terrainTex, orthoData;
let parcelGroup = null, pointMarker = null, sunArcGroup = null;
let onSunCb = null, started = false, farHorizon = null, farGridMat = null;
let farMeshGeom = null, farDemRef = null;

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export async function start3d(lat, lon, statusCb, onSun, farHor) {
  lat0 = lat; lon0 = lon; onSunCb = onSun; farHorizon = farHor || null;
  statusCb("Téléchargement du relief précis du terrain (pentes, vallons)...");
  dem = smoothDem(await fetchDem(lat, lon, ZONE_R, ZONE_RES), 2);
  statusCb("Téléchargement de la photo aérienne HD...");
  ortho = await fetchOrthoForDem(dem, ORTHO_PX);
  statusCb("Téléchargement des constructions du voisinage...");
  const buildings = await fetchBuildings(lat, lon, ZONE_R + 40);
  statusCb("Téléchargement des limites de parcelles...");
  const parcels = await fetchParcels(lat, lon, ZONE_R + 40);
  statusCb("Téléchargement du relief lointain : montagnes à l'horizon...");
  let farDem = null;
  try {
    farDem = smoothDem(await fetchDem(lat, lon, FAR3D_R, FAR3D_RES), 1);
  } catch (e) { /* relief lointain optionnel : on continue sans */ }
  statusCb("Construction de la maquette 3D...");
  demShadow = { ...dem, z: burnBuildings(dem, buildings) };
  buildScene(buildings, parcels, farDem);
  updateSun();
  statusCb(`Maquette 3D prête — ${buildings.length} bâtiments pris en compte.`);
  if (!started) {
    started = true;
    window.addEventListener("resize", onResize);
    document.getElementById("chkParcels").addEventListener("change", e => {
      if (parcelGroup) parcelGroup.visible = e.target.checked;
    });
    document.getElementById("chkPoint").addEventListener("change", e => {
      if (pointMarker) pointMarker.visible = e.target.checked;
    });
    document.getElementById("chkSun").addEventListener("change", e => {
      if (sunArcGroup) sunArcGroup.visible = e.target.checked;
    });
    animate();
  }
}

// libere la scene precedente : sans ca, enchainer plusieurs adresses
// accumule geometries/textures/controls sur le GPU -> contexte WebGL perdu
// (terrain blanc) + plusieurs OrbitControls actifs sur le meme canvas.
function disposeScene() {
  if (controls) { controls.dispose(); controls = null; }
  if (scene) {
    scene.traverse(o => {
      // les lumieres portent une shadow map (render target GPU volumineux)
      // que seul dispose() libere -> sinon elle fuit a chaque adresse.
      if (o.isLight) o.dispose();
      if (o.geometry) o.geometry.dispose();
      const m = o.material;
      if (m) for (const mat of (Array.isArray(m) ? m : [m])) {
        // libere toutes les textures du materiau (map, et autres slots)
        for (const v of Object.values(mat)) {
          if (v && v.isTexture) v.dispose();
        }
        mat.dispose();
      }
    });
    scene = null;
  }
  parcelGroup = pointMarker = sunArcGroup = farGridMat = null;
  farMeshGeom = farDemRef = null;
  sunLight = ambient = null;
}

function buildScene(buildings, parcels, farDem) {
  disposeScene();
  const cont = document.getElementById("three");
  cont.innerHTML = "";
  const w = dem.w, h = dem.h;
  const resM = (dem.latN - dem.latS) * M_PER_DEG_LAT / h;
  const W = (w - 1) * resM, H = (h - 1) * resM;
  const sceneSize = Math.max(W, H);

  zmin = Infinity;
  for (let i = 0; i < dem.z.length; i++) {
    if (Number.isFinite(dem.z[i]) && dem.z[i] < zmin) zmin = dem.z[i];
  }
  if (!Number.isFinite(zmin)) zmin = 0;

  // orthophoto -> canvas (texture batiments) + ImageData (recomposition sol)
  const orthoCanvas = document.createElement("canvas");
  orthoCanvas.width = ORTHO_PX; orthoCanvas.height = ORTHO_PX;
  const oc = orthoCanvas.getContext("2d");
  oc.drawImage(ortho, 0, 0, ORTHO_PX, ORTHO_PX);
  orthoData = oc.getImageData(0, 0, ORTHO_PX, ORTHO_PX);
  const bldTex = new THREE.CanvasTexture(orthoCanvas);
  bldTex.colorSpace = THREE.SRGBColorSpace;

  terrainCanvas = document.createElement("canvas");
  terrainCanvas.width = ORTHO_PX; terrainCanvas.height = ORTHO_PX;
  terrainCtx = terrainCanvas.getContext("2d");
  terrainTex = new THREE.CanvasTexture(terrainCanvas);
  terrainTex.colorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color("#9fc6e8");
  // brume atmospherique : ne touche que le lointain (>4 km), fond la
  // bordure du relief de contexte dans le ciel, zone detaillee intacte.
  scene.fog = new THREE.Fog(0x9fc6e8, 4000, 9000);

  // --- terrain : ombre incrustee (contraste constant), non eclaire ---
  const pos = new Float32Array(w * h * 3);
  const uv = new Float32Array(w * h * 2);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const k = r * w + c;
      let zz = dem.z[k];
      if (!Number.isFinite(zz)) zz = zmin;
      pos[3 * k] = c * resM - W / 2;
      pos[3 * k + 1] = zz - zmin;
      pos[3 * k + 2] = r * resM - H / 2;
      uv[2 * k] = c / (w - 1);
      uv[2 * k + 1] = 1 - r / (h - 1);
    }
  }
  const idx = new Uint32Array((w - 1) * (h - 1) * 6);
  let n = 0;
  for (let r = 0; r < h - 1; r++) {
    for (let c = 0; c < w - 1; c++) {
      const a = r * w + c, b = a + 1, d = a + w, e = d + 1;
      idx[n++] = a; idx[n++] = d; idx[n++] = b;
      idx[n++] = b; idx[n++] = d; idx[n++] = e;
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geom.setIndex(new THREE.BufferAttribute(idx, 1));
  const terrain = new THREE.Mesh(geom,
    new THREE.MeshBasicMaterial({ map: terrainTex, side: THREE.DoubleSide }));
  terrain.castShadow = true;
  scene.add(terrain);

  // --- batiments : extrudes, textures, ombrage GPU (murs ombres) ---
  const latC = (dem.latN + dem.latS) / 2;
  const lonC = (dem.lonW + dem.lonE) / 2;
  const mLon = M_PER_DEG_LAT * Math.cos(latC * Math.PI / 180);
  const bldMat = new THREE.MeshLambertMaterial({ map: bldTex });
  for (const b of buildings) {
    let sx = 0, sy = 0;
    for (const [lo, la] of b.ring) { sx += lo; sy += la; }
    const zBase = sampleDem(dem, sy / b.ring.length, sx / b.ring.length);
    if (!Number.isFinite(zBase)) continue;
    const shape = new THREE.Shape();
    b.ring.forEach(([lo, la], i) => {
      const ex = (lo - lonC) * mLon, ny = (la - latC) * M_PER_DEG_LAT;
      i ? shape.lineTo(ex, ny) : shape.moveTo(ex, ny);
    });
    const g = new THREE.ExtrudeGeometry(shape,
      { depth: b.height, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    const pa = g.attributes.position;
    const ub = new Float32Array(pa.count * 2);
    for (let i = 0; i < pa.count; i++) {
      ub[2 * i] = (pa.getX(i) + W / 2) / W;
      ub[2 * i + 1] = 1 - (pa.getZ(i) + H / 2) / H;
    }
    g.setAttribute("uv", new THREE.BufferAttribute(ub, 2));
    const mesh = new THREE.Mesh(g, bldMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.y = (zBase - zmin) - 1.0;
    scene.add(mesh);
  }

  // --- parcelles cadastrales (limites drapees au sol) ---
  parcelGroup = new THREE.Group();
  const segs = [];
  for (const ring of parcels) {
    for (let k = 0; k < ring.length - 1; k++) {
      for (const idx2 of [k, k + 1]) {
        const [lo, la] = ring[idx2];
        const zg = sampleDem(dem, la, lo);
        segs.push((lo - lonC) * mLon,
                  (Number.isFinite(zg) ? zg - zmin : 0) + 1.0,
                  -(la - latC) * M_PER_DEG_LAT);
      }
    }
  }
  if (segs.length) {
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position",
      new THREE.BufferAttribute(new Float32Array(segs), 3));
    parcelGroup.add(new THREE.LineSegments(lg,
      new THREE.LineBasicMaterial({ color: 0xffe24a })));
  }
  parcelGroup.visible = document.getElementById("chkParcels").checked;
  scene.add(parcelGroup);

  // --- point selectionne sur la carte 2D, reporte en 3D ---
  // la scene est centree sur lat0/lon0 -> le point est a x=0, z=0.
  // marqueur discret : depasse de 5 m le volume le plus haut a cet endroit
  // (demShadow = sol + batiments incrustes) -> toit s'il y a un batiment,
  // sinon le sol.
  const gGround = sampleDem(dem, lat0, lon0);
  const gTop = sampleDem(demShadow, lat0, lon0);
  const yGround = Number.isFinite(gGround) ? gGround - zmin : 0;
  const yTop = Number.isFinite(gTop) ? gTop - zmin : yGround;
  const poleH = Math.max(5, yTop - yGround + 5);
  pointMarker = new THREE.Group();
  const markMat = new THREE.MeshBasicMaterial({ color: 0xffd23f });
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.3, poleH, 8), markMat);
  pole.position.y = poleH / 2;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(1.1, 16, 12), markMat);
  head.position.y = poleH;
  pointMarker.add(pole, head);
  pointMarker.position.set(0, yGround, 0);
  pointMarker.visible = document.getElementById("chkPoint").checked;
  scene.add(pointMarker);

  // --- courses solaires : trajectoires du soleil (dome au-dessus du point) ---
  sunArcGroup = new THREE.Group();
  const year = new Date().getFullYear();
  const arcR = sceneSize * 0.5;
  const tracks = [
    { m: 6,  d: 21, color: 0xe8a33d },   // solstice d'ete
    { m: 3,  d: 20, color: 0x4a90d9 },   // equinoxe
    { m: 12, d: 21, color: 0xc0504d },   // solstice d'hiver
  ];
  for (const t of tracks) {
    const pts = [];
    for (const p of sunTrack(lat0, lon0, year, t.m, t.d, 6)) {
      if (p.el <= 0) continue;
      const e = p.el * Math.PI / 180, a = p.az * Math.PI / 180;
      pts.push(new THREE.Vector3(
        arcR * Math.cos(e) * Math.sin(a),
        arcR * Math.sin(e),
        -arcR * Math.cos(e) * Math.cos(a)));
    }
    if (pts.length > 1) sunArcGroup.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: t.color })));
  }
  sunArcGroup.position.y = yGround;
  sunArcGroup.visible = document.getElementById("chkSun").checked;
  scene.add(sunArcGroup);

  // --- relief de contexte : une seule surface a maillage degressif ---
  // UNE surface continue (donc sans raccord interne) de la zone detaillee
  // jusqu'a 8 km, au maillage de plus en plus grossier vers l'exterieur.
  // Rendu maille type CAO : surface ombree + quadrillage par-dessus.
  // Le trou est decoupe pile a l'emprise de la zone 220 m, et son bord
  // echantillonne le MEME MNT fin que la grille detaillee -> jonction
  // propre (ecart sous le metre).
  farGridMat = null;
  if (farDem) {
    const hx = W / 2, hz = H / 2;            // demi-emprise de la grille fine
    // axe a maillage degressif : pas ~8 m pres du centre -> ~230 m a 8 km
    // (+ les 2 lignes du bord de l'emprise -> trou exact).
    const buildAxis = edge => {
      const set = new Set([Math.round(edge), Math.round(-edge), 0]);
      for (let v = 0; v < FAR3D_R; v += 8 + 0.028 * v) {
        set.add(Math.round(v)); set.add(-Math.round(v));
      }
      set.add(FAR3D_R); set.add(-FAR3D_R);
      return [...set].sort((p, q) => p - q);
    };
    const xs = buildAxis(hx), zs = buildAxis(hz);
    const nx = xs.length, nz = zs.length;
    const pos = new Float32Array(nx * nz * 3);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = xs[i], z = zs[j];
        const la = lat0 - z / M_PER_DEG_LAT, lo = lon0 + x / mLon;
        // MNT fin de la zone si couvert (-> jonction propre au bord du
        // trou), sinon MNT de contexte 8 km.
        let zz = sampleDem(dem, la, lo);
        if (!Number.isFinite(zz)) zz = sampleDem(farDem, la, lo);
        const k = j * nx + i;
        pos[3 * k] = x;
        pos[3 * k + 1] = (Number.isFinite(zz) ? zz : zmin) - zmin;
        pos[3 * k + 2] = z;
      }
    }
    // surface pleine : on saute les cellules entierement dans l'emprise
    const tri = [];
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        if (xs[i] >= -hx && xs[i + 1] <= hx
            && zs[j] >= -hz && zs[j + 1] <= hz) continue;
        const a = j * nx + i, b = a + 1, d2 = a + nx, e2 = d2 + 1;
        tri.push(a, d2, b, b, d2, e2);
      }
    }
    const sgeom = new THREE.BufferGeometry();
    sgeom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    // couleur par sommet : porte l'ombre du relief lointain (cf. updateSun)
    sgeom.setAttribute("color",
      new THREE.BufferAttribute(new Float32Array(nx * nz * 3).fill(1), 3));
    sgeom.setIndex(tri);
    sgeom.computeVertexNormals();
    const farMesh = new THREE.Mesh(sgeom, new THREE.MeshLambertMaterial({
      color: 0x6b745a, vertexColors: true, polygonOffset: true,
      polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));   // quadrillage net
    farMesh.position.y = -1;      // tres legerement sous la grille fine
    scene.add(farMesh);
    farMeshGeom = sgeom;          // pour l'ombre portee recalculee a chaque
    farDemRef = farDem;           // mouvement du soleil

    // quadrillage par-dessus : lignes qui epousent le relief
    const seg = [];
    const put = k => seg.push(pos[3 * k], pos[3 * k + 1], pos[3 * k + 2]);
    for (let j = 0; j < nz; j++) {            // lignes Est-Ouest
      for (let i = 0; i < nx - 1; i++) {
        if (xs[i] >= -hx && xs[i + 1] <= hx
            && zs[j] > -hz && zs[j] < hz) continue;
        put(j * nx + i); put(j * nx + i + 1);
      }
    }
    for (let i = 0; i < nx; i++) {            // lignes Nord-Sud
      for (let j = 0; j < nz - 1; j++) {
        if (zs[j] >= -hz && zs[j + 1] <= hz
            && xs[i] > -hx && xs[i] < hx) continue;
        put(i + j * nx); put(i + (j + 1) * nx);
      }
    }
    const lgeom = new THREE.BufferGeometry();
    lgeom.setAttribute("position",
      new THREE.BufferAttribute(new Float32Array(seg), 3));
    farGridMat = new THREE.LineBasicMaterial({ color: 0xd8dcc8 });
    const farGrid = new THREE.LineSegments(lgeom, farGridMat);
    farGrid.position.y = -1;
    scene.add(farGrid);
  }

  // --- lumieres (pour les batiments) ---
  ambient = new THREE.AmbientLight(0xbcd0e8, AMB_BASE);
  scene.add(ambient);
  sunLight = new THREE.DirectionalLight(0xffffff, SUN_BASE);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(4096, 4096);   // 8192 saturait la memoire GPU
  const d = sceneSize * 0.72;
  const sc = sunLight.shadow.camera;
  sc.left = -d; sc.right = d; sc.top = d; sc.bottom = -d;
  sc.near = 1; sc.far = sceneSize * 6;
  sunLight.shadow.bias = -0.0006;
  sunLight.shadow.normalBias = 0.6;
  sunLight.shadow.radius = 3;
  scene.add(sunLight);
  scene.add(sunLight.target);
  scene.userData.sceneSize = sceneSize;

  // --- rendu + camera ---
  const cw = cont.clientWidth || 820, ch = cont.clientHeight || 460;
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // sans preventDefault, une perte de contexte WebGL est definitive et
    // le navigateur finit par bloquer toute creation de nouveau contexte.
    renderer.domElement.addEventListener("webglcontextlost",
      e => e.preventDefault(), false);
  }
  renderer.setSize(cw, ch);
  cont.appendChild(renderer.domElement);
  // plan lointain etendu pour englober le relief de contexte (8 km)
  camera = new THREE.PerspectiveCamera(50, cw / ch, 2, 20000);
  camera.position.set(0, H * 0.8, H * 1.0);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.update();
}

function onResize() {
  if (!renderer || !camera) return;
  const cont = document.getElementById("three");
  const cw = cont.clientWidth || 820, ch = cont.clientHeight || 460;
  renderer.setSize(cw, ch);
  camera.aspect = cw / ch;
  camera.updateProjectionMatrix();
}

function dayToDate(doy) {
  const d = new Date(Date.UTC(new Date().getFullYear(), 0, 1));
  d.setUTCDate(doy);
  return d;
}

export function updateSun() {
  if (!dem || !sunLight) return;
  const hour = parseFloat(document.getElementById("s_hour").value);
  const doy = parseInt(document.getElementById("s_day").value);
  const date = dayToDate(doy);
  const off = utcOffset(date.getUTCMonth() + 1);
  const mins = Math.round(hour * 60);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(),
    date.getUTCDate(), 0, mins - off * 60));
  const sun = solarPosition(lat0, lon0, utc);

  const el = sun.el;
  // le soleil est-il masque par un relief lointain (au-dela de la zone
  // detaillee de 220 m, jusqu'a 25 km) ? blockFactor : 1 = masque,
  // 0 = degage, avec une transition douce de ~1 deg autour de l'horizon.
  const reliefBlock = farHorizon ? horizonAt(sun.az, farHorizon) : -90;
  const blockFactor = smoothstep(-0.5, 0.5, reliefBlock - el);
  // luminosite du sol selon l'heure : 1 a midi, plancher 0.34 (la demarcation
  // d'ombre reste donc visible meme la nuit)
  const dayBright = 0.34 + 0.66 * smoothstep(-4, 8, el);
  // intensite du soleil direct : annulee si masque par le relief lointain
  const sunUp = smoothstep(-1, 5, el) * (1 - blockFactor);
  // coloration de la lumiere selon l'heure
  let tr, tg, tb;
  if (el >= 0) {
    const t = Math.min(1, el / 20);             // bas = chaud, haut = blanc
    tr = 1.0; tg = 0.62 + 0.36 * t; tb = 0.36 + 0.58 * t;
  } else {
    const t = Math.min(1, -el / 4);             // crepuscule -> nuit froide
    tr = 1.0 - 0.32 * t; tg = 0.62 + 0.16 * t; tb = 0.36 + 0.62 * t;
  }

  // --- terrain : ombre, contraste constant, coloration horaire ---
  // echantillonnage bilineaire : enleve l'escalier de pixels sur le BORD
  // de l'ombre, sans flouter l'ombre elle-meme.
  const w = dem.w, h = dem.h, P = ORTHO_PX;
  const sh = castShadow(demShadow, sun.az, Math.max(0.01, el), SHADOW_MAX);
  const out = terrainCtx.createImageData(P, P);
  const src = orthoData.data, dst = out.data;
  for (let y = 0; y < P; y++) {
    const gy = (y + 0.5) * h / P - 0.5;
    const r0 = Math.max(0, Math.min(h - 2, Math.floor(gy)));
    const fr = Math.min(1, Math.max(0, gy - r0));
    for (let x = 0; x < P; x++) {
      const gx = (x + 0.5) * w / P - 0.5;
      const c0 = Math.max(0, Math.min(w - 2, Math.floor(gx)));
      const fc = Math.min(1, Math.max(0, gx - c0));
      const s0 = (sh[r0 * w + c0] * (1 - fc) + sh[r0 * w + c0 + 1] * fc) * (1 - fr)
        + (sh[(r0 + 1) * w + c0] * (1 - fc) + sh[(r0 + 1) * w + c0 + 1] * fc) * fr;
      // relief lointain : bascule tout le sol a l'ombre quand il masque
      const s = s0 + (0.32 - s0) * blockFactor;
      const L = Math.min(1, Math.max(0, (s - 0.32) / 0.68));   // 0=ombre 1=soleil
      const f = dayBright * (0.34 + 0.66 * L);                 // contraste constant
      const i = (y * P + x) * 4;
      dst[i]     = src[i]     * f * tr;
      dst[i + 1] = src[i + 1] * f * tg;
      dst[i + 2] = src[i + 2] * f * tb;
      dst[i + 3] = 255;
    }
  }
  terrainCtx.putImageData(out, 0, 0);
  terrainTex.needsUpdate = true;

  // --- batiments : soleil directionnel (ombrage GPU des murs) ---
  if (el > 0) {
    const e = el * Math.PI / 180, az = sun.az * Math.PI / 180;
    const dir = new THREE.Vector3(
      Math.cos(e) * Math.sin(az), Math.sin(e), -Math.cos(e) * Math.cos(az));
    sunLight.position.copy(dir.multiplyScalar(scene.userData.sceneSize * 2.2));
    sunLight.target.position.set(0, 0, 0);
    sunLight.target.updateMatrixWorld();
  }
  sunLight.color.setRGB(tr, tg, tb);            // soleil teinte selon l'heure
  sunLight.intensity = SUN_BASE * sunUp;
  ambient.intensity = AMB_BASE * dayBright;
  if (farGridMat) {                             // quadrillage du relief lointain
    const gb = 0.4 + 0.6 * dayBright;
    farGridMat.color.setRGB(0.85 * gb, 0.86 * gb, 0.78 * gb);
  }

  // --- relief de contexte : ombre portee (cretes -> vallees) ---
  // marche d'ombrage sur le MNT de contexte (8 km), pas assez regulier
  // (growth eleve) ; le resultat teinte les sommets de la surface.
  if (farMeshGeom && farDemRef) {
    const mLon = M_PER_DEG_LAT * Math.cos(lat0 * Math.PI / 180);
    const shf = castShadow(farDemRef, sun.az, Math.max(0.01, el), 8000, 1000);
    const shDem = { ...farDemRef, z: shf };
    const fp = farMeshGeom.attributes.position;
    const fcol = farMeshGeom.attributes.color;
    for (let v = 0; v < fp.count; v++) {
      const s = sampleDem(shDem,
        lat0 - fp.getZ(v) / M_PER_DEG_LAT, lon0 + fp.getX(v) / mLon);
      const L = Number.isFinite(s)
        ? Math.min(1, Math.max(0, (s - 0.32) / 0.68)) : 1;
      const c = 0.4 + 0.6 * L;                  // 0.4 a l'ombre, 1 au soleil
      fcol.setXYZ(v, c, c, c);
    }
    fcol.needsUpdate = true;
  }

  // ciel : bleu le jour -> chaud bas -> sombre la nuit
  const sky = new THREE.Color(0xe6b282).lerp(
    new THREE.Color(0x9fc6e8), Math.min(1, Math.max(0, el) / 15));
  scene.background.setHex(0x10141c).lerp(sky, dayBright);
  if (scene.fog) scene.fog.color.copy(scene.background);  // brume = ciel

  const hh = Math.floor(mins / 60), mm = mins % 60;
  document.getElementById("v_hour").textContent =
    hh + "h" + String(mm).padStart(2, "0");
  document.getElementById("v_day").textContent =
    String(date.getUTCDate()).padStart(2, "0") + "/" +
    String(date.getUTCMonth() + 1).padStart(2, "0");
  document.getElementById("sun3d").textContent =
    `Soleil : azimut ${sun.az.toFixed(0)}°, hauteur ${sun.el.toFixed(0)}°`
    + (blockFactor > 0.5 && el > 0 ? " — masqué par le relief lointain" : "");
  if (onSunCb) onSunCb(sun.az, sun.el);
}

function animate() {
  requestAnimationFrame(animate);
  if (controls) controls.update();
  if (renderer && scene && camera) renderer.render(scene, camera);
}
