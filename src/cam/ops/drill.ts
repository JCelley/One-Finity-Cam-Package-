import { dist, type Pt } from '../../cad/geom';
import type { Entity } from '../../cad/doc';
import type { Move } from '../toolpath';
import { fmtMm, type Ctx } from './contour';
import type { OpResult } from './profile';

export interface DrillParams {
  depth: number;
  top: number;
  /** peck depth (mm); 0 = straight down in one go */
  peck: number;
  /** seconds to wait at the bottom of each hole */
  dwell: number;
}

export const DRILL_DEFAULTS: DrillParams = { depth: 6, top: 0, peck: 3, dwell: 0 };

/**
 * Drills at the centre of each chosen circle, nearest hole next. Written as plain G0/G1 moves
 * (no canned cycles), so it runs the same on any controller: feed down a peck, rapid out to clear
 * the chips, rapid back to just above the last depth, repeat.
 */
export function drillOp(items: Entity[], toolDia: number, p: DrillParams, ctx: Ctx): OpResult {
  const warnings: string[] = [];
  const holes: { c: Pt; dia: number }[] = [];
  for (const e of items) if (e.kind === 'circle') holes.push({ c: e.c, dia: 2 * e.r });
  if (holes.length < items.filter((e) => e.kind !== 'dim').length) warnings.push('Only circles are drilled (at their centres); other items were left out');
  if (!holes.length) return { moves: [], warnings: [...warnings, 'Nothing to drill: pick circles'] };
  const off = holes.filter((h) => Math.abs(h.dia - toolDia) > 0.1);
  if (off.length) warnings.push(`${off.length} hole${off.length === 1 ? ' is' : 's are'} not the tool's size (Ø${(ctx.fmt ?? fmtMm)(toolDia)}); drilled at the centre anyway`);
  if (!(p.depth > p.top)) return { moves: [], warnings: ['Depth must be below the start depth'] };

  // nearest-neighbour order from the work origin
  const left = [...holes];
  const order: Pt[] = [];
  let at: Pt = { x: 0, y: 0 };
  while (left.length) {
    let bi = 0;
    left.forEach((h, i) => {
      if (dist(h.c, at) < dist(left[bi].c, at)) bi = i;
    });
    at = left.splice(bi, 1)[0].c;
    order.push(at);
  }

  const out: Move[] = [];
  const zClear = Math.min(ctx.safeZ, ctx.z(p.top) + ctx.clear);
  for (const c of order) {
    out.push({ kind: 'rapid', z: ctx.safeZ }, { kind: 'rapid', x: c.x, y: c.y }, { kind: 'rapid', z: zClear });
    let d = p.top;
    const peck = p.peck > 0 ? p.peck : p.depth - p.top;
    while (d < p.depth - 1e-9) {
      if (d > p.top) out.push({ kind: 'rapid', z: Math.min(zClear, ctx.z(d) + 0.5) });
      d = Math.min(p.depth, d + peck);
      out.push({ kind: 'feed', z: ctx.z(d), rate: 'plunge' });
      if (d < p.depth - 1e-9) out.push({ kind: 'rapid', z: zClear });
    }
    if (p.dwell > 0) out.push({ kind: 'dwell', seconds: p.dwell });
    out.push({ kind: 'rapid', z: zClear });
  }
  out.push({ kind: 'rapid', z: ctx.safeZ });
  return { moves: out, warnings };
}
