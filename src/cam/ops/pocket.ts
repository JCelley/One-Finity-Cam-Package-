import { dist, type Pt } from '../../cad/geom';
import { offsetShapes } from '../../cad/ops';
import type { Entity } from '../../cad/doc';
import type { Move } from '../toolpath';
import { approach, contoursOf, fmtMm, crossesLoops, dedupe, inRegion, levels, LoopWalker, pushFeed, rampOnSegment, retract, startNear, walkLoop, type Ctx } from './contour';
import type { OpResult } from './profile';

export interface PocketParams {
  depth: number;
  top: number;
  stepdown: number;
  /** distance between passes as a fraction of the tool Ø (0.4 = 40 %) */
  stepover: number;
  strategy: 'offset' | 'raster';
  /** raster line direction in degrees (0 = along X) */
  angle: number;
  climb: boolean;
  /** material left on walls and floor for a finishing pass (mm) */
  allowance: number;
  ramp: number;
}

export const POCKET_DEFAULTS: PocketParams = { depth: 3, top: 0, stepdown: 2, stepover: 0.4, strategy: 'offset', angle: 0, climb: true, allowance: 0, ramp: 5 };

/**
 * Clears the area inside the chosen closed outlines (nested outlines are islands, even-odd).
 * The tool centre stays inside the outline offset by its radius plus the allowance.
 * Offset: rings from the middle outwards, the last ring being the finished wall.
 * Raster: zig-zag lines, then one ring round the wall.
 * Moves between cuts stay down when the way is inside the pocket and short; otherwise the tool
 * lifts just above the pass before (inside the pocket) or to the safe height.
 */
export function pocketOp(items: Entity[], toolDia: number, p: PocketParams, ctx: Ctx): OpResult {
  const warnings: string[] = [];
  const out: Move[] = [];
  const r = toolDia / 2;
  const closed = contoursOf(items, ctx.tol).filter((c) => c.closed);
  if (closed.length < contoursOf(items, ctx.tol).length) warnings.push('Open lines were left out: a pocket needs closed outlines');
  if (!closed.length) return { moves: [], warnings: [...warnings, 'Nothing to pocket: pick closed outlines'] };
  const passes = levels(p.top, p.depth - p.allowance, p.stepdown);
  if (!passes.length) return { moves: [], warnings: ['Depth must be below the start depth'] };
  const step = Math.max(0.05, Math.min(0.95, p.stepover)) * toolDia;
  const region = closed.map((c) => ({ kind: 'poly' as const, pts: c.pts, closed: true }));
  const toLoops = (shapes: ReturnType<typeof offsetShapes>) => shapes.map((s) => (s.kind === 'poly' ? dedupe(s.pts, true) : [])).filter((l) => l.length >= 3);
  const wall = toLoops(offsetShapes(region, -(r + p.allowance), ctx.tol));
  if (!wall.length) return { moves: [], warnings: [...warnings, `The tool (Ø${(ctx.fmt ?? fmtMm)(toolDia)}) is too big for this pocket`] };
  const tanA = p.ramp > 0 ? Math.tan((Math.min(45, p.ramp) * Math.PI) / 180) : 0;

  // the cuts for one pass, as point lists (closed rings or open lines), in cutting order
  const cuts: { pts: Pt[]; closed: boolean }[] = [];
  if (p.strategy === 'offset') {
    const rings: Pt[][][] = [wall];
    for (let k = 1; k < 10000; k++) {
      const next = toLoops(offsetShapes(wall.map((l) => ({ kind: 'poly' as const, pts: l, closed: true })), -step * k, ctx.tol));
      if (!next.length) break;
      rings.push(next);
    }
    // innermost first; Clipper gives outer loops CCW and holes CW, which is climb for a pocket
    for (const ring of rings.reverse()) for (const l of ring) cuts.push({ pts: p.climb ? l : [...l].reverse(), closed: true });
  } else {
    for (const seg of rasterLines(wall, step, (p.angle * Math.PI) / 180)) cuts.push({ pts: seg, closed: false });
    for (const l of wall) cuts.push({ pts: p.climb ? l : [...l].reverse(), closed: true });
  }

  let dPrev = p.top;
  for (const d of passes) {
    let here: Pt | null = null;
    for (let i = 0; i < cuts.length; i++) {
      const c = cuts[i];
      // rings start where the tool already is (rotating a loop keeps its direction)
      const pts: Pt[] = c.closed && here ? startNear(c.pts, here) : c.pts;
      const start = pts[0];
      if (!here) {
        // first cut of the pass: come down from the pass above, ramping if there is room
        approach(out, start, dPrev, ctx);
        if (c.closed && tanA > 0 && new LoopWalker(pts).P >= 2 * toolDia) {
          const w = new LoopWalker(pts);
          const reach = (d - dPrev) / tanA;
          walkLoop(w, 0, reach + w.P, (s) => Math.min(d, dPrev + s * tanA), [], ctx, out);
        } else {
          if (!c.closed) rampOnSegment(out, pts[0], pts[1], dPrev, d, tanA, ctx, toolDia);
          else pushFeed(out, start, ctx.z(d), 'plunge');
          cutAlong(pts, c.closed, d, ctx, out);
        }
      } else {
        link(here, start, d, dPrev, step, wall, ctx, out);
        cutAlong(pts, c.closed, d, ctx, out);
      }
      // where the tool really is now (after a ramp-in it ends partway round the ring)
      here = lastXY(out) ?? pts[pts.length - 1];
    }
    dPrev = d;
  }
  retract(out, ctx);
  if (p.allowance > 0) warnings.push(`Leaves ${(ctx.fmt ?? fmtMm)(p.allowance)} on the walls and floor for a finishing pass`);
  return { moves: out, warnings };
}

function lastXY(out: Move[]): Pt | null {
  let x: number | undefined, y: number | undefined;
  for (let i = out.length - 1; i >= 0 && (x === undefined || y === undefined); i--) {
    const m = out[i];
    if (m.kind === 'dwell' || m.kind === 'comment') continue;
    if (x === undefined && m.x !== undefined) x = m.x;
    if (y === undefined && m.y !== undefined) y = m.y;
  }
  return x === undefined || y === undefined ? null : { x, y };
}

function cutAlong(pts: Pt[], closed: boolean, d: number, ctx: Ctx, out: Move[]) {
  for (let i = 1; i < pts.length; i++) pushFeed(out, pts[i], ctx.z(d));
  if (closed) pushFeed(out, pts[0], ctx.z(d));
}

/** gets from a to b at depth d: stays down, hops just above the pass before, or goes up to safe Z */
function link(a: Pt, b: Pt, d: number, dPrev: number, step: number, wall: Pt[][], ctx: Ctx, out: Move[]) {
  if (dist(a, b) < 1e-6) return;
  const inside = !crossesLoops(a, b, wall) && inRegion({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, wall);
  if (inside && dist(a, b) <= 1.5 * step + 1e-6) {
    pushFeed(out, b, ctx.z(d));
    return;
  }
  if (inside) {
    // everything inside the wall loops was cut down to dPrev on the pass before
    const hz = Math.min(ctx.safeZ, ctx.z(dPrev) + ctx.clear);
    out.push({ kind: 'rapid', z: hz }, { kind: 'rapid', x: b.x, y: b.y });
  } else {
    out.push({ kind: 'rapid', z: ctx.safeZ }, { kind: 'rapid', x: b.x, y: b.y }, { kind: 'rapid', z: Math.min(ctx.safeZ, ctx.z(dPrev) + ctx.clear) });
  }
  pushFeed(out, b, ctx.z(d), 'plunge');
}

/**
 * Zig-zag lines across the region (even-odd loops) at spacing `step`, at angle `ang`: each scan
 * line is split where it crosses the loops; consecutive rows alternate direction.
 */
export function rasterLines(loops: Pt[][], step: number, ang: number): Pt[][] {
  const cs = Math.cos(-ang), sn = Math.sin(-ang);
  const rot = (p: Pt, c: number, s: number): Pt => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c });
  const L = loops.map((l) => l.map((p) => rot(p, cs, sn)));
  let y0 = Infinity, y1 = -Infinity;
  for (const l of L) for (const p of l) {
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  const span = y1 - y0;
  const n = Math.max(1, Math.ceil(span / step - 1e-9));
  const rows: Pt[][][] = [];
  for (let k = 0; k <= n; k++) {
    // keep the first and last lines a hair inside so they meet the region
    const y = y0 + Math.min(span - 1e-4, Math.max(1e-4, (span * k) / n));
    const xs: number[] = [];
    for (const l of L)
      for (let i = 0; i < l.length; i++) {
        const a = l[i], b = l[(i + 1) % l.length];
        if (a.y <= y !== b.y <= y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    xs.sort((a, b) => a - b);
    const segs: Pt[][] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-6) segs.push([{ x: xs[i], y }, { x: xs[i + 1], y }]);
    if (k % 2 === 1) {
      segs.reverse();
      for (const s of segs) s.reverse();
    }
    rows.push(segs);
  }
  const back = (p: Pt) => rot(p, Math.cos(ang), Math.sin(ang));
  return rows.flat().map((s) => s.map(back));
}
