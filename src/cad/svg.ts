import { arcBulge, dimLine, flatten, lerp, len, normAngle, polar, sub, type Pt, type Shape, type Vertex } from './geom';
import { transformShape, type Xform } from './ops';

/**
 * SVG in and out.
 *
 * Import: path (all commands), rect (rounded corners), circle, ellipse, line, polyline, polygon,
 * nested groups with transforms. Sizes come from the root width/height units and viewBox
 * (unitless = px at 96 per inch, as Inkscape and Illustrator write). The SVG's Y-down picture is
 * turned into Y-up drawing coordinates with its bottom-left corner at 0, 0. Circular arcs stay
 * arcs when the transform allows it; Béziers, elliptical arcs and anything skewed are flattened
 * to within `tol` mm. Fill and stroke are ignored: every outline is geometry.
 * Export: mm-sized SVG, outlines as stroke-only paths.
 */

export interface SvgImport {
  shapes: { shape: Shape; layer: string }[];
  widthMm: number;
  heightMm: number;
  skipped: Record<string, number>;
}

// ---- tiny XML reader (enough for SVG) -----------------------------------------------------------

interface El {
  name: string;
  attrs: Record<string, string>;
  kids: El[];
}

const decode = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[e.toLowerCase()] ?? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));

function parseXml(text: string): El {
  const root: El = { name: '#root', attrs: {}, kids: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) {
      // closing tag: pop to the matching element
      for (let i = stack.length - 1; i > 0; i--)
        if (stack[i].name === m[1]) {
          stack.length = i;
          break;
        }
    } else if (m[2]) {
      const attrs: Record<string, string> = {};
      const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      while ((a = ar.exec(m[3]))) attrs[a[1]] = decode(a[2] ?? a[3] ?? '');
      const el: El = { name: m[2].replace(/^svg:/, ''), attrs, kids: [] };
      stack[stack.length - 1].kids.push(el);
      if (!m[4]) stack.push(el);
    }
  }
  return root;
}

// ---- transforms ---------------------------------------------------------------------------------

const ID: Xform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const mul = (m: Xform, n: Xform): Xform => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
});
const apply = (m: Xform, p: Pt): Pt => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
/** rotation / uniform scale / mirror only (circles stay circles) */
const isSimilar = (m: Xform) => Math.abs(m.a * m.a + m.b * m.b - (m.c * m.c + m.d * m.d)) < 1e-9 * (m.a * m.a + m.b * m.b + 1) && Math.abs(m.a * m.c + m.b * m.d) < 1e-9 * (m.a * m.a + m.b * m.b + 1);
const scaleOf = (m: Xform) => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;

const nums = (s: string) => (s.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);

function parseTransform(s: string | undefined): Xform {
  let m = ID;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t: RegExpExecArray | null;
  while ((t = re.exec(s))) {
    const v = nums(t[2]);
    let n = ID;
    switch (t[1]) {
      case 'matrix':
        if (v.length === 6) n = { a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], f: v[5] };
        break;
      case 'translate':
        n = { ...ID, e: v[0] ?? 0, f: v[1] ?? 0 };
        break;
      case 'scale':
        n = { ...ID, a: v[0] ?? 1, d: v[1] ?? v[0] ?? 1 };
        break;
      case 'rotate': {
        const r = ((v[0] ?? 0) * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
        const [cx, cy] = [v[1] ?? 0, v[2] ?? 0];
        n = mul(mul({ ...ID, e: cx, f: cy }, { a: cs, b: sn, c: -sn, d: cs, e: 0, f: 0 }), { ...ID, e: -cx, f: -cy });
        break;
      }
      case 'skewX':
        n = { ...ID, c: Math.tan(((v[0] ?? 0) * Math.PI) / 180) };
        break;
      case 'skewY':
        n = { ...ID, b: Math.tan(((v[0] ?? 0) * Math.PI) / 180) };
        break;
    }
    m = mul(m, n);
  }
  return m;
}

const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };

function lengthMm(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*(mm|cm|in|pt|pc|px|%)?\s*$/i.exec(v);
  if (!m || m[2] === '%') return null;
  return parseFloat(m[1]) * UNIT_MM[(m[2] ?? '').toLowerCase()];
}

// ---- path data ----------------------------------------------------------------------------------

/** one subpath in user units: vertices with bulges for circular arcs, flattened curves otherwise */
interface Sub {
  pts: Vertex[];
  closed: boolean;
}

function parsePath(d: string, tolUser: number): Sub[] {
  const toks = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const subs: Sub[] = [];
  let cur = null as Sub | null;
  let p: Pt = { x: 0, y: 0 }, start: Pt = { x: 0, y: 0 };
  let lastCtrl: Pt | null = null, lastCmd = '';
  let i = 0, cmd = '';
  const num = () => parseFloat(toks[i++]);
  const flag = () => {
    // flags may be written without separators: "a1 1 0 00 10 10"
    const t = toks[i];
    if (t.length > 1 && (t[0] === '0' || t[0] === '1')) {
      toks[i] = t.slice(1);
      return t[0] === '1';
    }
    i++;
    return t === '1';
  };
  const lineTo = (q: Pt) => {
    if (!cur) {
      cur = { pts: [{ ...p }], closed: false };
      subs.push(cur);
    }
    cur.pts.push({ x: q.x, y: q.y });
    p = q;
  };
  const curve = (pts: Pt[]) => {
    // adaptive flattening of a Bézier given its control points (p first)
    const out: Pt[] = [];
    const rec = (c: Pt[], depth: number) => {
      const a = c[0], b = c[c.length - 1], dl = sub(b, a), l = len(dl) || 1e-12;
      let flat = 0;
      for (let k = 1; k < c.length - 1; k++) flat = Math.max(flat, Math.abs((c[k].x - a.x) * dl.y - (c[k].y - a.y) * dl.x) / l);
      if (flat <= tolUser || depth > 16) {
        out.push(b);
        return;
      }
      // de Casteljau split at 0.5
      const left: Pt[] = [c[0]], right: Pt[] = [c[c.length - 1]];
      let lv = c;
      while (lv.length > 1) {
        const nx: Pt[] = [];
        for (let k = 0; k + 1 < lv.length; k++) nx.push(lerp(lv[k], lv[k + 1], 0.5));
        left.push(nx[0]);
        right.unshift(nx[nx.length - 1]);
        lv = nx;
      }
      rec(left, depth + 1);
      rec(right, depth + 1);
    };
    rec(pts, 0);
    for (const q of out) lineTo(q);
  };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    else if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const base = rel ? p : { x: 0, y: 0 };
    const P = (x: number, y: number): Pt => ({ x: base.x + x, y: base.y + y });
    switch (cmd.toUpperCase()) {
      case 'M': {
        p = P(num(), num());
        start = p;
        cur = null;
        lastCtrl = null;
        // further pairs after M are lines
        cmd = rel ? 'l' : 'L';
        lastCmd = 'M';
        continue;
      }
      case 'L':
        lineTo(P(num(), num()));
        break;
      case 'H':
        lineTo({ x: (rel ? p.x : 0) + num(), y: p.y });
        break;
      case 'V':
        lineTo({ x: p.x, y: (rel ? p.y : 0) + num() });
        break;
      case 'C': {
        const c1 = P(num(), num()), c2 = P(num(), num()), e = P(num(), num());
        curve([p, c1, c2, e]);
        lastCtrl = c2;
        lastCmd = 'C';
        continue;
      }
      case 'S': {
        const c1: Pt = lastCtrl && /[CS]/.test(lastCmd) ? { x: 2 * p.x - lastCtrl.x, y: 2 * p.y - lastCtrl.y } : p;
        const c2 = P(num(), num()), e = P(num(), num());
        curve([p, c1, c2, e]);
        lastCtrl = c2;
        lastCmd = 'S';
        continue;
      }
      case 'Q': {
        const c = P(num(), num()), e = P(num(), num());
        curve([p, c, e]);
        lastCtrl = c;
        lastCmd = 'Q';
        continue;
      }
      case 'T': {
        const c: Pt = lastCtrl && /[QT]/.test(lastCmd) ? { x: 2 * p.x - lastCtrl.x, y: 2 * p.y - lastCtrl.y } : p;
        const e = P(num(), num());
        curve([p, c, e]);
        lastCtrl = c;
        lastCmd = 'T';
        continue;
      }
      case 'A': {
        const rx = Math.abs(num()), ry = Math.abs(num()), rot = num(), large = flag(), sweep = flag();
        const e = P(num(), num());
        svgArc(p, e, rx, ry, rot, large, sweep, tolUser, (q, b) => {
          if (b !== undefined) {
            lineTo(q);
            // the bulge belongs to the vertex the arc starts from
            cur!.pts[cur!.pts.length - 2].b = b;
          } else lineTo(q);
        });
        p = e;
        break;
      }
      case 'Z':
        if (cur) {
          cur.closed = true;
          const last = cur.pts[cur.pts.length - 1];
          if (cur.pts.length > 1 && Math.hypot(last.x - start.x, last.y - start.y) < 1e-9) {
            // a closing arc keeps its bulge on the vertex before
            cur.pts.pop();
          }
        }
        p = start;
        cur = null;
        break;
      default:
        i++;
    }
    lastCtrl = null;
    lastCmd = cmd.toUpperCase();
  }
  return subs;
}

/**
 * SVG endpoint arc. Circular (rx = ry, after scaling up radii that are too small) arcs come out as
 * one bulged segment (split in two if more than 180° so the bulge stays well behaved); elliptical
 * ones as flattened points.
 */
function svgArc(p: Pt, q: Pt, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, tol: number, out: (q: Pt, b?: number) => void) {
  if (rx < 1e-12 || ry < 1e-12 || (p.x === q.x && p.y === q.y)) {
    out(q);
    return;
  }
  const phi = (rotDeg * Math.PI) / 180, cs = Math.cos(phi), sn = Math.sin(phi);
  const dx = (p.x - q.x) / 2, dy = (p.y - q.y) / 2;
  const x1 = cs * dx + sn * dy, y1 = -sn * dx + cs * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const sgn = large !== sweep ? 1 : -1;
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const co = sgn * Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cxp = (co * rx * y1) / ry, cyp = (-co * ry * x1) / rx;
  const c = { x: cs * cxp - sn * cyp + (p.x + q.x) / 2, y: sn * cxp + cs * cyp + (p.y + q.y) / 2 };
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  if (Math.abs(rx - ry) < 1e-9 * Math.max(rx, ry)) {
    // circle: SVG's positive sweep is clockwise on screen, i.e. +angle in Y-down user space;
    // bulges are computed in the same (user) space and fixed up by the final transform
    const parts = Math.abs(dt) > Math.PI ? 2 : 1;
    let a = p;
    for (let k = 1; k <= parts; k++) {
      const b = k === parts ? q : polar(c, rx, t1 + phi + (dt * k) / parts);
      out(b, arcBulge(a, b, c, dt > 0));
      a = b;
    }
    return;
  }
  const n = Math.max(4, Math.ceil(Math.abs(dt) / (2 * Math.acos(Math.max(-1, 1 - tol / Math.max(rx, ry))))));
  for (let k = 1; k <= n; k++) {
    const t = t1 + (dt * k) / n;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    out(k === n ? q : { x: c.x + cs * ex - sn * ey, y: c.y + sn * ex + cs * ey });
  }
}

// ---- import -------------------------------------------------------------------------------------

export function parseSvg(text: string, tol = 0.01): SvgImport {
  const doc = parseXml(text);
  const svg = doc.kids.find((k) => k.name === 'svg');
  if (!svg) throw new Error('not an SVG file');
  const vb = svg.attrs.viewBox ? nums(svg.attrs.viewBox) : null;
  const wAttr = lengthMm(svg.attrs.width), hAttr = lengthMm(svg.attrs.height);
  let sx = 25.4 / 96, sy = sx, ox = 0, oy = 0, W: number, H: number;
  if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    W = wAttr ?? vb[2] * (25.4 / 96);
    H = hAttr ?? (wAttr ? (wAttr * vb[3]) / vb[2] : vb[3] * (25.4 / 96));
    sx = W / vb[2];
    sy = H / vb[3];
    // preserveAspectRatio default (xMidYMid meet): uniform scale, centred
    const k = Math.min(sx, sy);
    ox = -vb[0] * k + (W - vb[2] * k) / 2;
    oy = -vb[1] * k + (H - vb[3] * k) / 2;
    sx = sy = k;
  } else {
    W = wAttr ?? 0;
    H = hAttr ?? 0;
  }
  // user units → mm, Y flipped so the bottom of the picture is y = 0
  const root: Xform = { a: sx, b: 0, c: 0, d: -sy, e: ox, f: H - oy };
  const out: SvgImport = { shapes: [], widthMm: W, heightMm: H, skipped: {} };
  const skip = (t: string) => (out.skipped[t] = (out.skipped[t] ?? 0) + 1);

  const emitSubs = (subs: Sub[], m: Xform, layer: string) => {
    const sim = isSimilar(m);
    for (const s of subs) {
      if (s.pts.length < 2) continue;
      let shape: Shape = { kind: 'poly', pts: s.pts, closed: s.closed };
      if (sim) shape = transformShape(shape, m);
      else {
        // skewed / stretched: flatten arcs in user space, then map the points
        const f = flatten(shape, tol / scaleOf(m));
        shape = { kind: 'poly', pts: f.pts.map((q) => apply(m, q)), closed: s.closed };
      }
      out.shapes.push({ shape, layer });
    }
  };

  const walk = (el: El, parent: Xform, layer: string, hidden: boolean) => {
    for (const k of el.kids) {
      const style = k.attrs.style ?? '';
      if (k.attrs.display === 'none' || /display\s*:\s*none/.test(style) || hidden) continue;
      const m = mul(parent, parseTransform(k.attrs.transform));
      const tolUser = tol / scaleOf(m);
      const n = (a: string, d = 0) => {
        const v = parseFloat(k.attrs[a] ?? '');
        return Number.isFinite(v) ? v : d;
      };
      switch (k.name) {
        case 'g':
        case 'a':
        case 'svg': {
          // Inkscape layers: groups with inkscape:groupmode="layer"
          const name = k.attrs['inkscape:groupmode'] === 'layer' ? (k.attrs['inkscape:label'] ?? k.attrs.id ?? layer) : layer;
          walk(k, m, name, false);
          break;
        }
        case 'path':
          emitSubs(parsePath(k.attrs.d ?? '', tolUser), m, layer);
          break;
        case 'line':
          emitSubs([{ pts: [{ x: n('x1'), y: n('y1') }, { x: n('x2'), y: n('y2') }], closed: false }], m, layer);
          break;
        case 'polyline':
        case 'polygon': {
          const v = nums(k.attrs.points ?? '');
          const pts: Vertex[] = [];
          for (let j = 0; j + 1 < v.length; j += 2) pts.push({ x: v[j], y: v[j + 1] });
          emitSubs([{ pts, closed: k.name === 'polygon' }], m, layer);
          break;
        }
        case 'rect': {
          const x = n('x'), y = n('y'), w = n('width'), h = n('height');
          if (w <= 0 || h <= 0) break;
          let rx = k.attrs.rx !== undefined ? n('rx') : n('ry'), ry = k.attrs.ry !== undefined ? n('ry') : rx;
          rx = Math.min(rx, w / 2);
          ry = Math.min(ry, h / 2);
          if (rx > 0 && ry > 0) {
            const d = `M${x + rx},${y} H${x + w - rx} A${rx},${ry} 0 0 1 ${x + w},${y + ry} V${y + h - ry} A${rx},${ry} 0 0 1 ${x + w - rx},${y + h} H${x + rx} A${rx},${ry} 0 0 1 ${x},${y + h - ry} V${y + ry} A${rx},${ry} 0 0 1 ${x + rx},${y} Z`;
            emitSubs(parsePath(d, tolUser), m, layer);
          } else emitSubs([{ pts: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], closed: true }], m, layer);
          break;
        }
        case 'circle':
        case 'ellipse': {
          const cx = n('cx'), cy = n('cy');
          const rx = k.name === 'circle' ? n('r') : n('rx'), ry = k.name === 'circle' ? n('r') : n('ry', rx);
          if (rx <= 0 || ry <= 0) break;
          if (Math.abs(rx - ry) < 1e-9 && isSimilar(m)) {
            out.shapes.push({ shape: transformShape({ kind: 'circle', c: { x: cx, y: cy }, r: rx }, m), layer });
          } else {
            const d = `M${cx + rx},${cy} A${rx},${ry} 0 1 1 ${cx - rx},${cy} A${rx},${ry} 0 1 1 ${cx + rx},${cy} Z`;
            emitSubs(parsePath(d, tolUser), m, layer);
          }
          break;
        }
        case 'defs':
        case 'title':
        case 'desc':
        case 'metadata':
        case 'style':
        case 'sodipodi:namedview':
        case 'clipPath':
        case 'mask':
        case 'linearGradient':
        case 'radialGradient':
        case 'pattern':
          break;
        default:
          skip(k.name);
      }
    }
  };
  walk(svg, root, 'SVG', false);
  return out;
}

// ---- export -------------------------------------------------------------------------------------

/** mm-sized SVG of the shapes, the drawing's 0, 0 at the bottom-left of the box */
export function writeSvg(items: { shape: Shape; layer: string; color?: string }[], margin = 2): string {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { shape } of items)
    for (const p of flatten(shape, 0.1).pts) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
  if (!Number.isFinite(x0)) x0 = y0 = x1 = y1 = 0;
  x0 -= margin; y0 -= margin; x1 += margin; y1 += margin;
  const W = x1 - x0, H = y1 - y0;
  const n = (v: number) => {
    const s = v.toFixed(4).replace(/\.?0+$/, '');
    return s === '-0' ? '0' : s;
  };
  const X = (p: Pt) => n(p.x - x0), Y = (p: Pt) => n(y1 - p.y);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  // the page shows the same picture, so a CCW arc still looks CCW; in SVG's Y-down numbers that is
  // the negative-angle direction: sweep-flag 0
  const arcCmd = (r: number, sweepAng: number, end: Pt, ccw: boolean) => `A${n(r)} ${n(r)} 0 ${sweepAng > Math.PI ? 1 : 0} ${ccw ? 0 : 1} ${X(end)} ${Y(end)}`;
  const byLayer = new Map<string, string[]>();
  for (const { shape: s, layer, color } of items) {
    const stroke = color ?? '#000';
    let el = '';
    switch (s.kind) {
      case 'line':
        el = `<line x1="${X(s.a)}" y1="${Y(s.a)}" x2="${X(s.b)}" y2="${Y(s.b)}" stroke="${stroke}"/>`;
        break;
      case 'circle':
        el = `<circle cx="${X(s.c)}" cy="${Y(s.c)}" r="${n(s.r)}" stroke="${stroke}"/>`;
        break;
      case 'arc': {
        const a = polar(s.c, s.r, s.a0), b = polar(s.c, s.r, s.a1);
        const sw = normAngle(s.a1 - s.a0) || Math.PI * 2;
        el = `<path d="M${X(a)} ${Y(a)} ${arcCmd(s.r, sw, b, true)}" stroke="${stroke}"/>`;
        break;
      }
      case 'poly': {
        const parts = [`M${X(s.pts[0])} ${Y(s.pts[0])}`];
        const m = s.closed ? s.pts.length : s.pts.length - 1;
        for (let i = 0; i < m; i++) {
          const p = s.pts[i], q = s.pts[(i + 1) % s.pts.length];
          if (p.b) {
            const sw = 4 * Math.atan(Math.abs(p.b));
            const r = (len(sub(q, p)) / 2) * (1 + p.b * p.b) / (2 * Math.abs(p.b));
            parts.push(arcCmd(r, sw, q, p.b > 0));
          } else if (!(s.closed && i === m - 1)) parts.push(`L${X(q)} ${Y(q)}`);
        }
        if (s.closed) parts.push('Z');
        el = `<path d="${parts.join(' ')}" stroke="${stroke}"/>`;
        break;
      }
      case 'dim': {
        const [p, q] = dimLine(s);
        const m = lerp(p, q, 0.5), d = len(sub(s.b, s.a));
        el = `<path d="M${X(s.a)} ${Y(s.a)} L${X(p)} ${Y(p)} L${X(q)} ${Y(q)} L${X(s.b)} ${Y(s.b)}" stroke="${stroke}"/><text x="${X(m)}" y="${Y(m)}" font-size="3" text-anchor="middle" fill="${stroke}" stroke="none">${n(Math.round(d * 100) / 100)}</text>`;
        break;
      }
    }
    const l = byLayer.get(layer);
    if (l) l.push(el);
    else byLayer.set(layer, [el]);
  }
  const groups = [...byLayer].map(([name, els]) => `<g id="${esc(name.replace(/\s+/g, '_'))}" inkscape:label="${esc(name)}" inkscape:groupmode="layer">\n${els.join('\n')}\n</g>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${n(W)}mm" height="${n(H)}mm" viewBox="0 0 ${n(W)} ${n(H)}" fill="none" stroke-width="0.25">
${groups}
</svg>
`;
}

/**
 * SVG path data (`d`) → closed/open polylines in drawing coordinates through `m` (curves flattened
 * to within `tol` mm of the result). Used for font glyphs.
 */
export function pathDataShapes(d: string, m: Xform, tol = 0.01): Shape[] {
  const subs = parsePath(d, tol / scaleOf(m));
  return subs
    .filter((s) => s.pts.length >= 2)
    .map((s) => {
      const f = flatten({ kind: 'poly', pts: s.pts, closed: s.closed }, tol / scaleOf(m));
      return { kind: 'poly', pts: f.pts.map((q) => apply(m, q)), closed: s.closed } as Shape;
    });
}
