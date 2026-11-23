import { signedArea, type Pt } from '../../cad/geom';
import { offsetShapes } from '../../cad/ops';
import type { Entity } from '../../cad/doc';
import type { Move } from '../toolpath';
import { approach, contoursOf, fmtMm, dedupe, levels, LoopWalker, orient, pushFeed, retract, startOnLongestEdge, walkLoop, type Ctx } from './contour';

export interface ProfileParams {
  side: 'outside' | 'inside' | 'on';
  /** final depth below the stock top (mm) */
  depth: number;
  /** depth the cut starts from (mm below the stock top), normally 0 */
  top: number;
  stepdown: number;
  /** climb: the cutter's edge meets the material moving the same way as the feed (clean finish) */
  climb: boolean;
  /** material left on the wall for a later pass (mm) */
  allowance: number;
  /** ramp angle in degrees down into each pass (0 = straight plunge) */
  ramp: number;
  /** holding tabs on closed outlines, cut on the passes below `depth − height` */
  tabs: { count: number; width: number; height: number };
}

export const PROFILE_DEFAULTS: ProfileParams = {
  side: 'outside',
  depth: 6,
  top: 0,
  stepdown: 3,
  climb: true,
  allowance: 0,
  ramp: 5,
  tabs: { count: 0, width: 8, height: 3 },
};

export interface OpResult {
  moves: Move[];
  warnings: string[];
}

/**
 * Profile cut along each contour. Closed outlines are offset by the tool radius (plus allowance)
 * to the outside or inside, then cut pass by pass: each pass ramps down along the loop from the
 * pass above and goes once round at depth (one extra stretch to clean up the ramp). Open lines are
 * cut on the line, back and forth pass by pass. Tabs leave the tool at tab height over evenly
 * spaced stretches of each closed loop.
 */
export function profileOp(items: Entity[], toolDia: number, p: ProfileParams, ctx: Ctx): OpResult {
  const warnings: string[] = [];
  const out: Move[] = [];
  const r = toolDia / 2;
  const passes = levels(p.top, p.depth, p.stepdown);
  if (!passes.length) return { moves: [], warnings: ['Depth must be below the start depth'] };
  const tanA = p.ramp > 0 ? Math.tan((Math.min(45, p.ramp) * Math.PI) / 180) : 0;
  const tabTop = p.depth - p.tabs.height;

  let n = 0;
  for (const c of contoursOf(items, ctx.tol)) {
    if (!c.closed) {
      if (p.side !== 'on') warnings.push('An open line was cut on the line (inside/outside needs a closed outline)');
      openCut(c.pts, passes, p.top, ctx, out);
      n++;
      continue;
    }
    // tool-centre loops for this outline
    let loops: Pt[][] = [c.pts];
    const off = p.side === 'on' ? 0 : (p.side === 'outside' ? 1 : -1) * (r + p.allowance);
    if (Math.abs(off) > 1e-9) {
      const shapes = offsetShapes([{ kind: 'poly', pts: c.pts, closed: true }], off, ctx.tol);
      loops = shapes.map((s) => (s.kind === 'poly' ? dedupe(s.pts, true) : [])).filter((l) => l.length >= 3);
      if (!loops.length) {
        warnings.push(`The tool (Ø${(ctx.fmt ?? fmtMm)(toolDia)}) is too big to fit inside an outline; it was skipped`);
        continue;
      }
    }
    for (let loop of loops) {
      // climb milling with a clockwise spindle: clockwise round the outside of material, CCW inside it
      const outerOfMaterial = p.side === 'inside' ? false : true;
      const holeLoop = signedArea(loop) < 0; // inner loops of an outward offset (rare)
      const cw = (outerOfMaterial !== holeLoop) === p.climb;
      loop = startOnLongestEdge(orient(loop, !cw));
      const w = new LoopWalker(loop);
      const tabs = tabIntervals(w.P, p.tabs.count, p.tabs.width + toolDia);
      if (p.tabs.count > 0 && !tabs.length) warnings.push('A loop is too short for its tabs; it was cut without them');
      const inTab = (s: number) => {
        const u = ((s % w.P) + w.P) % w.P;
        return tabs.some(([a, b]) => u > a && u < b);
      };
      const breaks = (s0: number, s1: number) => {
        const out: number[] = [];
        for (let lap = Math.floor(s0 / w.P); lap * w.P < s1; lap++) for (const [a, b] of tabs) out.push(lap * w.P + a, lap * w.P + b);
        return out;
      };
      approach(out, loop[0], p.top, ctx);
      let s = 0, dPrev = p.top;
      for (const d of passes) {
        const reach = tanA > 0 ? (d - dPrev) / tanA : 0;
        const s0 = s;
        if (tanA <= 0) pushFeed(out, w.at(s0), ctx.z(tabs.length && d > tabTop && inTab(s0) ? tabTop : d), 'plunge');
        const dAt = (q: number) => {
          let v = tanA > 0 ? Math.min(d, dPrev + (q - s0) * tanA) : d;
          if (tabs.length && v > tabTop && inTab(q)) v = tabTop;
          return v;
        };
        // ramp (if any) plus one full lap at depth
        const s1 = s0 + reach + w.P;
        walkLoop(w, s0, s1, dAt, breaks(s0, s1), ctx, out);
        s = s1;
        dPrev = d;
      }
      retract(out, ctx);
      n++;
    }
  }
  if (!n) warnings.push('Nothing to cut: pick lines or outlines in the drawing');
  return { moves: out, warnings };
}

/** cuts an open polyline on the line, pass by pass, alternating direction */
function openCut(pts: Pt[], passes: number[], top: number, ctx: Ctx, out: Move[]) {
  let path = pts;
  approach(out, path[0], top, ctx);
  for (const d of passes) {
    pushFeed(out, path[0], ctx.z(d), 'plunge');
    for (let i = 1; i < path.length; i++) pushFeed(out, path[i], ctx.z(d));
    path = [...path].reverse();
  }
  retract(out, ctx);
}

/** `count` tab stretches of length `len`, evenly spaced round a loop of length P; none if they don't fit */
export function tabIntervals(P: number, count: number, len: number): [number, number][] {
  if (count <= 0 || count * len * 2 > P) return [];
  return Array.from({ length: count }, (_, k) => {
    const c = (P * (k + 0.5)) / count;
    return [c - len / 2, c + len / 2] as [number, number];
  });
}
