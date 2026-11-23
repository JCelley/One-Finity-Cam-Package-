/**
 * 2D geometry for the CAD document. Units are mm, Y up (machine convention: X right, Y away from
 * you). Angles in radians, counter-clockwise from +X. Arcs always run counter-clockwise from a0 to
 * a1; polyline vertices carry a DXF-style bulge (tan of a quarter of the included angle, + = CCW)
 * for an arc to the next vertex.
 */

export interface Pt {
  x: number;
  y: number;
}
export interface Vertex extends Pt {
  /** bulge of the segment to the next vertex; 0 / absent = straight */
  b?: number;
}

export type Shape =
  | { kind: 'line'; a: Pt; b: Pt }
  | { kind: 'arc'; c: Pt; r: number; a0: number; a1: number }
  | { kind: 'circle'; c: Pt; r: number }
  | { kind: 'poly'; pts: Vertex[]; closed: boolean }
  /** aligned linear dimension between a and b, its line `off` mm to the left of a→b */
  | { kind: 'dim'; a: Pt; b: Pt; off: number };

/** the simplest pieces everything breaks down into: straight segments and CCW arcs */
export type Prim = { t: 'seg'; a: Pt; b: Pt } | { t: 'arc'; c: Pt; r: number; a0: number; sweep: number };

export const TAU = Math.PI * 2;
export const EPS = 1e-9;

export const pt = (x: number, y: number): Pt => ({ x, y });
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
export const cross = (a: Pt, b: Pt) => a.x * b.y - a.y * b.x;
export const len = (a: Pt) => Math.hypot(a.x, a.y);
export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const polar = (c: Pt, r: number, a: number): Pt => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
export const near = (a: Pt, b: Pt, tol = 1e-6) => dist(a, b) <= tol;

/** angle normalised to [0, 2π) */
export const normAngle = (a: number) => ((a % TAU) + TAU) % TAU;
/** CCW sweep from a0 to a1 in (0, 2π]; equal angles = a full turn */
export const ccwSweep = (a0: number, a1: number) => {
  const s = normAngle(a1 - a0);
  return s < 1e-12 ? TAU : s;
};
/** is angle a on the CCW arc starting at a0 with the given sweep */
export const onSweep = (a: number, a0: number, sweep: number, tol = 1e-9) => normAngle(a - a0) <= sweep + tol || normAngle(a - a0) >= TAU - tol;

/** arc through p→q with bulge b (b ≠ 0) */
export function bulgeArc(p: Pt, q: Pt, b: number): { c: Pt; r: number; a0: number; sweep: number; ccw: boolean } {
  const d = dist(p, q), s = d / 2;
  const u = mul(sub(q, p), 1 / (d || 1));
  const nL = { x: -u.y, y: u.x };
  const h = (s * (1 - b * b)) / (2 * b);
  const c = add(lerp(p, q, 0.5), mul(nL, h));
  const r = (s * (1 + b * b)) / (2 * Math.abs(b));
  const ap = Math.atan2(p.y - c.y, p.x - c.x), aq = Math.atan2(q.y - c.y, q.x - c.x);
  const sweep = 4 * Math.atan(Math.abs(b));
  return b > 0 ? { c, r, a0: ap, sweep, ccw: true } : { c, r, a0: aq, sweep, ccw: false };
}

/** bulge for an arc from p to q around centre c going CCW or CW */
export function arcBulge(p: Pt, q: Pt, c: Pt, ccw: boolean): number {
  const a0 = Math.atan2(p.y - c.y, p.x - c.x), a1 = Math.atan2(q.y - c.y, q.x - c.x);
  const sw = ccw ? ccwSweep(a0, a1) : ccwSweep(a1, a0);
  return (ccw ? 1 : -1) * Math.tan(sw / 4);
}

/** the shape as primitives (dimensions have none: they are annotation, not geometry) */
export function prims(s: Shape): Prim[] {
  switch (s.kind) {
    case 'line':
      return [{ t: 'seg', a: s.a, b: s.b }];
    case 'arc':
      return [{ t: 'arc', c: s.c, r: s.r, a0: s.a0, sweep: ccwSweep(s.a0, s.a1) }];
    case 'circle':
      return [{ t: 'arc', c: s.c, r: s.r, a0: 0, sweep: TAU }];
    case 'poly': {
      const out: Prim[] = [];
      const n = s.pts.length, m = s.closed ? n : n - 1;
      for (let i = 0; i < m; i++) {
        const p = s.pts[i], q = s.pts[(i + 1) % n];
        if (near(p, q, 1e-12)) continue;
        if (p.b && Math.abs(p.b) > 1e-12) {
          const a = bulgeArc(p, q, p.b);
          out.push({ t: 'arc', c: a.c, r: a.r, a0: a.a0, sweep: a.sweep });
        } else out.push({ t: 'seg', a: p, b: q });
      }
      return out;
    }
    case 'dim':
      return [];
  }
}

/** points along a primitive, ends included, within `tol` of the true curve */
export function flattenPrim(p: Prim, tol = 0.01): Pt[] {
  if (p.t === 'seg') return [p.a, p.b];
  const n = arcSteps(p.r, p.sweep, tol);
  const out: Pt[] = [];
  for (let k = 0; k <= n; k++) out.push(polar(p.c, p.r, p.a0 + (p.sweep * k) / n));
  return out;
}

export const arcSteps = (r: number, sweep: number, tol: number) => {
  const step = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : Math.PI / 2;
  return Math.max(2, Math.ceil(sweep / Math.max(step, 1e-3)));
};

/**
 * The shape as one point list in drawing order, plus whether it is closed. Arcs inside a polyline
 * that run CW are flattened CW so the order follows the polyline.
 */
export function flatten(s: Shape, tol = 0.01): { pts: Pt[]; closed: boolean } {
  if (s.kind === 'poly') {
    const out: Pt[] = [];
    const n = s.pts.length, m = s.closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const p = s.pts[i], q = s.pts[(i + 1) % n];
      if (!out.length) out.push(p);
      if (p.b && Math.abs(p.b) > 1e-12) {
        const a = bulgeArc(p, q, p.b);
        const k = arcSteps(a.r, a.sweep, tol);
        for (let j = 1; j <= k; j++) {
          const t = j / k;
          out.push(j === k ? { x: q.x, y: q.y } : polar(a.c, a.r, a.ccw ? a.a0 + a.sweep * t : a.a0 + a.sweep * (1 - t)));
        }
      } else out.push({ x: q.x, y: q.y });
    }
    if (n === 1) out.push(s.pts[0]);
    if (s.closed && out.length > 1 && near(out[0], out[out.length - 1])) out.pop();
    return { pts: out, closed: s.closed };
  }
  if (s.kind === 'circle') {
    const pts = flattenPrim({ t: 'arc', c: s.c, r: s.r, a0: 0, sweep: TAU }, tol);
    pts.pop();
    return { pts, closed: true };
  }
  if (s.kind === 'dim') return { pts: [s.a, s.b], closed: false };
  return { pts: flattenPrim(prims(s)[0], tol), closed: false };
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export const emptyBox = (): Box => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
export const boxAdd = (b: Box, p: Pt) => {
  b.x0 = Math.min(b.x0, p.x); b.y0 = Math.min(b.y0, p.y);
  b.x1 = Math.max(b.x1, p.x); b.y1 = Math.max(b.y1, p.y);
  return b;
};
export const boxValid = (b: Box) => b.x0 <= b.x1 && b.y0 <= b.y1;

export function primBox(p: Prim, b = emptyBox()): Box {
  if (p.t === 'seg') return boxAdd(boxAdd(b, p.a), p.b);
  boxAdd(b, polar(p.c, p.r, p.a0));
  boxAdd(b, polar(p.c, p.r, p.a0 + p.sweep));
  for (let q = 0; q < 4; q++) if (onSweep((q * Math.PI) / 2, p.a0, p.sweep, 0)) boxAdd(b, polar(p.c, p.r, (q * Math.PI) / 2));
  return b;
}

export function shapeBox(s: Shape, b = emptyBox()): Box {
  if (s.kind === 'dim') {
    const [p, q] = dimLine(s);
    return boxAdd(boxAdd(boxAdd(boxAdd(b, s.a), s.b), p), q);
  }
  for (const p of prims(s)) primBox(p, b);
  if (s.kind === 'poly' && s.pts.length === 1) boxAdd(b, s.pts[0]);
  return b;
}

/** where a dimension's line is drawn */
export function dimLine(s: { a: Pt; b: Pt; off: number }): [Pt, Pt] {
  const d = sub(s.b, s.a), l = len(d) || 1;
  const n = { x: (-d.y / l) * s.off, y: (d.x / l) * s.off };
  return [add(s.a, n), add(s.b, n)];
}

export function closestOnPrim(p: Prim, q: Pt): Pt {
  if (p.t === 'seg') {
    const d = sub(p.b, p.a), l2 = dot(d, d);
    const t = l2 < EPS ? 0 : Math.min(1, Math.max(0, dot(sub(q, p.a), d) / l2));
    return lerp(p.a, p.b, t);
  }
  const a = Math.atan2(q.y - p.c.y, q.x - p.c.x);
  if (onSweep(a, p.a0, p.sweep)) return polar(p.c, p.r, a);
  const e0 = polar(p.c, p.r, p.a0), e1 = polar(p.c, p.r, p.a0 + p.sweep);
  return dist(q, e0) < dist(q, e1) ? e0 : e1;
}

/** distance from q to the shape's outline (dimensions: to their line and extension lines) */
export function shapeDistance(s: Shape, q: Pt): number {
  if (s.kind === 'dim') {
    const [p0, p1] = dimLine(s);
    return Math.min(...[[p0, p1], [s.a, p0], [s.b, p1]].map(([a, b]) => dist(q, closestOnPrim({ t: 'seg', a, b }, q))));
  }
  let d = Infinity;
  for (const p of prims(s)) d = Math.min(d, dist(q, closestOnPrim(p, q)));
  if (s.kind === 'poly' && s.pts.length === 1) d = dist(q, s.pts[0]);
  return d;
}

/** intersection points of two primitives */
export function intersect(p: Prim, q: Prim): Pt[] {
  if (p.t === 'seg' && q.t === 'seg') {
    const r = sub(p.b, p.a), s = sub(q.b, q.a), den = cross(r, s);
    if (Math.abs(den) < EPS) return [];
    const t = cross(sub(q.a, p.a), s) / den, u = cross(sub(q.a, p.a), r) / den;
    return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? [lerp(p.a, p.b, t)] : [];
  }
  if (p.t === 'arc' && q.t === 'seg') return intersect(q, p);
  if (p.t === 'seg' && q.t === 'arc') {
    const d = sub(p.b, p.a), f = sub(p.a, q.c);
    const A = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - q.r * q.r;
    const disc = B * B - 4 * A * C;
    if (A < EPS || disc < -1e-9) return [];
    const sq = Math.sqrt(Math.max(0, disc));
    const ts = disc < 1e-12 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
    return ts.filter((t) => t >= -1e-9 && t <= 1 + 1e-9).map((t) => lerp(p.a, p.b, t)).filter((x) => onSweep(Math.atan2(x.y - q.c.y, x.x - q.c.x), q.a0, q.sweep));
  }
  // arc – arc
  const a = p as Extract<Prim, { t: 'arc' }>, b = q as Extract<Prim, { t: 'arc' }>;
  const d = dist(a.c, b.c);
  if (d < EPS || d > a.r + b.r + 1e-9 || d < Math.abs(a.r - b.r) - 1e-9) return [];
  const x = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
  const h = Math.sqrt(Math.max(0, a.r * a.r - x * x));
  const u = mul(sub(b.c, a.c), 1 / d), m = add(a.c, mul(u, x));
  const pts = h < 1e-9 ? [m] : [add(m, { x: -u.y * h, y: u.x * h }), add(m, { x: u.y * h, y: -u.x * h })];
  return pts.filter((x) => onSweep(Math.atan2(x.y - a.c.y, x.x - a.c.x), a.a0, a.sweep) && onSweep(Math.atan2(x.y - b.c.y, x.x - b.c.x), b.a0, b.sweep));
}

/** centre of the circle through three points, or null if they are in a line */
export function circleThrough(p: Pt, q: Pt, r: Pt): Pt | null {
  const d = 2 * (p.x * (q.y - r.y) + q.x * (r.y - p.y) + r.x * (p.y - q.y));
  if (Math.abs(d) < 1e-9) return null;
  const p2 = p.x * p.x + p.y * p.y, q2 = q.x * q.x + q.y * q.y, r2 = r.x * r.x + r.y * r.y;
  return { x: (p2 * (q.y - r.y) + q2 * (r.y - p.y) + r2 * (p.y - q.y)) / d, y: (p2 * (r.x - q.x) + q2 * (p.x - r.x) + r2 * (q.x - p.x)) / d };
}

/** arc from p through m to q (3-point arc), or null if the points are in a line */
export function arc3(p: Pt, m: Pt, q: Pt): Extract<Shape, { kind: 'arc' }> | null {
  const c = circleThrough(p, m, q);
  if (!c) return null;
  const r = dist(c, p);
  const ap = Math.atan2(p.y - c.y, p.x - c.x), am = Math.atan2(m.y - c.y, m.x - c.x), aq = Math.atan2(q.y - c.y, q.x - c.x);
  // CCW from p to q passes through m? otherwise it is the CCW arc from q to p
  return onSweep(am, ap, ccwSweep(ap, aq)) ? { kind: 'arc', c, r, a0: ap, a1: aq } : { kind: 'arc', c, r, a0: aq, a1: ap };
}

/** signed area of a closed point list (+ = CCW) */
export function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) a += cross(pts[i], pts[(i + 1) % n]);
  return a / 2;
}

/** is the shape a closed outline (usable as a pocket / profile boundary) */
export const isClosed = (s: Shape) => s.kind === 'circle' || (s.kind === 'poly' && s.closed && s.pts.length >= 2);

/** start and end points of an open shape (for joining into chains), or null for closed / dims */
export function ends(s: Shape): [Pt, Pt] | null {
  if (s.kind === 'line') return [s.a, s.b];
  if (s.kind === 'arc') return [polar(s.c, s.r, s.a0), polar(s.c, s.r, s.a1)];
  if (s.kind === 'poly' && !s.closed && s.pts.length >= 2) return [s.pts[0], s.pts[s.pts.length - 1]];
  return null;
}

/** total length of the outline */
export function shapeLength(s: Shape): number {
  let l = 0;
  for (const p of prims(s)) l += p.t === 'seg' ? dist(p.a, p.b) : p.r * p.sweep;
  return l;
}
