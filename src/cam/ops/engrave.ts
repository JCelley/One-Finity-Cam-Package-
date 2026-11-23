import { dist, type Pt } from '../../cad/geom';
import type { Entity } from '../../cad/doc';
import type { Move } from '../toolpath';
import { approach, contoursOf, dedupe, levels, pushFeed, retract, startNear, type Ctx } from './contour';
import type { OpResult } from './profile';

export interface EngraveParams {
  /** depth of the groove below the stock top (mm) */
  depth: number;
  /** depth the cut starts from (mm below the stock top), normally 0 */
  top: number;
  /** most per pass; 0 = the whole depth in one pass */
  stepdown: number;
  /** between strokes the tool lifts this far above the stock top, not to the safe height (mm) */
  lift: number;
}

export const ENGRAVE_DEFAULTS: EngraveParams = { depth: 1, top: 0, stepdown: 0, lift: 2 };

/**
 * Engraving: the tool follows each line itself (no offset), for single-line lettering, layout
 * lines and signatures. Strokes are cut in nearest-next order, open ones from whichever end is
 * closer, loops from their nearest point. Each stroke is cut pass by pass (open ones back and
 * forth), then the tool lifts just clear of the stock to the next one; it goes up to the safe
 * height only at the start and the end.
 */
export function engraveOp(items: Entity[], p: EngraveParams, ctx: Ctx): OpResult {
  const warnings: string[] = [];
  const out: Move[] = [];
  const passes = levels(p.top, p.depth, p.stepdown > 0 ? p.stepdown : Infinity);
  if (!passes.length) return { moves: [], warnings: ['Depth must be below the start depth'] };
  const strokes = contoursOf(items, ctx.tol)
    .map((c) => ({ pts: dedupe(c.pts, c.closed), closed: c.closed }))
    .filter((c) => c.pts.length >= (c.closed ? 3 : 2));
  if (!strokes.length) return { moves: [], warnings: ['Nothing to cut: pick lines or single-line text in the drawing'] };

  const hop = Math.min(ctx.safeZ, ctx.z(p.top) + Math.max(ctx.clear, p.lift));
  let at: Pt = { x: 0, y: 0 };
  const left = [...strokes];
  let first = true;
  while (left.length) {
    // the nearest stroke, entered at its nearest end (open) or point (loop)
    let bi = 0, bd = Infinity, flip = false;
    left.forEach((s, i) => {
      const d0 = s.closed ? nearestOnLoop(s.pts, at) : dist(at, s.pts[0]);
      const d1 = s.closed ? Infinity : dist(at, s.pts[s.pts.length - 1]);
      if (Math.min(d0, d1) < bd) { bd = Math.min(d0, d1); bi = i; flip = d1 < d0; }
    });
    const s = left.splice(bi, 1)[0];
    let path = s.closed ? startNear(s.pts, at) : flip ? [...s.pts].reverse() : s.pts;
    if (s.closed) path = [...path, path[0]];
    if (first) approach(out, path[0], p.top, ctx);
    else {
      out.push({ kind: 'rapid', z: hop });
      out.push({ kind: 'rapid', x: path[0].x, y: path[0].y });
      out.push({ kind: 'rapid', z: Math.min(hop, ctx.z(p.top) + ctx.clear) });
    }
    first = false;
    for (const d of passes) {
      pushFeed(out, path[0], ctx.z(d), 'plunge');
      for (let i = 1; i < path.length; i++) pushFeed(out, path[i], ctx.z(d));
      // open strokes come back the other way; loops go round again from the same point
      if (!s.closed) path = [...path].reverse();
    }
    // the tool is now at path[0]: a loop's start, or the far end of an open stroke (reversed)
    at = path[0];
  }
  retract(out, ctx);
  return { moves: out, warnings };
}

function nearestOnLoop(pts: Pt[], p: Pt): number {
  let bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    bd = Math.min(bd, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return bd;
}

/**
 * Width of the groove a tool cuts at a depth: V-bit its tip flat + 2·d·tan(θ/2) (its `diameter` is
 * the tip), ball the chord, flat its diameter.
 */
export function grooveWidth(cutter: { type: string; diameter: number; angle?: number }, depth: number): number {
  const r = cutter.diameter / 2;
  if (cutter.type === 'vbit') return cutter.diameter + 2 * depth * Math.tan((((cutter.angle ?? 90) / 2) * Math.PI) / 180);
  if (cutter.type === 'ball' || cutter.type === 'taperedBall') return depth >= r ? cutter.diameter : 2 * Math.sqrt(r * r - (r - depth) ** 2);
  return cutter.diameter;
}
