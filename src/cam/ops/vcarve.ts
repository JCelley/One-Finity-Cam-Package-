import { dist, type Pt } from '../../cad/geom';
import { offsetShapes, regionLoops } from '../../cad/ops';
import type { Move } from '../toolpath';
import { approach, dedupe, fmtMm, levels, pushFeed, retract, type Ctx } from './contour';

/**
 * V-carving by largest inscribed circles.
 *
 * Walk round every boundary loop of the region (material on the left). At each point p with
 * inward normal n, find the biggest circle that touches the boundary at p and fits inside the
 * region: its centre c = p + n·r is where the V-bit's tip goes, at the depth where the cone's
 * width at the boundary plane equals 2r. The tip therefore follows the region's medial axis and
 * the cone just touches every wall: sharp inside corners, correct V walls, one pass.
 *
 * Depth is capped (`maxDepth`); where the circle would need to be deeper, the tool runs at the cap
 * and the middle is left flat: `flat` returns that area so another tool can clear it.
 * `startDepth` (for inlay plugs) puts the boundary plane that far below the surface.
 */

export interface VcarveTool {
  /** half the included angle, radians */
  half: number;
  /** radius of the flat at the tip (0 = sharp) */
  tipR: number;
}

export interface VcarveOpts {
  maxDepth: number;
  startDepth: number;
  /** deepest cut per pass (mm); 0 = all in one pass */
  stepdown: number;
  /** sample spacing along the boundary (mm) */
  spacing: number;
}

export interface VcarveResult {
  moves: Move[];
  /** loops of the area left flat at maxDepth (needs a clearing tool), empty if none */
  flat: Pt[][];
  /** deepest point reached */
  deepest: number;
  warnings: string[];
}

interface Seg {
  a: Pt;
  b: Pt;
  m: Pt; // unit normal
  h: number; // m·a
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** radius at which a circle with centre p + n·t, radius t, first touches segment s (Infinity if never) */
function touch(p: Pt, n: Pt, s: Seg): number {
  // p on this segment (a sample at a corner, on the neighbouring edge): if the segment runs off
  // into the side the circle grows towards, the circle crosses it at once: no room at all
  {
    const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, l2 = dx * dx + dy * dy;
    const u = Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / l2));
    if (Math.hypot(p.x - s.a.x - u * dx, p.y - s.a.y - u * dy) < 1e-7) {
      const into = (q: Pt) => n.x * (q.x - p.x) + n.y * (q.y - p.y) > 1e-9;
      return into(s.a) || into(s.b) ? 0 : Infinity;
    }
  }
  let t = Infinity;
  for (const q of [s.a, s.b]) {
    const dx = q.x - p.x, dy = q.y - p.y;
    const den = 2 * (n.x * dx + n.y * dy);
    if (den > 1e-12) {
      const v = (dx * dx + dy * dy) / den;
      if (v > 1e-7 && v < t) t = v;
    }
  }
  const mp = s.m.x * p.x + s.m.y * p.y - s.h, mn = s.m.x * n.x + s.m.y * n.y;
  for (const sg of [1, -1]) {
    const den = sg - mn;
    if (Math.abs(den) < 1e-12) continue;
    const v = mp / den;
    if (!(v > 1e-7) || v >= t) continue;
    // the tangent point must lie on the segment
    const c = { x: p.x + n.x * v, y: p.y + n.y * v };
    const off = s.m.x * c.x + s.m.y * c.y - s.h;
    const f = { x: c.x - s.m.x * off, y: c.y - s.m.y * off };
    const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, l2 = dx * dx + dy * dy;
    const u = ((f.x - s.a.x) * dx + (f.y - s.a.y) * dy) / l2;
    if (u >= -1e-9 && u <= 1 + 1e-9) t = v;
  }
  return t;
}

/** biggest inscribed circle radius at p along n, capped at rCap */
function inscribed(p: Pt, n: Pt, segs: Seg[], rCap: number): number {
  let best = rCap;
  for (const s of segs) {
    // the circle reaches at most 2·best from p: skip segments further than that
    const dx = Math.max(s.x0 - p.x, 0, p.x - s.x1), dy = Math.max(s.y0 - p.y, 0, p.y - s.y1);
    if (dx * dx + dy * dy >= 4 * best * best) continue;
    const t = touch(p, n, s);
    if (t < best) best = t;
  }
  return best;
}

export function vcarveRegion(loops: Pt[][], tool: VcarveTool, o: VcarveOpts, ctx: Ctx): VcarveResult {
  const warnings: string[] = [];
  const tanH = Math.tan(tool.half);
  const rCap = Math.max(0, o.maxDepth - o.startDepth) * tanH + tool.tipR;
  const segs: Seg[] = [];
  for (const L of loops)
    for (let i = 0; i < L.length; i++) {
      const a = L[i], b = L[(i + 1) % L.length], l = dist(a, b);
      if (l < 1e-9) continue;
      const m = { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
      segs.push({ a, b, m, h: m.x * a.x + m.y * a.y, x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) });
    }
  const depthAt = (r: number) => Math.min(o.maxDepth, o.startDepth + Math.max(0, r - tool.tipR) / tanH);
  let capped = false, deepest = 0;
  type S = { p: Pt; n: Pt; c: Pt; d: number };
  const at = (p: Pt, n: Pt): S => {
    const r = inscribed(p, n, segs, rCap);
    if (r >= rCap - 1e-9) capped = true;
    const d = depthAt(r);
    deepest = Math.max(deepest, d);
    return { p, n, c: { x: p.x + n.x * r, y: p.y + n.y * r }, d };
  };
  const norm = (v: Pt) => {
    const l = Math.hypot(v.x, v.y) || 1;
    return { x: v.x / l, y: v.y / l };
  };

  const paths: { x: number; y: number; d: number }[][] = [];
  for (const L of loops) {
    const n = L.length;
    const base: S[] = [];
    for (let i = 0; i < n; i++) {
      const a = L[i], b = L[(i + 1) % n], c = L[(i + 2) % n];
      const l = dist(a, b);
      if (l < 1e-9) continue;
      const u = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
      const nrm = { x: -u.y, y: u.x };
      const k = Math.max(1, Math.ceil(l / o.spacing));
      for (let j = 0; j < k; j++) base.push(at({ x: a.x + u.x * (l * j) / k, y: a.y + u.y * (l * j) / k }, nrm));
      // a right turn at b is a corner sticking into the material: sweep the normal round it
      const l2 = dist(b, c);
      if (l2 < 1e-9) continue;
      const u2 = { x: (c.x - b.x) / l2, y: (c.y - b.y) / l2 };
      const turn = u.x * u2.y - u.y * u2.x;
      if (turn < -1e-9) {
        const a0 = Math.atan2(nrm.y, nrm.x), a1 = Math.atan2(u2.x, -u2.y);
        let sw = a1 - a0;
        while (sw > 0) sw -= 2 * Math.PI;
        while (sw < -2 * Math.PI) sw += 2 * Math.PI;
        const steps = Math.max(1, Math.ceil(Math.abs(sw) / (Math.PI / 18)));
        for (let j = 0; j <= steps; j++) {
          const ang = a0 + (sw * j) / steps;
          base.push(at(b, { x: Math.cos(ang), y: Math.sin(ang) }));
        }
      }
    }
    if (base.length < 2) continue;
    // refine where the tip jumps: bisect between samples whose centres are far apart
    const out: S[] = [];
    const refine = (s0: S, s1: S, depth: number) => {
      if (depth < 7 && dist(s0.c, s1.c) > 3 * o.spacing && dist(s0.p, s1.p) + Math.hypot(s0.n.x - s1.n.x, s0.n.y - s1.n.y) > 1e-6) {
        const m = at({ x: (s0.p.x + s1.p.x) / 2, y: (s0.p.y + s1.p.y) / 2 }, norm({ x: s0.n.x + s1.n.x, y: s0.n.y + s1.n.y }));
        refine(s0, m, depth + 1);
        refine(m, s1, depth + 1);
      } else out.push(s1);
    };
    out.push(base[0]);
    for (let i = 0; i < base.length; i++) refine(base[i], base[(i + 1) % base.length], 0);
    paths.push(simplify3(out.map((s) => ({ x: s.c.x, y: s.c.y, d: s.d })), 0.01));
  }

  // cut each loop's path pass by pass, nearest loop next
  const moves: Move[] = [];
  const passes = levels(0, deepest, o.stepdown > 0 ? o.stepdown : deepest + 1);
  const order = nearestOrder(paths);
  for (const path of order) {
    const p0 = path[0];
    approach(moves, p0, 0, ctx);
    for (const cap of passes.length ? passes : [deepest]) {
      pushFeed(moves, p0, ctx.z(Math.min(p0.d, cap)), 'plunge');
      for (let i = 1; i < path.length; i++) pushFeed(moves, path[i], ctx.z(Math.min(path[i].d, cap)));
    }
    retract(moves, ctx);
  }

  let flat: Pt[][] = [];
  if (capped) {
    // the area further than rCap from the boundary stays at maxDepth: offset the region inward
    const shapes = offsetShapes(loops.map((l) => ({ kind: 'poly' as const, pts: l, closed: true })), -rCap, ctx.tol);
    flat = shapes.map((s) => (s.kind === 'poly' ? dedupe(s.pts, true) : [])).filter((l) => l.length >= 3);
  }
  return { moves, flat, deepest, warnings: [...warnings, ...(deepest < 1e-6 && paths.length ? [`The V-bit's flat tip (${(ctx.fmt ?? fmtMm)(2 * tool.tipR)}) is wider than the shapes: nothing is carved`] : [])] };
}

/** Douglas–Peucker on (x, y, depth) points; keeps the ends */
function simplify3(pts: { x: number; y: number; d: number }[], tol: number) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = pts[i], b = pts[j];
    const ab = { x: b.x - a.x, y: b.y - a.y, d: b.d - a.d };
    const l2 = ab.x * ab.x + ab.y * ab.y + ab.d * ab.d;
    let worst = -1, wd = tol;
    for (let k = i + 1; k < j; k++) {
      const p = pts[k];
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.d - a.d) * ab.d) / l2)) : 0;
      const e = Math.hypot(p.x - a.x - ab.x * t, p.y - a.y - ab.y * t, p.d - a.d - ab.d * t);
      if (e > wd) {
        wd = e;
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

function nearestOrder<T extends { x: number; y: number }>(paths: T[][]): T[][] {
  const left = [...paths];
  const out: T[][] = [];
  let at = { x: 0, y: 0 };
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((p, i) => {
      const d = Math.hypot(p[0].x - at.x, p[0].y - at.y);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    });
    const p = left.splice(bi, 1)[0];
    out.push(p);
    at = p[p.length - 1];
  }
  return out;
}

/** region loops for the inside of the given closed outlines */
export const insideRegion = (outlines: Pt[][], tol: number) => regionLoops(outlines.map((pts) => ({ kind: 'poly', pts, closed: true })), tol);
