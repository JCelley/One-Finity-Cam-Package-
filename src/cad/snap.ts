import { dimLine, dist, intersect, lerp, polar, prims, primBox, shapeBox, type Prim, type Pt, type Shape } from './geom';

export type SnapKind = 'end' | 'mid' | 'center' | 'quadrant' | 'intersection' | 'nearest' | 'grid';

export interface SnapOpts {
  /** search radius around the cursor (mm, i.e. screen pixels / zoom) */
  radius: number;
  /** grid spacing (mm); 0 = no grid snapping */
  grid: number;
  kinds: Partial<Record<SnapKind, boolean>>;
}

export interface Snap {
  p: Pt;
  kind: SnapKind;
}

const ALL: Record<SnapKind, boolean> = { end: true, mid: true, center: true, quadrant: true, intersection: true, nearest: false, grid: true };

/** order of preference when two candidates are about equally close */
const RANK: Record<SnapKind, number> = { end: 0, intersection: 1, center: 2, mid: 3, quadrant: 4, nearest: 5, grid: 6 };

/**
 * Best snap point near the cursor: endpoints, midpoints, centres, quadrants and intersections of
 * the shapes near it, then the nearest point on a shape, then the grid. Null = free point.
 */
export function findSnap(shapes: Shape[], q: Pt, o: SnapOpts): Snap | null {
  const on = { ...ALL, ...o.kinds };
  const r = o.radius;
  const cands: Snap[] = [];
  const nearPrims: Prim[] = [];
  for (const s of shapes) {
    const b = shapeBox(s);
    if (q.x < b.x0 - r || q.x > b.x1 + r || q.y < b.y0 - r || q.y > b.y1 + r) continue;
    if (s.kind === 'dim') {
      if (on.end) cands.push({ p: s.a, kind: 'end' }, { p: s.b, kind: 'end' });
      continue;
    }
    if (on.center && (s.kind === 'circle' || s.kind === 'arc')) cands.push({ p: s.c, kind: 'center' });
    for (const p of prims(s)) {
      const pb = primBox(p);
      if (q.x < pb.x0 - r || q.x > pb.x1 + r || q.y < pb.y0 - r || q.y > pb.y1 + r) continue;
      nearPrims.push(p);
      if (p.t === 'seg') {
        if (on.end) cands.push({ p: p.a, kind: 'end' }, { p: p.b, kind: 'end' });
        if (on.mid) cands.push({ p: lerp(p.a, p.b, 0.5), kind: 'mid' });
      } else {
        const full = p.sweep >= Math.PI * 2 - 1e-9;
        if (on.end && !full) cands.push({ p: polar(p.c, p.r, p.a0), kind: 'end' }, { p: polar(p.c, p.r, p.a0 + p.sweep), kind: 'end' });
        if (on.mid && !full) cands.push({ p: polar(p.c, p.r, p.a0 + p.sweep / 2), kind: 'mid' });
        if (on.center && s.kind === 'poly') cands.push({ p: p.c, kind: 'center' });
        if (on.quadrant)
          for (let k = 0; k < 4; k++) {
            const a = (k * Math.PI) / 2;
            const d = (((a - p.a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
            if (full || d <= p.sweep) cands.push({ p: polar(p.c, p.r, a), kind: 'quadrant' });
          }
      }
    }
  }
  if (on.intersection && nearPrims.length < 400)
    for (let i = 0; i < nearPrims.length; i++)
      for (let j = i + 1; j < nearPrims.length; j++) for (const p of intersect(nearPrims[i], nearPrims[j])) cands.push({ p, kind: 'intersection' });

  let best: Snap | null = null, bestD = Infinity;
  for (const c of cands) {
    const d = dist(c.p, q);
    if (d > r) continue;
    // within a fifth of the radius, the better kind wins
    const score = d + RANK[c.kind] * r * 0.05;
    if (score < bestD) {
      bestD = score;
      best = c;
    }
  }
  if (best) return best;
  if (on.nearest) {
    for (const s of shapes) {
      if (s.kind === 'dim') continue;
      for (const p of prims(s)) {
        const c = closest(p, q);
        const d = dist(c, q);
        if (d <= r && d < bestD) {
          bestD = d;
          best = { p: c, kind: 'nearest' };
        }
      }
    }
    if (best) return best;
  }
  if (on.grid && o.grid > 0) return { p: { x: Math.round(q.x / o.grid) * o.grid, y: Math.round(q.y / o.grid) * o.grid }, kind: 'grid' };
  return null;
}

function closest(p: Prim, q: Pt): Pt {
  if (p.t === 'seg') {
    const dx = p.b.x - p.a.x, dy = p.b.y - p.a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.min(1, Math.max(0, ((q.x - p.a.x) * dx + (q.y - p.a.y) * dy) / l2)) : 0;
    return lerp(p.a, p.b, t);
  }
  return polar(p.c, p.r, Math.atan2(q.y - p.c.y, q.x - p.c.x));
}

/** points a dimension can be picked by (for hit tests on its text) */
export const dimAnchor = (s: Extract<Shape, { kind: 'dim' }>) => {
  const [p, q] = dimLine(s);
  return lerp(p, q, 0.5);
};
