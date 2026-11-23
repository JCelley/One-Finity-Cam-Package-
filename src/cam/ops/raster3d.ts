import { simulateCut, type Cutter } from '../../core/cutter';
import { detailPaths, detailRegion, floorSkip, toolRadiusAt, finishingRuns, roughingPaths, roughRest, topSkip, type Path, type PathSet } from '../../core/heightfieldCam';
import { modelGrid, placeModel, type Model3D, type ModelGrid } from '../model3d';
import type { Move } from '../toolpath';
import { fmtMm, type Ctx } from './contour';

export interface Raster3dParams {
  /** id of the model in the job */
  model: string;
  /** rest: a smaller tool, only where the finishing tools before it on this model could not reach */
  pass: 'rough' | 'finish' | 'rest';
  /** roughing: deepest cut per level (mm) */
  stepdown: number;
  /** distance between raster lines (mm) */
  stepover: number;
  /** roughing: material left on the surface for the finishing pass (mm) */
  allowance: number;
  /** finishing / rest: lines along X, along Y, or both */
  dir: 'x' | 'y' | 'xy';
  /** ramp angle into each cut (degrees, 0 = plunge) */
  ramp: number;
}

export const RASTER3D_DEFAULTS: Raster3dParams = { model: '', pass: 'rough', stepdown: 3, stepover: 2.5, allowance: 0.5, dir: 'x', ramp: 3 };

/** the roughing that comes before a finishing pass on the same model (lets it skip done floor) */
export interface RoughBefore {
  tool: Cutter;
  allowance: number;
  stepover: number;
}

/** grid points above which a job is refused: about 4 million (a 500 × 500 mm area at 0.25 mm) */
export const MAX_GRID = 4_000_000;

// the last few grids: building one is the slow part, and settings other than the placement don't change it
const cache = new Map<string, ModelGrid>();
function gridOf(m: Model3D): ModelGrid {
  const { id, name: _name, tris, ...place } = m;
  // the triangles are identified by their length and a sample (hashing megabytes each time would cost more)
  const key = `${id}|${tris.length}|${tris.slice(0, 64)}|${tris.slice(-64)}|${JSON.stringify(place)}`;
  let g = cache.get(key);
  if (!g) {
    g = modelGrid(m, placeModel(m));
    cache.set(key, g);
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
  }
  return g;
}

export interface Raster3dResult {
  moves: Move[];
  warnings: string[];
  /** deepest the tool goes below the stock top (mm) */
  depth: number;
  /** depth of the model's bottom below the stock top (mm) */
  bottom: number;
}

/** footprint (with margin) of a model in grid points, to check before building it */
export function gridPoints(m: Model3D): number {
  const p = placeModel(m);
  const res = Math.min(5, Math.max(0.05, m.res));
  return (Math.round((p.x1 - p.x0 + 2 * m.margin) / res) + 1) * (Math.round((p.y1 - p.y0 + 2 * m.margin) / res) + 1);
}

/**
 * 3D raster machining of a placed model. Roughing: Z levels from the stock top down, lines along
 * X, `allowance` left on the surface (a flat end mill cuts the model's bottom to depth). Finishing:
 * the tool rides on the surface along X / Y / both; with roughing before it, it skips floor that
 * is already done and hops just over the material between runs. Rest: lines only where the tools
 * of the finishing (and rest) passes before it (`finished`) leave material this smaller tool can
 * take off, grown by its width so it gets into each corner from all sides.
 */
export function raster3dOp(model: Model3D, tool: Cutter, p: Raster3dParams, ctx: Ctx, rough?: RoughBefore, finished: Cutter[] = []): Raster3dResult {
  const warnings: string[] = [];
  if (gridPoints(model) > MAX_GRID) return { moves: [], warnings: [`The model's area is too big for a ${model.res} mm resolution: make the resolution coarser`], depth: 0, bottom: 0 };
  const mg = gridOf(model);
  const { g, stockTop } = mg;
  const step = Math.max(0.02, p.stepover);
  let ps: PathSet;
  if (p.pass === 'rest') {
    if (!finished.length) return { moves: [], warnings: ['Rest machining goes after a 3D finish on the same model: add one above it'], depth: 0, bottom: stockTop };
    // the surface the earlier tools leave: each takes the material down to its own reach
    let left: Float32Array | null = null;
    for (const t of finished) {
      const c = simulateCut(g, t).cut;
      if (!left) left = c;
      else for (let k = 0; k < c.length; k++) left[k] = Math.min(left[k], c[k]);
    }
    const finishCut = left!;
    const first = detailRegion(g, tool, finishCut);
    if (first.area <= 0) return { moves: [], warnings: ['Nothing left for this tool: the finishing before it already reaches everywhere this tool can'], depth: 0, bottom: stockTop };
    let most = 0;
    for (let k = 0; k < first.cut.length; k++) if (first.region[k]) most = Math.max(most, finishCut[k] - first.cut[k]);
    // in levels no deeper than the stepdown below what the earlier tools left: level k cuts the
    // surface max(design, left − k·stepdown), and only where the level above left material
    const sd = p.stepdown > 0 ? Math.max(0.05, p.stepdown) : Infinity;
    const levels = Number.isFinite(sd) ? Math.max(1, Math.ceil(most / sd - 1e-6)) : 1;
    ps = { paths: [], entry: [], link: [] };
    let prev = finishCut;
    for (let lv = 1; lv <= levels; lv++) {
      const zk = lv === levels ? g.z : g.z.map((v, k) => Math.max(v, finishCut[k] - lv * sd));
      const gk = { ...g, z: zk };
      const { region, area } = lv === 1 && levels === 1 ? first : detailRegion(gk, tool, prev);
      if (area > 0) {
        // only the last level is the finished surface: the ones above it clear at a roughing stepover
        // (40% of the tool's width a stepdown up from its tip)
        const so = lv === levels ? step : Math.max(step, 0.8 * toolRadiusAt(tool, sd));
        const lp = detailPaths(gk, { tool, stepover: so, dir: p.dir, finishCut: prev, region });
        // the first run of a level starts from the safe height
        if (lp.link?.length) lp.link[0] = NaN;
        ps.paths.push(...lp.paths);
        ps.entry.push(...lp.entry);
        ps.link!.push(...lp.link!);
      }
      prev = lv === levels ? first.cut : simulateCut(gk, tool).cut;
    }
    if (!Number.isFinite(sd) && most > tool.diameter + 1e-6)
      warnings.push(`It takes up to ${(ctx.fmt ?? fmtMm)(most)} in one pass in the deepest corners, more than the tool's diameter: set a stepdown`);
  } else if (p.pass === 'rough') {
    ps = roughingPaths(g, { tool, stepdown: Math.max(0.05, p.stepdown), stepover: step, allowance: Math.max(0, p.allowance), stockTop });
  } else {
    const skip = new Uint8Array(g.nx * g.ny);
    const top = topSkip(g, tool, stockTop);
    if (top) for (let k = 0; k < skip.length; k++) skip[k] |= top[k];
    let rest: Float32Array;
    const reach = tool.diameter / 2;
    if (rough) {
      const fl = floorSkip(g, rough.tool, tool, rough.stepover);
      if (fl) for (let k = 0; k < skip.length; k++) skip[k] |= fl[k];
      rest = roughRest(g, rough.tool, rough.allowance, rough.stepover, reach);
      for (let k = 0; k < rest.length; k++) rest[k] = Math.min(rest[k], stockTop);
    } else rest = new Float32Array(g.nx * g.ny).fill(stockTop);
    ps = finishingRuns(g, { tool, stepover: step, dir: p.dir, skip, rest, stockTop });
  }
  if (!ps.paths.length) warnings.push('Nothing to cut: the model is entirely above the stock top or below this pass');
  const moves = pathSetToMoves(ps, mg, tool, p.ramp, ctx);
  let lowest = Infinity;
  for (const path of ps.paths) for (let i = 2; i < path.length; i += 3) lowest = Math.min(lowest, path[i]);
  return { moves, warnings, depth: Number.isFinite(lowest) ? stockTop - lowest : 0, bottom: stockTop };
}

/**
 * Heightfield paths (part coordinates, z above the model's bottom) → moves in work coordinates.
 * Each path starts either with a short hop just over the material (when the path set says the box
 * between is clear at that height) or from the safe height, rapid down to just above the material
 * and a ramp back and forth along the start of the path (a plunge when it is too short or steep).
 */
export function pathSetToMoves(ps: PathSet, mg: ModelGrid, tool: Cutter, rampDeg: number, ctx: Ctx): Move[] {
  const out: Move[] = [];
  const off = ctx.z(mg.stockTop); // work Z of the model's bottom
  const safe = ctx.safeZ - off;
  const clear = ctx.clear;
  let cur = { x: NaN, y: NaN, z: safe };
  const W = (x: number, y: number, z: number) => ({ x: x + mg.ox, y: y + mg.oy, z: z + off });
  const rapid = (x: number, y: number, z: number) => {
    if (x === cur.x && y === cur.y && Math.abs(z - cur.z) < 1e-9) return;
    out.push({ kind: 'rapid', ...W(x, y, z) });
    cur = { x, y, z };
  };
  const feed = (x: number, y: number, z: number, rate: 'cut' | 'plunge') => {
    if (Math.hypot(x - cur.x, y - cur.y, z - cur.z) < 1e-6) return;
    out.push({ kind: 'feed', ...W(x, y, z), rate });
    cur = { x, y, z };
  };
  const tanA = Math.tan((Math.min(45, Math.max(0, rampDeg)) * Math.PI) / 180);

  const enter = (p: Path, zr: number) => {
    const z0 = p[2], drop = zr - z0;
    if (drop <= 1e-6) return;
    const maxLen = Math.min(20, Math.max(3, 3 * tool.diameter));
    const pts: number[][] = [[p[0], p[1], p[2], 0]];
    for (let i = 3; i < p.length && pts[pts.length - 1][3] < maxLen; i += 3) {
      const q = pts[pts.length - 1];
      const d = Math.hypot(p[i] - q[0], p[i + 1] - q[1]);
      if (d < 1e-9) continue;
      if (q[3] + d <= maxLen) pts.push([p[i], p[i + 1], p[i + 2], q[3] + d]);
      else {
        const w = (maxLen - q[3]) / d;
        pts.push([q[0] + (p[i] - q[0]) * w, q[1] + (p[i + 1] - q[1]) * w, q[2] + (p[i + 2] - q[2]) * w, maxLen]);
      }
    }
    const R = pts[pts.length - 1][3];
    const pairs = tanA > 0 && R >= 1 ? Math.ceil(drop / (2 * R * tanA) - 1e-9) : Infinity;
    if (drop <= clear + 1e-6 || pairs > 40) {
      feed(p[0], p[1], z0, 'plunge');
      return;
    }
    // back and forth along the start of the path, going down evenly, never below the path itself
    const slope = drop / (2 * pairs * R);
    let travelled = 0, sPrev = 0;
    for (let q = 0; q < pairs; q++)
      for (const leg of [pts.slice(1), pts.slice(0, -1).reverse()])
        for (const pt of leg) {
          travelled += Math.abs(pt[3] - sPrev);
          sPrev = pt[3];
          feed(pt[0], pt[1], Math.max(pt[2], zr - slope * travelled), 'cut');
        }
    feed(p[0], p[1], z0, 'cut');
  };

  ps.paths.forEach((p, pi) => {
    if (p.length < 3) return;
    const entry = ps.entry[pi] ?? mg.stockTop;
    const link = pi > 0 ? (ps.link?.[pi] ?? NaN) : NaN;
    if (link < safe && Number.isFinite(cur.x)) {
      // a short hop just over the material instead of going up to the safe height
      const h = Math.max(cur.z, link);
      rapid(cur.x, cur.y, h);
      rapid(p[0], p[1], h);
      rapid(p[0], p[1], Math.min(h, Math.max(p[2], entry + 0.05)));
      feed(p[0], p[1], p[2], 'plunge');
    } else {
      if (Number.isFinite(cur.x)) rapid(cur.x, cur.y, safe);
      else out.push({ kind: 'rapid', z: ctx.safeZ });
      rapid(p[0], p[1], safe);
      const zr = Math.min(safe, Math.max(p[2], entry + clear));
      rapid(p[0], p[1], zr);
      enter(p, zr);
    }
    for (let i = 3; i < p.length; i += 3) {
      // a move that goes down steeply is a plunge
      const dz = cur.z - p[i + 2], dxy = Math.hypot(p[i] - cur.x, p[i + 1] - cur.y);
      feed(p[i], p[i + 1], p[i + 2], dz > 0.5 && dz > 2 * dxy ? 'plunge' : 'cut');
    }
  });
  if (out.length) out.push({ kind: 'rapid', z: ctx.safeZ });
  return out;
}
