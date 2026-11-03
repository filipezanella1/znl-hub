// DWG Viewer — worker: lê DWG (libredwg), monta a cena 2D e converte versões (acadrust).
import { LibreDwg, Dwg_File_Type } from './lib/libredwg/dist/libredwg-web.js?v=3';

let lib = null, conv = null;
let DB = null, HMAP = null;           // banco aberto e mapa handle -> entidade
const base = new URL('./lib/', import.meta.url).href;

async function getLib() {
  if (!lib) lib = await LibreDwg.create(base + 'libredwg/wasm/');
  return lib;
}
async function getConv() {
  if (!conv) {
    const m = await import('./lib/dwgconv.js');
    await m.default({ module_or_path: base + 'dwgconv_bg.wasm' });
    conv = m;
  }
  return conv;
}

const post = (id, type, data, transfer) => self.postMessage({ id, type, ...data }, transfer || []);

function readDb(L, bytes) {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const d = L.dwg_read_data(ab, Dwg_File_Type.DWG);
  if (!d) throw new Error('Não foi possível ler o arquivo.');
  const db = L.convert(d);
  try { L.dwg_free(d); } catch (_) {}
  return db;
}

// ---------- cores ACI ----------
const ACI = (() => {
  const t = new Array(256).fill(0xffffff);
  const base9 = [0, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0];
  for (let i = 1; i <= 9; i++) t[i] = base9[i];
  const V = [255, 255, 165, 165, 127, 127, 76, 76, 38, 38];
  for (let i = 10; i <= 249; i++) {
    const h = (Math.floor(i / 10) - 1) * 15, j = i % 10, v = V[j];
    const hp = h / 60, x = 1 - Math.abs((hp % 2) - 1);
    let r, g, b;
    if (hp < 1) [r, g, b] = [1, x, 0]; else if (hp < 2) [r, g, b] = [x, 1, 0];
    else if (hp < 3) [r, g, b] = [0, 1, x]; else if (hp < 4) [r, g, b] = [0, x, 1];
    else if (hp < 5) [r, g, b] = [x, 0, 1]; else [r, g, b] = [1, 0, x];
    r *= v; g *= v; b *= v;
    if (j % 2) { r += (v - r) * 0.5; g += (v - g) * 0.5; b += (v - b) * 0.5; }
    t[i] = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  }
  const grays = [51, 80, 105, 130, 190, 255];
  for (let i = 250; i <= 255; i++) { const g = grays[i - 250]; t[i] = (g << 16) | (g << 8) | g; }
  return t;
})();
const WHITE7 = 0x1000000; // marcador da cor 7 (branco/preto conforme o fundo)

// ---------- cena ----------
class Scene {
  constructor() {
    this.co = [];          // coordenadas x,y (relativas à origem)
    this.pS = []; this.pN = []; this.pE = []; this.pC = []; this.pL = []; this.pF = []; this.pW = [];
    this.tx = [];          // textos
    this.snp = []; this.snK = []; this.snE = [];
    this.pts = [];         // pontos (POINT): x,y,c,l,e
    this.eH = []; this.eT = []; this.eL = []; this.eB = [];
  }
}

function affMul(A, B) { // A·B, matrizes [a,b,c,d,e,f]
  return [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
          A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
          A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
}
const I2 = [1, 0, 0, 1, 0, 0];
const flipM = [-1, 0, 0, 1, 0, 0];
const isFlip = e => e && e.extrusionDirection && e.extrusionDirection.z < -0.5;

function build(db, spaceHandle) {
  const S = new Scene();
  const layers = db.tables.LAYER.entries.map(l => {
    let c = WHITE7;
    const ci = Math.abs(l.colorIndex | 0);
    if (ci >= 1 && ci <= 255) c = ci === 7 ? WHITE7 : ACI[ci];
    else if (typeof l.color === 'number') c = l.color & 0xffffff;
    return { name: l.name, handle: l.handle, color: c, aci: l.colorIndex, off: !!l.off || l.colorIndex < 0, frozen: !!l.frozen, locked: !!l.locked, count: 0, lineType: l.lineType || '' };
  });
  const LI = new Map(layers.map((l, i) => [l.name, i]));
  const blocks = new Map();
  const paperVps = paperViewports(db);
  const blocksH = new Map();
  for (const b of db.tables.BLOCK_RECORD.entries) { if (!blocks.has(b.name)) blocks.set(b.name, b); blocksH.set(b.handle, b); }
  const blockOf = e => (e.blockHandle && blocksH.get(e.blockHandle)) || blocks.get(e.name);
  const layerIdx = name => { let i = LI.get(name); if (i === undefined) { i = layers.length; layers.push({ name, color: WHITE7, off: false, frozen: false, count: 0 }); LI.set(name, i); } return i; };

  // extensão para tesselação adaptativa
  const ext = db.header && db.header.EXTMIN && db.header.EXTMAX ? Math.max(db.header.EXTMAX.x - db.header.EXTMIN.x, db.header.EXTMAX.y - db.header.EXTMIN.y) : 0;
  const tol = isFinite(ext) && ext > 0 && ext < 1e9 ? ext / 20000 : 0.001;

  let O = null; // origem (definida pelo primeiro ponto; depois recentralizamos no main)
  let curE = 0, curC = 0, curL = 0, curW = 0;
  let poly = null;

  const begin = () => { poly = S.co.length; };
  const P = (M, x, y) => {
    const X = M[0] * x + M[2] * y + M[4], Y = M[1] * x + M[3] * y + M[5];
    if (!O) O = [Math.round(X), Math.round(Y)];
    S.co.push(X - O[0], Y - O[1]);
  };
  const end = (flags = 0) => {
    const n = (S.co.length - poly) / 2;
    if (n >= 2 || (flags & 4)) { S.pS.push(poly / 2); S.pN.push(n); S.pE.push(curE); S.pC.push(curC); S.pL.push(curL); S.pF.push(flags); S.pW.push(curW); }
    else S.co.length = poly;
  };
  const snap = (M, x, y, k) => {
    const X = M[0] * x + M[2] * y + M[4], Y = M[1] * x + M[3] * y + M[5];
    if (!O) O = [Math.round(X), Math.round(Y)];
    S.snp.push(X - O[0], Y - O[1]); S.snK.push(k); S.snE.push(curE);
  };
  // k: 1 extremidade, 2 meio, 3 centro, 4 nó, 5 inserção, 6 quadrante
  const segsFor = (r, sweep) => Math.max(4, Math.min(512, Math.ceil(Math.abs(sweep) / (2 * Math.acos(Math.max(-1, 1 - tol / Math.max(r, 1e-9)))) )));
  const arcPts = (M, cx, cy, r, a0, a1, rx = r, rot = 0) => { // a0->a1 ccw
    let sw = a1 - a0; while (sw <= 0) sw += Math.PI * 2;
    const n = segsFor(Math.max(r, rx), sw);
    const cr = Math.cos(rot), sr = Math.sin(rot);
    for (let i = 0; i <= n; i++) {
      const a = a0 + sw * i / n, u = rx * Math.cos(a), v = r * Math.sin(a);
      P(M, cx + u * cr - v * sr, cy + u * sr + v * cr);
    }
  };
  const bulgeSeg = (M, x1, y1, x2, y2, b) => { // adiciona pontos intermediários (sem o inicial, com o final)
    if (!b) { P(M, x2, y2); return; }
    const th = 4 * Math.atan(b), dx = x2 - x1, dy = y2 - y1, c = Math.hypot(dx, dy);
    if (c < 1e-12) { P(M, x2, y2); return; }
    const r = c / (2 * Math.sin(th / 2)), h = r * Math.cos(th / 2);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const cx = mx - h * dy / c, cy = my + h * dx / c;
    const a0 = Math.atan2(y1 - cy, x1 - cx);
    const n = segsFor(Math.abs(r), th);
    for (let i = 1; i <= n; i++) { const a = a0 + th * i / n; P(M, cx + Math.abs(r) * Math.cos(a), cy + Math.abs(r) * Math.sin(a)); }
  };
  const nurbs = (M, deg, knots, cps, weights) => {
    const n = cps.length; if (n < 2) return;
    if (!knots || knots.length !== n + deg + 1) { for (const p of cps) P(M, p.x, p.y); return; }
    const t0 = knots[deg], t1 = knots[n], steps = Math.min(800, Math.max(16, n * 12));
    const w = i => (weights && weights[i]) || cps[i].weight || 1;
    for (let s = 0; s <= steps; s++) {
      let t = t0 + (t1 - t0) * s / steps; if (s === steps) t = t1 - 1e-10 * (t1 - t0 || 1);
      let k = deg; while (k < n - 1 && t >= knots[k + 1]) k++;
      const dx = [], dy = [], dw = [];
      for (let j = 0; j <= deg; j++) { const i = k - deg + j, ww = w(i); dx[j] = cps[i].x * ww; dy[j] = cps[i].y * ww; dw[j] = ww; }
      for (let r = 1; r <= deg; r++) for (let j = deg; j >= r; j--) {
        const i = k - deg + j, den = knots[i + deg - r + 1] - knots[i], a = den ? (t - knots[i]) / den : 0;
        dx[j] = (1 - a) * dx[j - 1] + a * dx[j]; dy[j] = (1 - a) * dy[j - 1] + a * dy[j]; dw[j] = (1 - a) * dw[j - 1] + a * dw[j];
      }
      P(M, dx[deg] / dw[deg], dy[deg] / dw[deg]);
    }
  };

  const colorOf = (e, byBlock) => {
    if (e.color !== undefined && e.color !== null && e.colorIndex !== 0 && e.colorIndex !== 256) return e.color & 0xffffff;
    const ci = e.colorIndex;
    if (ci === 0) return byBlock;
    if (ci >= 1 && ci <= 255) return ci === 7 ? WHITE7 : ACI[ci];
    return -1; // ByLayer
  };

  const clean = s => String(s == null ? '' : s)
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%%/g, '%').replace(/%%[uUoO]/g, '');
  const cleanM = s => clean(s)
    .replace(/\\[Pp]/g, '\n').replace(/\\~/g, ' ')
    .replace(/\\S([^;]*?)[\^#/]([^;]*?);/g, '$1/$2')
    .replace(/\\[ACcFfHhQqTtWwp][^;\\]*;/g, '').replace(/\\[LlOoKkNX]/g, '')
    .replace(/\\\\/g, '\u0001').replace(/[{}]/g, '').replace(/\u0001/g, '\\');

  const addText = (M, x, y, h, rotDeg, str, ha, va, wf, mtext, width, attach) => {
    if (!str || !(h > 0)) return;
    const X = M[0] * x + M[2] * y + M[4], Y = M[1] * x + M[3] * y + M[5];
    const sx = Math.hypot(M[0], M[1]), det = M[0] * M[3] - M[1] * M[2];
    const rot = Math.atan2(M[1], M[0]) + rotDeg * (det < 0 ? -1 : 1);
    if (!O) O = [Math.round(X), Math.round(Y)];
    S.tx.push({ x: X - O[0], y: Y - O[1], h: h * sx, r: rot, s: str, ha, va, wf: wf || 1, m: mtext ? 1 : 0, w: (width || 0) * sx, at: attach || 1, c: curC, l: curL, e: curE, mir: det < 0 ? 1 : 0 });
    snap(M, x, y, 5);
  };

  const drawEnt = (e, M, byBlock, parentLayer, depth, forceLayer = -1) => {
    if (!e || e.isVisible === false) return;
    const lay = forceLayer >= 0 ? forceLayer : (parentLayer !== null && (e.layer === '0' || !e.layer)) ? parentLayer : layerIdx(e.layer || '0');
    const fz = forceLayer >= 0 ? forceLayer : (layers[lay].frozen ? lay : -1); // camada congelada esconde todo o conteúdo do bloco
    const prevL = curL, prevC = curC;
    curL = lay;
    let c = colorOf(e, byBlock);
    curC = c; // -1 => cor da camada (resolvida no main)
    const Mo = isFlip(e) ? affMul(M, flipM) : M;
    try {
      switch (e.type) {
        case 'LINE': {
          begin(); P(M, e.startPoint.x, e.startPoint.y); P(M, e.endPoint.x, e.endPoint.y); end();
          snap(M, e.startPoint.x, e.startPoint.y, 1); snap(M, e.endPoint.x, e.endPoint.y, 1);
          snap(M, (e.startPoint.x + e.endPoint.x) / 2, (e.startPoint.y + e.endPoint.y) / 2, 2);
          break;
        }
        case 'LWPOLYLINE': case 'POLYLINE2D': {
          const v = e.vertices || []; if (!v.length) break;
          const closed = (e.flag & 1) || (e.flag & 512);
          const W = Mo;
          let wd = e.constantWidth || 0;
          if (!wd) { let mx = Math.max(e.startWidth || 0, e.endWidth || 0); for (const q of v) mx = Math.max(mx, q.startWidth || 0, q.endWidth || 0); wd = mx; }
          curW = wd * Math.hypot(M[0], M[1]);
          begin(); P(W, v[0].x, v[0].y);
          for (let i = 1; i < v.length; i++) bulgeSeg(W, v[i - 1].x, v[i - 1].y, v[i].x, v[i].y, v[i - 1].bulge || 0);
          if (closed && v.length > 2) bulgeSeg(W, v[v.length - 1].x, v[v.length - 1].y, v[0].x, v[0].y, v[v.length - 1].bulge || 0);
          end(closed ? 1 : 0); curW = 0;
          for (let i = 0; i < v.length; i++) {
            snap(W, v[i].x, v[i].y, 1);
            const j = i + 1 < v.length ? i + 1 : (closed ? 0 : -1);
            if (j >= 0 && !v[i].bulge) snap(W, (v[i].x + v[j].x) / 2, (v[i].y + v[j].y) / 2, 2);
          }
          break;
        }
        case 'POLYLINE3D': case 'POLYLINE_3D': {
          const v = (e.vertices || []).filter(p => !(p.flag & 16)); if (!v.length) break;
          begin(); for (const p of v) P(M, p.x, p.y); if (e.flag & 1) P(M, v[0].x, v[0].y); end(e.flag & 1 ? 1 : 0);
          for (const p of v) snap(M, p.x, p.y, 1);
          break;
        }
        case 'POLYLINE_MESH': case 'POLYLINE_PFACE': case 'POLYFACE_MESH': {
          const v = e.vertices || []; if (!v.length) break;
          begin(); for (const p of v) if (p.x !== undefined) P(M, p.x, p.y); end();
          break;
        }
        case 'CIRCLE': {
          const { x, y } = e.center, r = e.radius;
          begin(); arcPts(Mo, x, y, r, 0, Math.PI * 2); end(1);
          snap(Mo, x, y, 3); for (let q = 0; q < 4; q++) snap(Mo, x + r * Math.cos(q * Math.PI / 2), y + r * Math.sin(q * Math.PI / 2), 6);
          break;
        }
        case 'ARC': {
          const { x, y } = e.center, r = e.radius, a0 = e.startAngle, a1 = e.endAngle;
          begin(); arcPts(Mo, x, y, r, a0, a1); end();
          let sw = a1 - a0; while (sw <= 0) sw += Math.PI * 2;
          snap(Mo, x, y, 3); snap(Mo, x + r * Math.cos(a0), y + r * Math.sin(a0), 1); snap(Mo, x + r * Math.cos(a1), y + r * Math.sin(a1), 1);
          snap(Mo, x + r * Math.cos(a0 + sw / 2), y + r * Math.sin(a0 + sw / 2), 2);
          break;
        }
        case 'ELLIPSE': {
          const c0 = e.center, mj = e.majorAxisEndPoint, rx = Math.hypot(mj.x, mj.y), ry = rx * e.axisRatio, rot = Math.atan2(mj.y, mj.x);
          let a0 = e.startAngle || 0, a1 = e.endAngle || Math.PI * 2;
          const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-9 || (a0 === 0 && a1 === 0);
          if (full) { a0 = 0; a1 = Math.PI * 2; }
          const Me = e.extrusionDirection && e.extrusionDirection.z < -0.5 ? M : M; // elipse é WCS
          begin(); arcPts(Me, c0.x, c0.y, ry, a0, a1, rx, rot); end(full ? 1 : 0);
          snap(Me, c0.x, c0.y, 3);
          break;
        }
        case 'SPLINE': {
          begin();
          if (e.controlPoints && e.controlPoints.length >= 2) nurbs(M, e.degree || 3, e.knots, e.controlPoints, e.weights);
          else for (const p of e.fitPoints || []) P(M, p.x, p.y);
          end((e.flag & 1) ? 1 : 0);
          const cp = e.fitPoints && e.fitPoints.length ? e.fitPoints : e.controlPoints || [];
          if (cp.length) { snap(M, cp[0].x, cp[0].y, 1); snap(M, cp[cp.length - 1].x, cp[cp.length - 1].y, 1); }
          break;
        }
        case 'POINT': {
          const X = M[0] * e.position.x + M[2] * e.position.y + M[4], Y = M[1] * e.position.x + M[3] * e.position.y + M[5];
          if (!O) O = [Math.round(X), Math.round(Y)];
          S.pts.push(X - O[0], Y - O[1], curC, curL, curE);
          snap(M, e.position.x, e.position.y, 4);
          break;
        }
        case 'SOLID': case 'TRACE': {
          const c1 = e.corner1, c2 = e.corner2, c3 = e.corner3 || e.corner2, c4 = e.corner4 || c3;
          begin(); P(Mo, c1.x, c1.y); P(Mo, c2.x, c2.y); P(Mo, c4.x, c4.y); P(Mo, c3.x, c3.y); end(1 | 2);
          for (const c of [c1, c2, c3, c4]) snap(Mo, c.x, c.y, 1);
          break;
        }
        case '3DFACE': {
          const cs = [e.corner1, e.corner2, e.corner3, e.corner4 || e.corner3];
          begin(); for (const c of cs) P(M, c.x, c.y); end(1);
          for (const c of cs) snap(M, c.x, c.y, 1);
          break;
        }
        case 'HATCH': hatch(e, Mo); break;
        case 'TEXT': {
          const al = (e.halign || e.valign) && e.endPoint && (e.endPoint.x || e.endPoint.y);
          const p = al ? e.endPoint : e.startPoint;
          addText(Mo, p.x, p.y, e.textHeight, e.rotation || 0, clean(e.text), al ? e.halign : 0, al ? e.valign : 0, e.xScale, false);
          break;
        }
        case 'ATTRIB': {
          const t = e.text || {}; if (e.flags & 1) break;
          const al = (t.halign || t.valign) && t.endPoint && (t.endPoint.x || t.endPoint.y);
          const p = al ? t.endPoint : t.startPoint; if (!p) break;
          const Ma = isFlip(t) ? affMul(M, flipM) : M;
          addText(Ma, p.x, p.y, t.textHeight, t.rotation || 0, clean(t.text), al ? t.halign : 0, al ? t.valign : 0, t.xScale, false);
          break;
        }
        case 'MTEXT': {
          let rot = e.rotation || 0;
          if (e.direction && (e.direction.x || e.direction.y)) rot = Math.atan2(e.direction.y, e.direction.x);
          addText(M, e.insertionPoint.x, e.insertionPoint.y, e.textHeight, rot, cleanM(e.text), 0, 0, 1, true, e.rectWidth, e.attachmentPoint);
          break;
        }
        case 'INSERT': {
          const b = blockOf(e);
          if (b && b.entities && depth < 12) {
            const bp = b.basePoint || { x: 0, y: 0 };
            const sx = e.xScale || 1, sy = e.yScale || 1, r = e.rotation || 0;
            const cols = Math.max(1, e.columnCount || 1), rows = Math.max(1, e.rowCount || 1);
            const bb = curC === -1 ? -1 : curC;
            for (let ci = 0; ci < cols; ci++) for (let ri = 0; ri < rows; ri++) {
              const ox = ci * (e.columnSpacing || 0), oy = ri * (e.rowSpacing || 0);
              const cr = Math.cos(r), sr = Math.sin(r);
              const T = [cr * sx, sr * sx, -sr * sy, cr * sy, e.insertionPoint.x + ox * cr - oy * sr, e.insertionPoint.y + ox * sr + oy * cr];
              const Mi = affMul(affMul(Mo, T), [1, 0, 0, 1, -bp.x, -bp.y]);
              for (const be of b.entities) if (be.type !== 'ATTDEF') drawEnt(be, Mi, bb === -1 ? (layers[lay].color) : bb, lay, depth + 1, fz);
            }
          }
          snap(Mo, e.insertionPoint.x, e.insertionPoint.y, 5);
          for (const a of e.attribs || []) drawEnt(a, M, curC === -1 ? layers[lay].color : curC, lay, depth + 1, fz);
          break;
        }
        case 'DIMENSION': {
          const b = blockOf(e);
          if (b && b.entities && depth < 12) for (const be of b.entities) drawEnt(be, M, curC === -1 ? layers[lay].color : curC, lay, depth + 1, fz);
          else if (e.textPoint) addText(M, e.textPoint.x, e.textPoint.y, 2.5, 0, String(e.text || (e.measurement != null ? e.measurement.toFixed(2) : '')), 1, 2, 1, false);
          if (e.definitionPoint) snap(M, e.definitionPoint.x, e.definitionPoint.y, 4);
          if (e.subDefinitionPoint1) snap(M, e.subDefinitionPoint1.x, e.subDefinitionPoint1.y, 4);
          if (e.subDefinitionPoint2) snap(M, e.subDefinitionPoint2.x, e.subDefinitionPoint2.y, 4);
          break;
        }
        case 'LEADER': {
          const v = e.vertices || []; if (v.length < 2) break;
          begin(); for (const p of v) P(M, p.x, p.y); end();
          snap(M, v[0].x, v[0].y, 1);
          break;
        }
        case 'MULTILEADER': {
          for (const s of e.leaderSections || []) {
            const last = s.lastLeaderLinePoint;
            for (const ln of s.leaderLines || []) {
              const v = ln.vertices || []; if (!v.length && !last) continue;
              begin(); for (const p of v) P(M, p.x, p.y); if (last) P(M, last.x, last.y); end();
              if (v[0]) snap(M, v[0].x, v[0].y, 1);
            }
            if (last && e.doglegEnabled !== false && s.doglegVector) {
              const L2 = s.doglegLength || e.doglegLength || 0;
              begin(); P(M, last.x, last.y); P(M, last.x + s.doglegVector.x * L2, last.y + s.doglegVector.y * L2); end();
            }
          }
          if (e.textContent && e.textAnchor) {
            let rot = e.textRotation || 0;
            if (e.textDirection && (e.textDirection.x || e.textDirection.y)) rot = Math.atan2(e.textDirection.y, e.textDirection.x);
            addText(M, e.textAnchor.x, e.textAnchor.y, e.textHeight || 2.5, rot, cleanM(e.textContent), 0, 0, 1, true, e.textWidth, e.textAttachmentPoint || 1);
          }
          if (e.hasBlock && e.blockContent) { /* bloco do multileader: ignorado */ }
          break;
        }
        case 'MLINE': {
          const vs = e.vertices || []; const nl = e.numberOfLines || (vs[0] && vs[0].lines ? vs[0].lines.length : 0);
          for (let li = 0; li < nl; li++) {
            begin();
            for (const v of vs) { const off = (v.lines && v.lines[li] && v.lines[li].segmentParams) ? v.lines[li].segmentParams[0] : 0; P(M, v.vertex.x + v.miterDirection.x * off, v.vertex.y + v.miterDirection.y * off); }
            end((e.flags & 2) ? 1 : 0);
          }
          for (const v of vs) snap(M, v.vertex.x, v.vertex.y, 1);
          break;
        }
        case 'XLINE': case 'RAY': {
          const p = e.firstPoint, d = e.unitDirection, L2 = Math.max(ext || 1000, 1000) * 50;
          begin(); P(M, e.type === 'RAY' ? p.x : p.x - d.x * L2, e.type === 'RAY' ? p.y : p.y - d.y * L2); P(M, p.x + d.x * L2, p.y + d.y * L2); end(8);
          snap(M, p.x, p.y, 4);
          break;
        }
        case 'IMAGE': case 'WIPEOUT': {
          const p = e.position, u = e.uPixel, v = e.vPixel, sz = e.imageSize || { x: 1, y: 1 };
          const cb = e.clippingBoundaryPath;
          if (e.type === 'WIPEOUT') { // máscara: preenche com a cor do fundo, sem contorno
            const save = curC; curC = -2;
            begin();
            if (cb && cb.length > 2) for (const q of cb) { const px = q.x + 0.5, py = 0.5 - q.y; P(M, p.x + u.x * px * sz.x + v.x * py * sz.y, p.y + u.y * px * sz.x + v.y * py * sz.y); }
            else { const ux = u.x * sz.x, uy = u.y * sz.x, vx = v.x * sz.y, vy = v.y * sz.y; P(M, p.x, p.y); P(M, p.x + ux, p.y + uy); P(M, p.x + ux + vx, p.y + uy + vy); P(M, p.x + vx, p.y + vy); }
            end(1 | 2);
            curC = save;
          } else {
            const ux = u.x * sz.x, uy = u.y * sz.x, vx = v.x * sz.y, vy = v.y * sz.y;
            begin(); P(M, p.x, p.y); P(M, p.x + ux, p.y + uy); P(M, p.x + ux + vx, p.y + uy + vy); P(M, p.x + vx, p.y + vy); end(1);
            snap(M, p.x, p.y, 1);
          }
          break;
        }
        case 'VIEWPORT': {
          if (e.viewportId === 1 || !e.width || paperVps.has(e.handle)) break;
          const c0 = e.viewportCenter, w = e.width / 2, h = e.height / 2;
          begin(); P(M, c0.x - w, c0.y - h); P(M, c0.x + w, c0.y - h); P(M, c0.x + w, c0.y + h); P(M, c0.x - w, c0.y + h); end(1);
          break;
        }
        case 'TOLERANCE': {
          if (e.insertionPoint) addText(M, e.insertionPoint.x, e.insertionPoint.y, 2.5, 0, cleanM(e.text).replace(/%%v/g, '|'), 0, 0, 1, true, 0, 1);
          break;
        }
        default: break;
      }
    } catch (err) { /* entidade com dados incompletos: ignora */ }
    curL = prevL; curC = prevC;
  };

  function hatch(e, M) {
    const loops = [], openLoops = [];
    for (const p of e.boundaryPaths || []) {
      const pts = []; const push = (x, y) => pts.push(x, y);
      if (p.vertices) {
        const v = p.vertices; if (!v.length) continue;
        const tmp = [];
        // tesselação local (sem transformar), depois aplicamos M
        tmp.push(v[0].x, v[0].y);
        for (let i = 1; i <= v.length; i++) {
          const a = v[i - 1], b = v[i % v.length];
          const bl = a.bulge || 0;
          if (!bl) { tmp.push(b.x, b.y); continue; }
          const th = 4 * Math.atan(bl), dx = b.x - a.x, dy = b.y - a.y, c = Math.hypot(dx, dy); if (c < 1e-12) continue;
          const r = c / (2 * Math.sin(th / 2)), h = r * Math.cos(th / 2), cx = (a.x + b.x) / 2 - h * dy / c, cy = (a.y + b.y) / 2 + h * dx / c, a0 = Math.atan2(a.y - cy, a.x - cx);
          const n = segsFor(Math.abs(r), th);
          for (let k = 1; k <= n; k++) { const an = a0 + th * k / n; tmp.push(cx + Math.abs(r) * Math.cos(an), cy + Math.abs(r) * Math.sin(an)); }
        }
        for (let i = 0; i < tmp.length; i += 2) push(tmp[i], tmp[i + 1]);
      } else {
        for (const ed of p.edges || []) {
          if (ed.type === 1) { const n = pts.length; if (!n || Math.abs(pts[n - 2] - ed.start.x) + Math.abs(pts[n - 1] - ed.start.y) > 1e-9) push(ed.start.x, ed.start.y); push(ed.end.x, ed.end.y); }
          else if (ed.type === 2) {
            let a0 = ed.startAngle, a1 = ed.endAngle; const ccw = !(ed.isCCW === false || ed.isCCW === 0);
            if (!ccw) { a0 = -a0; a1 = -a1; }
            let sw = a1 - a0; if (ccw) { while (sw <= 0) sw += 2 * Math.PI; } else { while (sw >= 0) sw -= 2 * Math.PI; }
            if (Math.abs(Math.abs(ed.endAngle - ed.startAngle) - 2 * Math.PI) < 1e-9) sw = ccw ? 2 * Math.PI : -2 * Math.PI;
            const n = segsFor(ed.radius, sw);
            for (let k = 0; k <= n; k++) { const an = a0 + sw * k / n; push(ed.center.x + ed.radius * Math.cos(an), ed.center.y + ed.radius * Math.sin(an)); }
          } else if (ed.type === 3) {
            const mj = ed.end, rx = Math.hypot(mj.x, mj.y), ry = rx * ed.lengthOfMinorAxis, rot = Math.atan2(mj.y, mj.x);
            let a0 = ed.startAngle, a1 = ed.endAngle; const ccw = !(ed.isCCW === false || ed.isCCW === 0);
            if (!ccw) { a0 = -a0; a1 = -a1; }
            let sw = a1 - a0; if (ccw) { while (sw <= 0) sw += 2 * Math.PI; } else { while (sw >= 0) sw -= 2 * Math.PI; }
            const n = segsFor(rx, sw), cr = Math.cos(rot), sr = Math.sin(rot);
            for (let k = 0; k <= n; k++) { const an = a0 + sw * k / n, u = rx * Math.cos(an), v = ry * Math.sin(an); push(ed.center.x + u * cr - v * sr, ed.center.y + u * sr + v * cr); }
          } else if (ed.type === 4) {
            const save = S.co.length; const OO = O;
            // avalia spline em coordenadas locais
            const loc = []; const fakeP = (x, y) => loc.push(x, y);
            const cps = ed.controlPoints || [];
            if (cps.length >= 2) {
              const deg = ed.degree || 3, knots = ed.knots, n = cps.length;
              if (knots && knots.length === n + deg + 1) {
                const steps = Math.min(400, n * 10), t0 = knots[deg], t1 = knots[n];
                for (let s = 0; s <= steps; s++) {
                  let t = t0 + (t1 - t0) * s / steps; if (s === steps) t = t1 - 1e-10 * (t1 - t0 || 1);
                  let k = deg; while (k < n - 1 && t >= knots[k + 1]) k++;
                  const dx = [], dy = [], dw = [];
                  for (let j = 0; j <= deg; j++) { const i = k - deg + j, ww = cps[i].weight || 1; dx[j] = cps[i].x * ww; dy[j] = cps[i].y * ww; dw[j] = ww; }
                  for (let r = 1; r <= deg; r++) for (let j = deg; j >= r; j--) { const i = k - deg + j, den = knots[i + deg - r + 1] - knots[i], a = den ? (t - knots[i]) / den : 0; dx[j] = (1 - a) * dx[j - 1] + a * dx[j]; dy[j] = (1 - a) * dy[j - 1] + a * dy[j]; dw[j] = (1 - a) * dw[j - 1] + a * dw[j]; }
                  fakeP(dx[deg] / dw[deg], dy[deg] / dw[deg]);
                }
              } else for (const q of cps) fakeP(q.x, q.y);
            } else for (const q of ed.fitDatum || []) fakeP(q.x, q.y);
            for (let i = 0; i < loc.length; i += 2) push(loc[i], loc[i + 1]);
            S.co.length = save; O = OO;
          }
        }
      }
      if (pts.length >= 6) { if (p.boundaryPathTypeFlag & 32) openLoops.push(pts); else loops.push(pts); } // 32: contorno aberto (não entra no preenchimento)
    }
    for (const L of openLoops) { begin(); for (let i = 0; i < L.length; i += 2) P(M, L[i], L[i + 1]); end(32); }
    if (!loops.length) return;
    const solid = e.solidFill === 1 || /^SOLID/i.test(e.patternName || '');
    // contornos
    for (const L of loops) {
      begin(); for (let i = 0; i < L.length; i += 2) P(M, L[i], L[i + 1]);
      if (solid) end(1 | 2 | 16); else end(1 | 32); // 16: fill de hatch (agrupa loops), 32: contorno de hatch
    }
    if (solid) { // marca grupo: os loops consecutivos deste hatch compõem um único preenchimento evenodd
      S.pF[S.pF.length - loops.length] |= 64; // início de grupo
      return;
    }
    // padrão: linhas recortadas pelo contorno (evenodd)
    const defs = e.definitionLines || [];
    if (!defs.length) return;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const L of loops) for (let i = 0; i < L.length; i += 2) { minx = Math.min(minx, L[i]); maxx = Math.max(maxx, L[i]); miny = Math.min(miny, L[i + 1]); maxy = Math.max(maxy, L[i + 1]); }
    const diag = Math.hypot(maxx - minx, maxy - miny);
    let budget = 6000;
    const out = [];
    for (const d of defs) {
      const ang = d.angle || 0, ca = Math.cos(ang), sa = Math.sin(ang);
      const off = d.offset || { x: 0, y: 0 };
      // espaçamento perpendicular
      const perp = -off.x * sa + off.y * ca, along = off.x * ca + off.y * sa;
      if (Math.abs(perp) < diag / 3000) continue;
      const bx = d.base ? d.base.x : 0, by = d.base ? d.base.y : 0;
      // coordenadas no sistema da família (u ao longo, v perpendicular)
      const toU = (x, y) => (x - bx) * ca + (y - by) * sa, toV = (x, y) => -(x - bx) * sa + (y - by) * ca;
      let vmin = Infinity, vmax = -Infinity;
      const segs = [];
      for (const L of loops) {
        const n = L.length / 2;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n, x1 = L[2 * i], y1 = L[2 * i + 1], x2 = L[2 * j], y2 = L[2 * j + 1];
          const u1 = toU(x1, y1), v1 = toV(x1, y1), u2 = toU(x2, y2), v2 = toV(x2, y2);
          segs.push(u1, v1, u2, v2); vmin = Math.min(vmin, v1, v2); vmax = Math.max(vmax, v1, v2);
        }
      }
      const p = Math.abs(perp);
      const k0 = Math.ceil(vmin / p), k1 = Math.floor(vmax / p);
      if (k1 - k0 > budget) { out.length = 0; budget = -1; break; }
      budget -= (k1 - k0 + 1);
      const dash = d.dashLengths || []; const dl = dash.reduce((s, x) => s + Math.abs(x), 0);
      for (let k = k0; k <= k1; k++) {
        const v = k * p, xs = [];
        for (let i = 0; i < segs.length; i += 4) {
          const v1 = segs[i + 1], v2 = segs[i + 3];
          if ((v1 <= v && v2 > v) || (v2 <= v && v1 > v)) xs.push(segs[i] + (v - v1) * (segs[i + 2] - segs[i]) / (v2 - v1));
        }
        xs.sort((a, b) => a - b);
        const shift = (k * along * (perp < 0 ? -1 : 1)) ;
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const ua = xs[i], ub = xs[i + 1];
          if (!dash.length || dl <= 0) out.push(ua, v, ub, v);
          else {
            // fase do tracejado
            let u = Math.floor((ua - shift) / dl) * dl + shift, di = 0;
            let guard = 0;
            while (u < ub && guard++ < 4000) {
              const len = dash[di % dash.length]; const L2 = Math.abs(len);
              if (len >= 0) { const s0 = Math.max(u, ua), s1 = Math.min(u + Math.max(L2, 0), ub); if (L2 === 0) { if (u >= ua) out.push(u, v, u + dl * 1e-3, v); } else if (s1 > s0) out.push(s0, v, s1, v); }
              u += L2; di++;
            }
          }
        }
      }
      // volta para XY
      for (let i = 0; i < out.length; i += 4) {
        const u1 = out[i], v1 = out[i + 1], u2 = out[i + 2], v2 = out[i + 3];
        begin();
        P(M, bx + u1 * ca - v1 * sa, by + u1 * sa + v1 * ca);
        P(M, bx + u2 * ca - v2 * sa, by + u2 * sa + v2 * ca);
        end(128); // 128: linha de padrão (não entra em snap)
      }
      out.length = 0;
    }
    if (budget < 0) { // padrão denso demais: preenchimento leve
      for (const L of loops) { begin(); for (let i = 0; i < L.length; i += 2) P(M, L[i], L[i + 1]); end(1 | 2 | 16 | 256); }
      S.pF[S.pF.length - loops.length] |= 64;
    }
  }

  // entidades do espaço escolhido
  const space = db.tables.BLOCK_RECORD.entries.find(b => b.handle === spaceHandle);
  const list = space && space.entities && space.entities.length ? space.entities
    : db.entities.filter(e => e.ownerBlockRecordSoftId === spaceHandle);
  for (const e of list) {
    const idx = S.eH.length;
    S.eH.push(e.handle); S.eT.push(e.type); const li = layerIdx(e.layer || '0'); S.eL.push(li); layers[li].count++;
    curE = idx;
    const c0 = S.co.length, t0 = S.tx.length, p0 = S.pts.length;
    drawEnt(e, I2, WHITE7, null, 0);
    // caixa da entidade
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let i = c0; i < S.co.length; i += 2) { const x = S.co[i], y = S.co[i + 1]; if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; }
    for (let i = t0; i < S.tx.length; i++) { const t = S.tx[i]; a = Math.min(a, t.x); c = Math.max(c, t.x + t.h * (t.s.length * 0.6)); b = Math.min(b, t.y); d = Math.max(d, t.y + t.h); }
    for (let i = p0; i < S.pts.length; i += 5) { a = Math.min(a, S.pts[i]); c = Math.max(c, S.pts[i]); b = Math.min(b, S.pts[i + 1]); d = Math.max(d, S.pts[i + 1]); }
    if (e.type === 'XLINE' || e.type === 'RAY') { a = b = Infinity; c = d = -Infinity; }
    S.eB.push(a, b, c, d);
  }
  return { S, layers, origin: O || [0, 0] };
}

function versionName(v) {
  return ({ AC1009: 'R11/R12', AC1012: 'R13', AC1014: 'R14', AC1015: 'AutoCAD 2000', AC1018: 'AutoCAD 2004', AC1021: 'AutoCAD 2007', AC1024: 'AutoCAD 2010', AC1027: 'AutoCAD 2013', AC1032: 'AutoCAD 2018' })[v] || v;
}

function pack(res) {
  const { S } = res;
  const f64 = a => new Float64Array(a), u32 = a => new Uint32Array(a);
  const g = {
    co: f64(S.co), pS: u32(S.pS), pN: u32(S.pN), pE: u32(S.pE), pC: new Int32Array(S.pC), pL: u32(S.pL), pF: u32(S.pF), pW: f64(S.pW),
    snp: f64(S.snp), snK: new Uint8Array(S.snK), snE: u32(S.snE), pts: f64(S.pts), eB: f64(S.eB), eL: u32(S.eL)
  };
  const transfer = Object.values(g).map(a => a.buffer);
  return { geo: g, tx: S.tx, eH: S.eH, eT: S.eT, layers: res.layers, origin: res.origin, transfer };
}

function spaces(db) {
  const lay = (db.objects && db.objects.LAYOUT) || [];
  const brs = db.tables.BLOCK_RECORD.entries;
  const model = brs.find(b => /^\*model_space$/i.test(b.name));
  const out = [{ handle: model ? model.handle : '1F', name: 'Model', model: true }];
  const ls = lay.filter(l => l.layoutName !== 'Model').sort((a, b) => (a.tabOrder || 0) - (b.tabOrder || 0));
  for (const l of ls) {
    const br = brs.find(b => b.handle === l.paperSpaceTableId || b.layout === l.handle);
    if (br) out.push({ handle: br.handle, name: l.layoutName, vp: l.viewportId });
  }
  return out;
}

// A viewport "do papel" de cada layout é a primeira VIEWPORT do bloco do layout
// (o campo viewportId do LAYOUT guarda a última viewport ativa, não ela).
let PAPER_VPS = null, PAPER_DB = null;
function paperViewports(db) {
  if (PAPER_DB === db && PAPER_VPS) return PAPER_VPS;
  const out = new Set();
  for (const b of db.tables.BLOCK_RECORD.entries) {
    if (!/^\*paper_space/i.test(b.name)) continue;
    const list = (b.entities && b.entities.length) ? b.entities : db.entities.filter(e => e.ownerBlockRecordSoftId === b.handle);
    const v = list.find(e => e.type === 'VIEWPORT'); if (v) out.add(v.handle);
  }
  PAPER_DB = db; PAPER_VPS = out; return out;
}

// Janelas de viewport de um layout: como mapear o model space para o papel
function viewports(db, spaceHandle, origin) {
  const sp = spaces(db).find(x => x.handle === spaceHandle);
  if (!sp || sp.model) return [];
  const br = db.tables.BLOCK_RECORD.entries.find(b => b.handle === spaceHandle);
  const list = (br && br.entities && br.entities.length) ? br.entities : db.entities.filter(e => e.ownerBlockRecordSoftId === spaceHandle);
  const paperVps = paperViewports(db);
  const layerByHandle = new Map(db.tables.LAYER.entries.map(l => [String(l.handle).toUpperCase(), l.name]));
  const out = [];
  for (const v of list) {
    if (v.type !== 'VIEWPORT' || !v.width || !v.height || !v.viewHeight) continue;
    if (paperVps.has(v.handle)) continue;                 // a viewport do próprio papel
    if (v.isVisible === false) continue;
    const dir = v.viewDirection || { x: 0, y: 0, z: 1 };
    const plan = Math.abs(dir.x) < 1e-6 && Math.abs(dir.y) < 1e-6;
    const frozen = (v.frozenLayerIds || []).map(h => layerByHandle.get(String(h).toUpperCase())).filter(Boolean);
    const clipped = !!(v.statusBitFlags & 0x10000) && v.clippingBoundaryId && v.clippingBoundaryId !== '0';
    out.push({
      h: v.handle, cx: v.viewportCenter.x - origin[0], cy: v.viewportCenter.y - origin[1], w: v.width, ht: v.height,
      vx: v.displayCenter.x, vy: v.displayCenter.y, vh: v.viewHeight, tw: typeof v.viewTwistAngle === 'number' ? v.viewTwistAngle : 0,
      tx: v.targetPoint ? v.targetPoint.x : 0, ty: v.targetPoint ? v.targetPoint.y : 0, flipX: dir.z < 0,
      plan, frozen, clip: clipped ? String(v.clippingBoundaryId).toUpperCase() : null
    });
  }
  return out;
}

function cleanForInfo(e) {
  const o = {};
  for (const k of Object.keys(e)) {
    const v = e[k];
    if (k === 'xdata' || k === 'ownerDictionaryHardId' || k === 'bmpPreview') continue;
    if (Array.isArray(v) && v.length > 400) { o[k] = v.slice(0, 400); o[k + '__mais'] = v.length - 400; }
    else o[k] = v;
  }
  return o;
}

self.onmessage = async ev => {
  const { id, cmd } = ev.data;
  try {
    if (cmd === 'open') {
      let bytes = new Uint8Array(ev.data.bytes);
      const sig = String.fromCharCode(...bytes.slice(0, 6));
      let srcVer = /^AC\d{4}$/.test(sig) ? sig : 'DXF';
      if (srcVer === 'DXF') { // DXF: converte para DWG em memória para abrir
        post(id, 'progress', { msg: 'convertendo DXF…' });
        const C = await getConv();
        bytes = C.convert(bytes, 'AC1032', 'dwg');
      }
      post(id, 'progress', { msg: 'carregando leitor DWG…' });
      const L = await getLib();
      post(id, 'progress', { msg: 'lendo ' + versionName(srcVer) + '…' });
      DB = readDb(L, bytes);
      HMAP = new Map();
      for (const e of DB.entities) HMAP.set(e.handle, e);
      for (const b of DB.tables.BLOCK_RECORD.entries) for (const e of b.entities || []) if (!HMAP.has(e.handle)) HMAP.set(e.handle, e);
      const sp = spaces(DB);
      post(id, 'progress', { msg: 'montando desenho…' });
      const res = build(DB, sp[0].handle);
      const p = pack(res);
      const h = DB.header || {};
      post(id, 'scene', { ...p, transfer: undefined, version: srcVer, versionName: versionName(srcVer), spaces: sp, space: sp[0].handle,
        insunits: h.INSUNITS, nEnt: DB.entities.length, ltscale: h.LTSCALE }, p.transfer);
    } else if (cmd === 'space') {
      const res = build(DB, ev.data.handle);
      const p = pack(res);
      const vps = viewports(DB, ev.data.handle, res.origin);
      post(id, 'scene', { ...p, transfer: undefined, space: ev.data.handle, vps }, p.transfer);
    } else if (cmd === 'info') {
      const e = HMAP && HMAP.get(ev.data.handle);
      post(id, 'info', { ent: e ? cleanForInfo(e) : null });
    } else if (cmd === 'convert') {
      const bytes = new Uint8Array(ev.data.bytes);
      const C = await getConv();
      post(id, 'progress', { msg: 'convertendo…' });
      const t0 = performance.now();
      const out = C.convert(bytes, ev.data.target, ev.data.format);
      const ms = Math.round(performance.now() - t0);
      const removed = C.last_report ? C.last_report() : '';
      // conferência: relê o resultado com outro leitor (LibreDWG) e compara a contagem de entidades
      let check = null;
      if (ev.data.format === 'dwg') {
        try {
          post(id, 'progress', { msg: 'conferindo resultado…' });
          const L = await getLib();
          const srcSig = String.fromCharCode(...bytes.slice(0, 6));
          let n0 = null;
          if (/^AC\d{4}$/.test(srcSig)) { const d0 = readDb(L, bytes); n0 = count(d0); }
          const d1 = readDb(L, out);
          check = { before: n0, after: count(d1), version: String.fromCharCode(...out.slice(0, 6)) };
        } catch (e) { check = { error: String(e.message || e) }; }
      }
      post(id, 'converted', { out: out.buffer, ms, check, removed }, [out.buffer]);
    }
  } catch (e) {
    post(id, 'error', { msg: String((e && e.message) || e), stack: e && e.stack });
  }
};

function count(db) {
  let n = db.entities.length; const types = {};
  for (const e of db.entities) types[e.type] = (types[e.type] || 0) + 1;
  let inBlocks = 0; for (const b of db.tables.BLOCK_RECORD.entries) inBlocks += (b.entities || []).length;
  return { n, types, layers: db.tables.LAYER.entries.length, blocks: db.tables.BLOCK_RECORD.entries.length, inBlocks };
}
