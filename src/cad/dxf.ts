import { dimLine, len, lerp, normAngle, sub, type Pt, type Shape, type Vertex } from './geom';
import { mirrorAcross, transformShape, type Xform } from './ops';

/**
 * DXF in and out (ASCII).
 *
 * Import: LINE, ARC, CIRCLE, LWPOLYLINE, POLYLINE/VERTEX (2D, with bulges), SPLINE and ELLIPSE
 * (flattened to polylines within `tol`), and INSERT of blocks (nested, uniform scale, rotation).
 * Entities with an extrusion of (0, 0, −1), common from some CAD programs, are mirrored into
 * place. Units come from $INSUNITS when the file has it.
 * Export: R12 (AC1009), which every CAM/CAD program reads: LINE, ARC, CIRCLE, POLYLINE with
 * bulges; dimensions as lines and TEXT on their own layer.
 */

export interface DxfImport {
  shapes: { shape: Shape; layer: string }[];
  layers: string[];
  /** from $INSUNITS; null when the file doesn't say */
  units: 'mm' | 'in' | 'cm' | 'm' | 'ft' | null;
  /** factor to mm for those units (1 when unknown) */
  toMm: number;
  /** what was skipped and how often */
  skipped: Record<string, number>;
}

type Pair = [number, string];

function pairs(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) throw new Error(`not a DXF file (line ${i + 1})`);
    out.push([code, lines[i + 1].trim()]);
  }
  return out;
}

interface RawEntity {
  type: string;
  /** group code → values in order */
  g: Map<number, string[]>;
  /** pairs in file order (polyline vertices, spline points need the order) */
  list: Pair[];
  /** VERTEX children of a POLYLINE */
  verts?: RawEntity[];
}

const UNITS: Record<number, [DxfImport['units'], number]> = { 1: ['in', 25.4], 2: ['ft', 304.8], 4: ['mm', 1], 5: ['cm', 10], 6: ['m', 1000] };

/** splits a section's pairs into entities (code 0 starts each) */
function entities(ps: Pair[]): RawEntity[] {
  const out: RawEntity[] = [];
  let cur: RawEntity | null = null;
  for (const [c, v] of ps) {
    if (c === 0) {
      cur = { type: v, g: new Map(), list: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.list.push([c, v]);
    const a = cur.g.get(c);
    if (a) a.push(v);
    else cur.g.set(c, [v]);
  }
  // attach VERTEX entities to their POLYLINE
  const merged: RawEntity[] = [];
  let poly: RawEntity | null = null;
  for (const e of out) {
    if (e.type === 'POLYLINE') {
      poly = { ...e, verts: [] };
      merged.push(poly);
    } else if (e.type === 'VERTEX' && poly) poly.verts!.push(e);
    else if (e.type === 'SEQEND') poly = null;
    else merged.push(e);
  }
  return merged;
}

const f = (e: RawEntity, c: number, d = 0) => {
  const v = e.g.get(c)?.[0];
  const n = v === undefined ? d : parseFloat(v);
  return Number.isFinite(n) ? n : d;
};
const s = (e: RawEntity, c: number, d = '') => e.g.get(c)?.[0] ?? d;
const DEG = Math.PI / 180;

export function parseDxf(text: string, tol = 0.01): DxfImport {
  const ps = pairs(text);
  // sections
  const sections = new Map<string, Pair[]>();
  for (let i = 0; i < ps.length; i++) {
    if (ps[i][0] === 0 && ps[i][1] === 'SECTION' && ps[i + 1]?.[0] === 2) {
      const name = ps[i + 1][1];
      let j = i + 2;
      while (j < ps.length && !(ps[j][0] === 0 && ps[j][1] === 'ENDSEC')) j++;
      sections.set(name, ps.slice(i + 2, j));
      i = j;
    }
  }
  if (!sections.has('ENTITIES')) throw new Error('this DXF has no ENTITIES section');
  // header units
  let units: DxfImport['units'] = null, toMm = 1;
  const hdr = sections.get('HEADER') ?? [];
  for (let i = 0; i < hdr.length; i++)
    if (hdr[i][0] === 9 && hdr[i][1] === '$INSUNITS') {
      const u = UNITS[parseInt(hdr[i + 1]?.[1] ?? '0', 10)];
      if (u) [units, toMm] = u;
    }
  // blocks: name → base point and entities
  const blocks = new Map<string, { base: Pt; ents: RawEntity[] }>();
  const bl = sections.get('BLOCKS') ?? [];
  {
    let cur: { name: string; base: Pt; ps: Pair[] } | null = null;
    let inHeader = false;
    const head: Pair[] = [];
    for (const p of bl) {
      if (p[0] === 0 && p[1] === 'BLOCK') {
        cur = { name: '', base: { x: 0, y: 0 }, ps: [] };
        inHeader = true;
        head.length = 0;
        continue;
      }
      if (p[0] === 0 && p[1] === 'ENDBLK') {
        if (cur) blocks.set(cur.name, { base: cur.base, ents: entities(cur.ps) });
        cur = null;
        continue;
      }
      if (!cur) continue;
      if (inHeader && p[0] !== 0) {
        if (p[0] === 2) cur.name = p[1];
        if (p[0] === 10) cur.base.x = parseFloat(p[1]);
        if (p[0] === 20) cur.base.y = parseFloat(p[1]);
        continue;
      }
      inHeader = false;
      cur.ps.push(p);
    }
  }

  const out: DxfImport = { shapes: [], layers: [], units, toMm, skipped: {} };
  const layerSet = new Set<string>();
  const skip = (t: string) => (out.skipped[t] = (out.skipped[t] ?? 0) + 1);

  const emit = (sh: Shape | null, layer: string, m: Xform | null) => {
    if (!sh) return;
    const x = m ? transformShape(sh, m) : sh;
    layerSet.add(layer);
    out.shapes.push({ shape: x, layer });
  };

  const compose = (m: Xform, n: Xform): Xform => ({
    // m ∘ n: apply n first
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  });

  const walk = (ents: RawEntity[], m: Xform | null, depth: number, parentLayer: string | null) => {
    for (const e of ents) {
      let layer = s(e, 8, '0');
      // entities on layer 0 inside a block take the layer of the INSERT
      if (layer === '0' && parentLayer) layer = parentLayer;
      // extrusion (0,0,-1): the entity's own X runs the other way
      const flip = f(e, 230, 1) < 0 ? mirrorAcross({ x: 0, y: 0 }, Math.PI / 2) : null;
      const mm = flip ? (m ? compose(m, flip) : flip) : m;
      switch (e.type) {
        case 'LINE':
          emit({ kind: 'line', a: { x: f(e, 10), y: f(e, 20) }, b: { x: f(e, 11), y: f(e, 21) } }, layer, mm);
          break;
        case 'CIRCLE':
          emit({ kind: 'circle', c: { x: f(e, 10), y: f(e, 20) }, r: f(e, 40) }, layer, mm);
          break;
        case 'ARC':
          emit({ kind: 'arc', c: { x: f(e, 10), y: f(e, 20) }, r: f(e, 40), a0: normAngle(f(e, 50) * DEG), a1: normAngle(f(e, 51) * DEG) }, layer, mm);
          break;
        case 'LWPOLYLINE': {
          const pts: Vertex[] = [];
          for (const [c, v] of e.list) {
            if (c === 10) pts.push({ x: parseFloat(v), y: 0 });
            else if (c === 20 && pts.length) pts[pts.length - 1].y = parseFloat(v);
            else if (c === 42 && pts.length) {
              const b = parseFloat(v);
              if (b) pts[pts.length - 1].b = b;
            }
          }
          if (pts.length >= 2) emit({ kind: 'poly', pts, closed: (f(e, 70) & 1) === 1 }, layer, mm);
          break;
        }
        case 'POLYLINE': {
          const flags = f(e, 70);
          if (flags & (16 | 64)) {
            skip('POLYLINE (3D mesh)');
            break;
          }
          const pts: Vertex[] = (e.verts ?? []).filter((v) => !(f(v, 70) & 16)).map((v) => {
            const b = f(v, 42);
            return b ? { x: f(v, 10), y: f(v, 20), b } : { x: f(v, 10), y: f(v, 20) };
          });
          if (pts.length >= 2) emit({ kind: 'poly', pts, closed: (flags & 1) === 1 }, layer, mm);
          break;
        }
        case 'SPLINE':
          emit(spline(e, tol), layer, mm);
          break;
        case 'ELLIPSE':
          emit(ellipse(e, tol), layer, mm);
          break;
        case 'INSERT': {
          const b = blocks.get(s(e, 2));
          if (!b || depth > 16) {
            skip('INSERT (missing block)');
            break;
          }
          const sx = f(e, 41, 1), sy = f(e, 42, 1);
          if (Math.abs(Math.abs(sx) - Math.abs(sy)) > 1e-9 || f(e, 70, 1) > 1 || f(e, 71, 1) > 1) {
            skip('INSERT (stretched or array)');
            break;
          }
          const rot = f(e, 50) * DEG, k = Math.abs(sx);
          const ins = { x: f(e, 10), y: f(e, 20) };
          // block → insert: move base to origin, mirror if a scale is negative, scale, rotate, move to the insert point
          let n: Xform = { a: 1, b: 0, c: 0, d: 1, e: -b.base.x, f: -b.base.y };
          if (sx * sy < 0) n = compose(sx < 0 ? mirrorAcross({ x: 0, y: 0 }, Math.PI / 2) : mirrorAcross({ x: 0, y: 0 }, 0), n);
          else if (sx < 0) n = compose({ a: -1, b: 0, c: 0, d: -1, e: 0, f: 0 }, n);
          const cs = Math.cos(rot) * k, sn = Math.sin(rot) * k;
          n = compose({ a: cs, b: sn, c: -sn, d: cs, e: ins.x, f: ins.y }, n);
          walk(b.ents, mm ? compose(mm, n) : n, depth + 1, layer);
          break;
        }
        case 'POINT':
        case 'TEXT':
        case 'MTEXT':
        case 'DIMENSION':
        case 'HATCH':
        case 'SOLID':
        case 'VIEWPORT':
        case 'ATTRIB':
        case 'ATTDEF':
          skip(e.type);
          break;
        default:
          skip(e.type);
      }
    }
  };
  walk(entities(sections.get('ENTITIES')!), null, 0, null);
  out.layers = [...layerSet];
  return out;
}

/** B-spline (or its fit points when it has no control points), flattened */
function spline(e: RawEntity, tol: number): Shape | null {
  const deg = f(e, 71, 3);
  const closed = (f(e, 70) & 1) === 1;
  const knots = (e.g.get(40) ?? []).map(Number);
  const weights = (e.g.get(41) ?? []).map(Number);
  const ctrl: Pt[] = [];
  const fit: Pt[] = [];
  for (const [c, v] of e.list) {
    if (c === 10) ctrl.push({ x: +v, y: 0 });
    else if (c === 20 && ctrl.length) ctrl[ctrl.length - 1].y = +v;
    else if (c === 11) fit.push({ x: +v, y: 0 });
    else if (c === 21 && fit.length) fit[fit.length - 1].y = +v;
  }
  if (ctrl.length < 2 || knots.length !== ctrl.length + deg + 1) {
    return fit.length >= 2 ? { kind: 'poly', pts: fit, closed } : null;
  }
  const w = weights.length === ctrl.length ? weights : ctrl.map(() => 1);
  const t0 = knots[deg], t1 = knots[knots.length - deg - 1];
  // de Boor at parameter t
  const at = (t: number): Pt => {
    let k = deg;
    while (k < knots.length - deg - 2 && t >= knots[k + 1]) k++;
    const d = Array.from({ length: deg + 1 }, (_, j) => {
      const p = ctrl[j + k - deg], wj = w[j + k - deg];
      return { x: p.x * wj, y: p.y * wj, w: wj };
    });
    for (let r = 1; r <= deg; r++)
      for (let j = deg; j >= r; j--) {
        const i = j + k - deg;
        const den = knots[i + deg + 1 - r] - knots[i];
        const a = den === 0 ? 0 : (t - knots[i]) / den;
        d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y, w: (1 - a) * d[j - 1].w + a * d[j].w };
      }
    return { x: d[deg].x / d[deg].w, y: d[deg].y / d[deg].w };
  };
  // enough samples for the control polygon's length at the tolerance, refined per span
  let polyLen = 0;
  for (let i = 1; i < ctrl.length; i++) polyLen += len(sub(ctrl[i], ctrl[i - 1]));
  const n = Math.min(20000, Math.max(16 * ctrl.length, Math.ceil(polyLen / Math.sqrt(8 * tol * Math.max(1, polyLen / 20)))));
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) pts.push(at(t0 + ((t1 - t0) * i) / n));
  return { kind: 'poly', pts: simplify(pts, tol / 2), closed };
}

function ellipse(e: RawEntity, tol: number): Shape | null {
  const c = { x: f(e, 10), y: f(e, 20) }, maj = { x: f(e, 11), y: f(e, 21) };
  const ratio = f(e, 40, 1), p0 = f(e, 41, 0), p1 = f(e, 42, Math.PI * 2);
  const a = len(maj), b = a * ratio, rot = Math.atan2(maj.y, maj.x);
  if (a <= 0) return null;
  let sweep = p1 - p0;
  while (sweep <= 0) sweep += Math.PI * 2;
  const full = Math.abs(sweep - Math.PI * 2) < 1e-9;
  const n = Math.max(16, Math.ceil(sweep / (2 * Math.acos(Math.max(-1, 1 - tol / a)))));
  const pts: Pt[] = [];
  const cs = Math.cos(rot), sn = Math.sin(rot);
  for (let i = 0; i <= (full ? n - 1 : n); i++) {
    const t = p0 + (sweep * i) / n;
    const x = a * Math.cos(t), y = b * Math.sin(t);
    pts.push({ x: c.x + x * cs - y * sn, y: c.y + x * sn + y * cs });
  }
  return { kind: 'poly', pts, closed: full };
}

/** Douglas–Peucker on a point list */
export function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let worst = -1, wd = tol;
    const a = pts[i], b = pts[j], d = sub(b, a), l = len(d);
    for (let k = i + 1; k < j; k++) {
      const p = pts[k];
      const dd = l < 1e-12 ? len(sub(p, a)) : Math.abs((p.x - a.x) * d.y - (p.y - a.y) * d.x) / l;
      if (dd > wd) {
        wd = dd;
        worst = k;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

// ---- export -------------------------------------------------------------------------------------

export interface DxfExportItem {
  shape: Shape;
  layer: string;
}

/** R12 DXF; `units` = units of the numbers written (input shapes are in mm) */
export function writeDxf(items: DxfExportItem[], units: 'mm' | 'in' = 'mm'): string {
  const k = units === 'in' ? 1 / 25.4 : 1;
  const L: string[] = [];
  const g = (c: number, v: string | number) => L.push(String(c), typeof v === 'number' ? fmt(v) : v);
  const fmt = (v: number) => {
    const s = v.toFixed(6).replace(/\.?0+$/, '');
    return s === '-0' ? '0' : s;
  };
  const layerName = (n: string) => n.replace(/[<>/\\":;?*|=`]/g, '_') || '0';
  const layers = [...new Set(items.map((i) => layerName(i.layer)).concat(items.some((i) => i.shape.kind === 'dim') ? ['DIMENSIONS'] : []))];
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, units === 'in' ? '1' : '4');
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, String(layers.length));
  layers.forEach((n, i) => {
    g(0, 'LAYER'); g(2, n); g(70, '0'); g(62, String((i % 6) + 1)); g(6, 'CONTINUOUS');
  });
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  const P = (p: Pt, cx = 10) => {
    g(cx, p.x * k);
    g(cx + 10, p.y * k);
    g(cx + 20, 0);
  };
  for (const { shape: sh, layer } of items) {
    const ln = layerName(layer);
    switch (sh.kind) {
      case 'line':
        g(0, 'LINE'); g(8, ln); P(sh.a); P(sh.b, 11);
        break;
      case 'circle':
        g(0, 'CIRCLE'); g(8, ln); P(sh.c); g(40, sh.r * k);
        break;
      case 'arc':
        g(0, 'ARC'); g(8, ln); P(sh.c); g(40, sh.r * k); g(50, normAngle(sh.a0) / DEG); g(51, normAngle(sh.a1) / DEG);
        break;
      case 'poly':
        g(0, 'POLYLINE'); g(8, ln); g(66, '1'); P({ x: 0, y: 0 }); g(70, sh.closed ? '1' : '0');
        for (const v of sh.pts) {
          g(0, 'VERTEX'); g(8, ln); P(v);
          if (v.b) g(42, v.b);
        }
        g(0, 'SEQEND'); g(8, ln);
        break;
      case 'dim': {
        const [p, q] = dimLine(sh);
        for (const [a, b] of [[sh.a, p], [sh.b, q], [p, q]] as [Pt, Pt][]) {
          g(0, 'LINE'); g(8, 'DIMENSIONS'); P(a); P(b, 11);
        }
        const m = lerp(p, q, 0.5), d = len(sub(sh.b, sh.a));
        const ang = Math.atan2(q.y - p.y, q.x - p.x) / DEG;
        const up = ang > 90 || ang <= -90 ? ang + 180 : ang;
        g(0, 'TEXT'); g(8, 'DIMENSIONS'); P(m); g(40, 3 * k); g(1, units === 'in' ? `${fmt(d / 25.4)}"` : fmt(Math.round(d * 100) / 100)); g(50, up); g(72, '1'); P(m, 11);
        break;
      }
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return L.join('\n') + '\n';
}
