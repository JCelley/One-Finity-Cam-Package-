import { dist, flatten, signedArea, type Pt, type Shape } from '../../cad/geom';
import { joinShapes, type Entity } from '../../cad/doc';
import type { Move } from '../toolpath';

/**
 * Shared pieces for the 2.5D operations. Depths are positive mm below the top of the stock;
 * `Ctx.z(d)` turns a depth into a machine Z in the job's work coordinates.
 */

export interface Ctx {
  /** depth below the stock top → work Z */
  z: (depth: number) => number;
  /** retract height (work Z) */
  safeZ: number;
  /** rapids down stop this far above the material (mm) */
  clear: number;
  /** flattening tolerance for arcs (mm) */
  tol: number;
  /** a length for messages, in the user's units (default mm) */
  fmt?: (mm: number) => string;
}

export const fmtMm = (mm: number) => `${+mm.toFixed(2)} mm`;

export const DEFAULT_TOL = 0.005;

/** a contour as a point loop / polyline in drawing order */
export interface Contour {
  pts: Pt[];
  closed: boolean;
}

/**
 * Turns the chosen drawing items into contours: closed shapes as loops, loose lines and arcs
 * chained where their ends meet (closing into loops when they come back round). Dimensions are
 * ignored.
 */
export function contoursOf(items: Entity[], tol = DEFAULT_TOL): Contour[] {
  const geo = items.filter((e) => e.kind !== 'dim');
  const { joined, used } = joinShapes(geo, 0.01);
  const all: Shape[] = [...geo.filter((e) => !used.has(e.id)), ...joined];
  const out: Contour[] = [];
  for (const s of all) {
    const f = flatten(s, tol);
    const pts = dedupe(f.pts, f.closed);
    if (pts.length >= (f.closed ? 3 : 2)) out.push({ pts, closed: f.closed });
  }
  return out;
}

/** drops repeated points (and the closing duplicate of a loop) */
export function dedupe(pts: Pt[], closed: boolean, eps = 1e-6): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) if (!out.length || dist(out[out.length - 1], p) > eps) out.push(p);
  if (closed && out.length > 1 && dist(out[0], out[out.length - 1]) <= eps) out.pop();
  return out;
}

/** a loop turned to run counter-clockwise (ccw = true) or clockwise */
export function orient(pts: Pt[], ccw: boolean): Pt[] {
  return signedArea(pts) > 0 === ccw ? pts : [...pts].reverse();
}

/** the loop started from the middle of its longest edge (a calm place to ramp in) */
export function startOnLongestEdge(pts: Pt[]): Pt[] {
  let best = 0, bl = -1;
  for (let i = 0; i < pts.length; i++) {
    const l = dist(pts[i], pts[(i + 1) % pts.length]);
    if (l > bl) {
      bl = l;
      best = i;
    }
  }
  const a = pts[best], b = pts[(best + 1) % pts.length];
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return [m, ...pts.slice(best + 1), ...pts.slice(0, best + 1)];
}

/** the loop started at its point nearest to p (on an edge if that is nearer than any corner) */
export function startNear(pts: Pt[], p: Pt): Pt[] {
  let best = 0, bd = Infinity, bq: Pt = pts[0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = dist(p, q);
    if (d < bd - 1e-9) {
      bd = d;
      best = i;
      bq = q;
    }
  }
  const rest = [...pts.slice(best + 1), ...pts.slice(0, best + 1)];
  // drop a corner the new start sits on
  return dedupe([bq, ...rest], true);
}

export const loopLength = (pts: Pt[], closed = true) => {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return closed && pts.length > 1 ? l + dist(pts[pts.length - 1], pts[0]) : l;
};

/** depths of the passes from `top` down to `bottom`, evenly spaced, none more than `stepdown` apart */
export function levels(top: number, bottom: number, stepdown: number): number[] {
  const span = bottom - top;
  if (!(span > 1e-9)) return [];
  const n = Math.max(1, Math.ceil(span / Math.max(0.01, stepdown) - 1e-9));
  return Array.from({ length: n }, (_, k) => top + (span * (k + 1)) / n);
}

/** a point at arc length s along a loop (s may run past one lap) */
export class LoopWalker {
  readonly cum: number[];
  readonly P: number;
  constructor(readonly pts: Pt[]) {
    this.cum = [0];
    for (let i = 1; i <= pts.length; i++) this.cum.push(this.cum[i - 1] + dist(pts[i - 1], pts[i % pts.length]));
    this.P = this.cum[pts.length];
  }
  at(s: number): Pt {
    const u = ((s % this.P) + this.P) % this.P;
    let lo = 0, hi = this.pts.length;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.cum[m] <= u) lo = m;
      else hi = m;
    }
    const a = this.pts[lo], b = this.pts[(lo + 1) % this.pts.length];
    const seg = this.cum[lo + 1] - this.cum[lo];
    const t = seg > 0 ? (u - this.cum[lo]) / seg : 0;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  /** arc lengths of the vertices between s0 and s1 (exclusive), over as many laps as needed */
  vertices(s0: number, s1: number): number[] {
    const out: number[] = [];
    const lap0 = Math.floor(s0 / this.P);
    for (let lap = lap0; lap * this.P < s1; lap++)
      for (let i = 0; i < this.pts.length; i++) {
        const s = lap * this.P + this.cum[i];
        if (s > s0 + 1e-9 && s < s1 - 1e-9) out.push(s);
      }
    return out;
  }
}

/**
 * Feed moves along a loop from arc length s0 to s1 with depth d(s). `breaks` are arc lengths where
 * d jumps (tab edges): there the tool moves straight up or down. Plunging moves (going down
 * steeply) use the plunge rate.
 */
export function walkLoop(w: LoopWalker, s0: number, s1: number, d: (s: number) => number, breaks: number[], ctx: Ctx, out: Move[]) {
  const marks = new Set<number>(w.vertices(s0, s1));
  const jumps = new Set<number>();
  for (const b of breaks)
    if (b > s0 + 1e-9 && b < s1 - 1e-9) {
      marks.add(b);
      jumps.add(b);
    }
  marks.add(s1);
  let prev = { s: s0, d: d(s0) };
  for (const s of [...marks].sort((a, b) => a - b)) {
    const p = w.at(s);
    const dl = d(s - 1e-7), dr = d(s + 1e-7);
    // only tab edges are jumps; a ramp's slope is not
    const here = jumps.has(s) && Math.abs(dl - dr) > 1e-6;
    const dEnd = here ? dl : d(s);
    pushFeed(out, p, ctx.z(dEnd), dEnd - prev.d > 0.5 && dEnd - prev.d > 2 * (s - prev.s) ? 'plunge' : 'cut');
    if (here) out.push({ kind: 'feed', x: p.x, y: p.y, z: ctx.z(dr), rate: dr > dl ? 'plunge' : 'cut' });
    prev = { s, d: here ? dr : dEnd };
  }
}

export function pushFeed(out: Move[], p: Pt, z: number, rate: 'cut' | 'plunge' = 'cut') {
  out.push({ kind: 'feed', x: p.x, y: p.y, z, rate });
}

/** retract, go across, rapid down to just above the material at depth `above` */
export function approach(out: Move[], p: Pt, above: number, ctx: Ctx) {
  out.push({ kind: 'rapid', z: ctx.safeZ });
  out.push({ kind: 'rapid', x: p.x, y: p.y });
  out.push({ kind: 'rapid', z: Math.min(ctx.safeZ, ctx.z(above) + ctx.clear) });
}

export const retract = (out: Move[], ctx: Ctx) => out.push({ kind: 'rapid', z: ctx.safeZ });

/**
 * Back-and-forth ramp along the segment a→b from depth d0 to d1 (ending back at a), for entering
 * an open cut without plunging. Falls back to a plunge when the segment is too short.
 */
export function rampOnSegment(out: Move[], a: Pt, b: Pt, d0: number, d1: number, tanA: number, ctx: Ctx, minLen: number) {
  const L = dist(a, b);
  if (tanA <= 0 || L < minLen) {
    pushFeed(out, a, ctx.z(d1), 'plunge');
    return;
  }
  const drop = d1 - d0;
  const passes = Math.ceil(drop / (2 * L * tanA) - 1e-9);
  const per = drop / (2 * passes);
  let d = d0;
  for (let k = 0; k < passes; k++) {
    d += per;
    pushFeed(out, b, ctx.z(d));
    d += per;
    pushFeed(out, a, ctx.z(d));
  }
}

/** does the segment a→b cross any of the loops (touching at its own ends allowed) */
export function crossesLoops(a: Pt, b: Pt, loops: Pt[][]): boolean {
  const ex = { x: b.x - a.x, y: b.y - a.y };
  for (const L of loops)
    for (let i = 0; i < L.length; i++) {
      const p = L[i], q = L[(i + 1) % L.length];
      const ey = { x: q.x - p.x, y: q.y - p.y };
      const den = ex.x * ey.y - ex.y * ey.x;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((p.x - a.x) * ey.y - (p.y - a.y) * ey.x) / den;
      const u = ((p.x - a.x) * ex.y - (p.y - a.y) * ex.x) / den;
      if (t > 1e-6 && t < 1 - 1e-6 && u >= -1e-9 && u <= 1 + 1e-9) return true;
    }
  return false;
}

/** point in region made of loops, even-odd */
export function inRegion(p: Pt, loops: Pt[][]): boolean {
  let inside = false;
  for (const L of loops)
    for (let i = 0, j = L.length - 1; i < L.length; j = i++) {
      const a = L[i], b = L[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  return inside;
}
