import type { Entity } from '../../cad/doc';
import type { Pt } from '../../cad/geom';
import { regionLoops } from '../../cad/ops';
import type { Move } from '../toolpath';
import { contoursOf, fmtMm, type Ctx } from './contour';
import { vcarveRegion, type VcarveTool } from './vcarve';

export interface VcarveParams {
  /** deepest the V-bit goes; wider areas are left flat at this depth */
  maxDepth: number;
  stepdown: number;
  /** end mill that clears flat areas first (tool number, 0 = none) */
  clearTool: number;
  /** clearing stepover, fraction of that tool's Ø */
  clearStepover: number;
}

export const VCARVE_DEFAULTS: VcarveParams = { maxDepth: 6, stepdown: 0, clearTool: 0, clearStepover: 0.4 };

/**
 * Inlay: the pocket is V-carved into the base board; the plug is the same shape mirrored, carved
 * around (outside) on a second board with its walls starting `pocketDepth − gap` down, so it fits
 * the pocket's V walls exactly and stops `gap` short of the pocket floor for glue. The plug stands
 * `proud` above the base board after gluing; plane or sand it flush.
 */
export interface InlayParams {
  side: 'pocket' | 'plug';
  pocketDepth: number;
  gap: number;
  proud: number;
  /** waste border cleared around the plug */
  margin: number;
  stepdown: number;
  clearTool: number;
  clearStepover: number;
}

export const INLAY_DEFAULTS: InlayParams = { side: 'pocket', pocketDepth: 5, gap: 1, proud: 2, margin: 6, stepdown: 0, clearTool: 0, clearStepover: 0.4 };

export interface CarveResult {
  moves: Move[];
  warnings: string[];
  /** areas to clear flat, with the depth */
  flat: Pt[][];
  flatDepth: number;
}

export const vbitOf = (angleDeg: number, tipDia: number): VcarveTool => ({ half: ((angleDeg / 2) * Math.PI) / 180, tipR: Math.max(0, tipDia / 2) });

function outlines(items: Entity[], ctx: Ctx, warnings: string[]): Pt[][] {
  const cs = contoursOf(items, ctx.tol);
  const closed = cs.filter((c) => c.closed).map((c) => c.pts);
  if (closed.length < cs.length) warnings.push('Open lines were left out: V-carving needs closed outlines');
  return closed;
}

/** V-carves inside the chosen closed outlines (nested outlines are holes) */
export function vcarveOp(items: Entity[], bit: VcarveTool, p: VcarveParams, ctx: Ctx): CarveResult {
  const warnings: string[] = [];
  const shapes = outlines(items, ctx, warnings);
  if (!shapes.length) return { moves: [], warnings: [...warnings, 'Nothing to carve: pick closed outlines'], flat: [], flatDepth: 0 };
  const loops = regionLoops(shapes.map((pts) => ({ kind: 'poly', pts, closed: true })), ctx.tol);
  const r = vcarveRegion(loops, bit, { maxDepth: p.maxDepth, startDepth: 0, stepdown: p.stepdown, spacing: 0.2 }, ctx);
  return finish(r, p.maxDepth, p.clearTool, warnings, ctx);
}

/** one half of an inlay: the pocket (as vcarveOp) or the mirrored plug */
export function inlayOp(items: Entity[], bit: VcarveTool, p: InlayParams, ctx: Ctx): CarveResult {
  const warnings: string[] = [];
  let shapes = outlines(items, ctx, warnings);
  if (!shapes.length) return { moves: [], warnings: [...warnings, 'Nothing to inlay: pick closed outlines'], flat: [], flatDepth: 0 };
  if (p.gap >= p.pocketDepth) return { moves: [], warnings: ['The glue gap must be less than the pocket depth'], flat: [], flatDepth: 0 };
  if (p.side === 'pocket') {
    const loops = regionLoops(shapes.map((pts) => ({ kind: 'poly', pts, closed: true })), ctx.tol);
    const r = vcarveRegion(loops, bit, { maxDepth: p.pocketDepth, startDepth: 0, stepdown: p.stepdown, spacing: 0.2 }, ctx);
    return finish(r, p.pocketDepth, p.clearTool, warnings, ctx);
  }
  // plug: mirror left–right about the shapes' middle, then carve the frame around them
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const s of shapes) for (const q of s) {
    x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x);
    y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
  }
  const mx = x0 + x1;
  shapes = shapes.map((s) => s.map((q) => ({ x: mx - q.x, y: q.y })).reverse());
  const m = Math.max(0, p.margin);
  const frame: Pt[] = [{ x: x0 - m, y: y0 - m }, { x: x1 + m, y: y0 - m }, { x: x1 + m, y: y1 + m }, { x: x0 - m, y: y1 + m }];
  const loops = regionLoops([frame, ...shapes].map((pts) => ({ kind: 'poly', pts, closed: true })), ctx.tol);
  const start = p.pocketDepth - p.gap;
  const depth = start + p.proud;
  const r = vcarveRegion(loops, bit, { maxDepth: depth, startDepth: start, stepdown: p.stepdown, spacing: 0.2 }, ctx);
  warnings.push(`Plug: cut on a separate board (mirrored). Its walls start ${(ctx.fmt ?? fmtMm)(start)} down; glue it in face down`);
  return finish(r, depth, p.clearTool, warnings, ctx);
}

function finish(r: ReturnType<typeof vcarveRegion>, flatDepth: number, clearTool: number, warnings: string[], ctx: Ctx): CarveResult {
  warnings.push(...r.warnings);
  if (r.flat.length && !clearTool) warnings.push(`Areas wider than the V-bit reaches at ${(ctx.fmt ?? fmtMm)(flatDepth)} are left uncut in the middle: choose a clearing tool`);
  return { moves: r.moves, warnings, flat: clearTool ? r.flat : [], flatDepth };
}
