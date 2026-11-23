import { FillRule, JoinType, EndType, unionD, differenceD, intersectD, xorD, inflatePathsD, type PathsD } from 'clipper2-ts';
import { flatten, isClosed, normAngle, signedArea, type Pt, type Shape } from './geom';

/**
 * Transforms and region operations on shapes.
 *
 * Transforms are similarity transforms only (move, rotate, uniform scale, mirror), so circles
 * stay circles and arcs stay arcs. A transform is x' = a·x + c·y + e, y' = b·x + d·y + f.
 */
export interface Xform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const translate = (dx: number, dy: number): Xform => ({ a: 1, b: 0, c: 0, d: 1, e: dx, f: dy });
export const rotateAbout = (p: Pt, ang: number): Xform => {
  const cs = Math.cos(ang), sn = Math.sin(ang);
  return { a: cs, b: sn, c: -sn, d: cs, e: p.x - cs * p.x + sn * p.y, f: p.y - sn * p.x - cs * p.y };
};
export const scaleAbout = (p: Pt, k: number): Xform => ({ a: k, b: 0, c: 0, d: k, e: p.x * (1 - k), f: p.y * (1 - k) });
/** mirror across the line through p at angle ang */
export const mirrorAcross = (p: Pt, ang: number): Xform => {
  const c2 = Math.cos(2 * ang), s2 = Math.sin(2 * ang);
  return { a: c2, b: s2, c: s2, d: -c2, e: p.x - c2 * p.x - s2 * p.y, f: p.y - s2 * p.x + c2 * p.y };
};

const ap = (m: Xform, p: Pt): Pt => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });

/** applies a similarity transform; the result is a new shape of the same kind */
export function transformShape<S extends Shape>(s: S, m: Xform): S {
  const det = m.a * m.d - m.b * m.c;
  const k = Math.sqrt(Math.abs(det));
  const flip = det < 0;
  // how a direction angle maps: rotation by rot, then reflected if flip
  const rot = Math.atan2(m.b, m.a);
  const mapAng = (t: number) => (flip ? rot - t : rot + t);
  const out = structuredClone(s) as Shape;
  switch (out.kind) {
    case 'line':
      out.a = ap(m, out.a);
      out.b = ap(m, out.b);
      break;
    case 'dim':
      out.a = ap(m, out.a);
      out.b = ap(m, out.b);
      out.off *= flip ? -k : k;
      break;
    case 'circle':
      out.c = ap(m, out.c);
      out.r *= k;
      break;
    case 'arc': {
      out.c = ap(m, out.c);
      out.r *= k;
      const a0 = normAngle(mapAng(out.a0)), a1 = normAngle(mapAng(out.a1));
      // a mirror turns a CCW arc into a CW one: swap the ends to keep it CCW
      if (flip) [out.a0, out.a1] = [a1, a0];
      else [out.a0, out.a1] = [a0, a1];
      break;
    }
    case 'poly':
      out.pts = out.pts.map((v) => {
        const p = ap(m, v);
        return v.b ? { ...p, b: flip ? -v.b : v.b } : p;
      });
      break;
  }
  return out as S;
}

// ---- offsets and booleans (Clipper2) ------------------------------------------------------------

export type BoolOp = 'union' | 'difference' | 'intersection' | 'xor';

const toPaths = (shapes: Shape[], tol: number): PathsD =>
  shapes.filter(isClosed).map((s) => flatten(s, tol).pts.map((p) => ({ x: p.x, y: p.y })));

const toShapes = (paths: PathsD): Shape[] =>
  paths.filter((p) => p.length >= 3).map((p) => ({ kind: 'poly', pts: p.map((q) => ({ x: q.x, y: q.y })), closed: true }));

/** decimal places Clipper keeps (1e-4 mm) */
const PREC = 4;

/**
 * Boolean of closed shapes: `a` is the subject (all of a's shapes together), `b` the clip.
 * Arcs are flattened to within `tol` mm first, so the result is made of straight segments.
 */
export function booleanShapes(op: BoolOp, a: Shape[], b: Shape[], tol = 0.01): Shape[] {
  const A = toPaths(a, tol), B = toPaths(b, tol);
  const r =
    op === 'union' ? unionD(A, B, FillRule.NonZero, PREC)
    : op === 'difference' ? differenceD(A, B, FillRule.NonZero, PREC)
    : op === 'intersection' ? intersectD(A, B, FillRule.NonZero, PREC)
    : xorD(A, B, FillRule.NonZero, PREC);
  return toShapes(r);
}

/**
 * Offsets closed shapes by `delta` mm (+ = outward, − = inward), round corners. Holes inside
 * outlines are handled as regions (even-odd), as for a pocket boundary.
 */
export function offsetShapes(shapes: Shape[], delta: number, tol = 0.01, corners: 'round' | 'miter' | 'square' = 'round'): Shape[] {
  const paths = toPaths(shapes, tol);
  // even-odd regions first, so nested outlines become islands
  const regions = unionD(paths, [], FillRule.EvenOdd, PREC);
  const jt = corners === 'round' ? JoinType.Round : corners === 'miter' ? JoinType.Miter : JoinType.Square;
  return toShapes(inflatePathsD(regions, delta, jt, EndType.Polygon, 2, PREC, tol));
}

/** total area of closed shapes as regions (even-odd), mm² */
export function regionArea(shapes: Shape[], tol = 0.01): number {
  return unionD(toPaths(shapes, tol), [], FillRule.EvenOdd, PREC).reduce((s, p) => s + signedArea(p), 0);
}

/**
 * Closed shapes as a clean region (even-odd: nested outlines are holes): outer loops
 * counter-clockwise, holes clockwise, so the material is always on the left of each loop.
 */
export function regionLoops(shapes: Shape[], tol = 0.01): Pt[][] {
  return unionD(toPaths(shapes, tol), [], FillRule.EvenOdd, PREC)
    .filter((p) => p.length >= 3)
    .map((p) => p.map((q) => ({ x: q.x, y: q.y })));
}

/**
 * Closed shapes merged by the non-zero rule (how fonts fill their outlines: overlapping strokes
 * join, counters stay holes), returned as clean loops: outer CCW, holes CW.
 */
export function unionNonZero(shapes: Shape[], tol = 0.01): Shape[] {
  return toShapes(unionD(toPaths(shapes, tol), [], FillRule.NonZero, PREC));
}
