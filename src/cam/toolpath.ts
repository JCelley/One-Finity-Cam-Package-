import type { Path } from '../core/heightfieldCam';

/**
 * Machine-agnostic toolpath: what every CAM operation produces and every post processor reads.
 * Coordinates are absolute, in mm, in the work coordinate system (X0 Y0 / Z0 as set on the
 * machine for this job). Arcs are in the XY plane; i, j = centre offset from the arc's start point.
 */
export type Move =
  | { kind: 'rapid'; x?: number; y?: number; z?: number }
  | { kind: 'feed'; x?: number; y?: number; z?: number; rate: 'cut' | 'plunge' }
  | { kind: 'arc'; cw: boolean; x: number; y: number; z?: number; i: number; j: number; rate: 'cut' | 'plunge' }
  | { kind: 'dwell'; seconds: number }
  | { kind: 'comment'; text: string };

/**
 * Converts heightfield polylines (z = height above the part bottom) to moves with Z0 at the stock
 * top: retract to the safe height, rapid across, rapid down to just above the material, plunge,
 * then feed along each path. Simple and safe; the heightfield writer in heightfieldCam.ts has the
 * smarter ramps and short hops and is used directly for the 3D raster operations.
 */
export function pathsToMoves(paths: Path[], stockTop: number, safeZ: number, clear = 1): Move[] {
  const out: Move[] = [];
  for (const p of paths) {
    if (p.length < 3) continue;
    out.push({ kind: 'rapid', z: safeZ });
    out.push({ kind: 'rapid', x: p[0], y: p[1] });
    out.push({ kind: 'rapid', z: Math.min(safeZ, clear) });
    out.push({ kind: 'feed', z: p[2] - stockTop, rate: 'plunge' });
    for (let i = 3; i < p.length; i += 3) out.push({ kind: 'feed', x: p[i], y: p[i + 1], z: p[i + 2] - stockTop, rate: 'cut' });
  }
  out.push({ kind: 'rapid', z: safeZ });
  return out;
}

/** XY(Z) bounding box of a move list, arcs included (by their extreme points) */
export function moveBounds(moves: Move[], start = { x: 0, y: 0, z: 0 }): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let c = { ...start };
  const add = (x: number, y: number, z: number) => {
    min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z);
  };
  for (const m of moves) {
    if (m.kind === 'dwell' || m.kind === 'comment') continue;
    const n = { x: m.x ?? c.x, y: m.y ?? c.y, z: m.z ?? c.z };
    add(n.x, n.y, n.z);
    if (m.kind === 'arc') {
      const cx = c.x + m.i, cy = c.y + m.j, r = Math.hypot(m.i, m.j);
      const a0 = Math.atan2(c.y - cy, c.x - cx), a1 = Math.atan2(n.y - cy, n.x - cx);
      // the arc's angular range, going the right way round (full circle when it ends where it started)
      let s = a0, e = a1;
      if (m.cw) [s, e] = [a1, a0];
      while (e <= s + 1e-12) e += 2 * Math.PI;
      for (let q = -4; q <= 8; q++) {
        const a = (q * Math.PI) / 2;
        if (a > s && a < e) add(cx + r * Math.cos(a), cy + r * Math.sin(a), n.z);
      }
    }
    c = n;
  }
  return { min, max };
}
