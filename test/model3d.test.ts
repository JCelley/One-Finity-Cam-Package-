import { describe, it, expect } from 'vitest';
import { parseStl, triBounds } from '../src/core/stlRead';
import { rasterizeTop } from '../src/core/rasterize';
import { decodeTris, encodeTris, MODEL_DEFAULTS, modelGrid, modelSize, placeModel, type Model3D } from '../src/cam/model3d';
import { raster3dOp, RASTER3D_DEFAULTS } from '../src/cam/ops/raster3d';
import type { Ctx } from '../src/cam/ops/contour';
import type { Move } from '../src/cam/toolpath';
import { buildJob, jobGcode } from '../src/cam/build';
import { emptyDoc } from '../src/cad/doc';
import { newJob } from '../src/io/formats';
import { DEFAULT_TOOLS } from '../src/cam/tools/library';

/** a square pyramid: base side s on z = 0, apex h above its centre, closed (base included) */
function pyramid(s: number, h: number): Float32Array {
  const c = [s / 2, s / 2, h];
  const b = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0]];
  const t: number[] = [];
  for (let i = 0; i < 4; i++) t.push(...b[i], ...b[(i + 1) % 4], ...c);
  t.push(...b[0], ...b[2], ...b[1], ...b[0], ...b[3], ...b[2]);
  return Float32Array.from(t);
}
/** height of that pyramid over (x, y) */
const pyrZ = (s: number, h: number, x: number, y: number) => Math.max(0, h * (1 - Math.max(Math.abs(x - s / 2), Math.abs(y - s / 2)) / (s / 2)));

function binaryStl(t: Float32Array, header = 'binary'): Uint8Array {
  const n = t.length / 9;
  const dv = new DataView(new ArrayBuffer(84 + 50 * n));
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, n, true);
  for (let k = 0; k < n; k++) for (let q = 0; q < 9; q++) dv.setFloat32(84 + 50 * k + 12 + 4 * q, t[k * 9 + q], true);
  return new Uint8Array(dv.buffer);
}
function asciiStl(t: Float32Array): Uint8Array {
  let s = 'solid test\n';
  for (let k = 0; k < t.length; k += 9) {
    s += ' facet normal 0 0 1\n  outer loop\n';
    for (let q = 0; q < 9; q += 3) s += `   vertex ${t[k + q]} ${t[k + q + 1]} ${t[k + q + 2]}\n`;
    s += '  endloop\n endfacet\n';
  }
  return new TextEncoder().encode(s + 'endsolid test\n');
}

const model = (tris: Float32Array, o: Partial<Model3D> = {}): Model3D => ({ id: 'm', name: 'pyramid', tris: encodeTris(tris), ...structuredClone(MODEL_DEFAULTS), ...o });
const ctx: Ctx = { z: (d) => -d, safeZ: 5, clear: 1, tol: 0.005 };

function trace(moves: Move[]) {
  const out: { x: number; y: number; z: number; kind: string }[] = [];
  let c = { x: 0, y: 0, z: 5 };
  for (const m of moves) {
    if (m.kind !== 'rapid' && m.kind !== 'feed') continue;
    c = { x: m.x ?? c.x, y: m.y ?? c.y, z: m.z ?? c.z };
    out.push({ ...c, kind: m.kind });
  }
  return out;
}

describe('STL files', () => {
  const t = pyramid(20, 5);
  it('reads binary and ASCII, also a binary whose header starts with "solid"', () => {
    expect(Array.from(parseStl(binaryStl(t)))).toEqual(Array.from(t));
    expect(Array.from(parseStl(binaryStl(t, 'solid exported by some CAD')))).toEqual(Array.from(t));
    expect(Array.from(parseStl(asciiStl(t)))).toEqual(Array.from(t));
    expect(() => parseStl(new TextEncoder().encode('hello'))).toThrow(/STL/);
  });

  it('triangles survive the trip through the job file (base64)', () => {
    expect(Array.from(decodeTris(encodeTris(t)))).toEqual(Array.from(t));
    expect(triBounds(t)).toEqual({ min: [0, 0, 0], max: [20, 20, 5] });
  });
});

describe('heightfield from a mesh', () => {
  it('keeps the top surface: a pyramid comes out as the pyramid', () => {
    const g = rasterizeTop(pyramid(20, 5), 0, 0, 20, 20, 0.5, 0);
    expect(g.nx).toBe(41);
    expect(g.zMax).toBeCloseTo(5, 5);
    for (const [i, j] of [[20, 20], [10, 10], [5, 30], [0, 0], [40, 17]]) expect(g.z[j * g.nx + i]).toBeCloseTo(pyrZ(20, 5, i * 0.5, j * 0.5), 4);
  });

  it('points no triangle covers get the model bottom', () => {
    const g = rasterizeTop(pyramid(20, 5), -5, -5, 30, 30, 1, 0);
    expect(g.z[0]).toBe(0);
    expect(g.z[15 * g.nx + 15]).toBeCloseTo(5, 4);
  });
});

describe('placing a model', () => {
  it('up axis, turn, scale, position: the footprint lands at `at`, the bottom at 0', () => {
    // a 20 × 20 pyramid 5 high, modelled Y-up: lying on its side in the file
    const yUp = pyramid(20, 5).map((v, i) => (i % 3 === 1 ? 0 : 0) + v); // copy
    for (let i = 0; i < yUp.length; i += 3) [yUp[i + 1], yUp[i + 2]] = [yUp[i + 2], -yUp[i + 1]];
    const p = placeModel(model(yUp, { up: '+y', scale: 2, at: { x: 10, y: 30 } }));
    expect([p.x0, p.y0, p.x1, p.y1, p.height].map((v) => +v.toFixed(5))).toEqual([10, 30, 50, 70, 10]);
    const tb = triBounds(p.tris);
    expect(tb.min[2]).toBeCloseTo(0, 6);
    // a quarter turn swaps the footprint's sides
    const long = Float32Array.from([0, 0, 0, 30, 0, 0, 0, 10, 2]);
    expect(modelSize(model(long))).toMatchObject({ x: 30, y: 10, z: 2 });
    const turned = modelSize(model(long, { turn: 90 }));
    expect(turned.x).toBeCloseTo(10, 5);
    expect(turned.y).toBeCloseTo(30, 5);
  });

  it('the grid covers the footprint plus the margin; its top sits `top` below the stock top', () => {
    const mg = modelGrid(model(pyramid(20, 5), { at: { x: 50, y: 40 }, margin: 5, top: 1, res: 0.5 }));
    expect([mg.ox, mg.oy, mg.g.widthMm, mg.g.heightMm, mg.stockTop]).toEqual([45, 35, 30, 30, 6]);
  });
});

describe('3D raster operation', () => {
  const m = model(pyramid(20, 5), { at: { x: 10, y: 10 }, res: 0.25, margin: 4 });
  const flat = DEFAULT_TOOLS[0].cutter, ball = DEFAULT_TOOLS[2].cutter;

  it('roughing: levels no deeper than the stepdown, never closer to the surface than the allowance', () => {
    const r = raster3dOp(m, flat, { ...RASTER3D_DEFAULTS, model: 'm', pass: 'rough', stepdown: 2, stepover: 2.5, allowance: 0.5 }, ctx);
    expect(r.warnings).toEqual([]);
    const t = trace(r.moves);
    const cuts = t.filter((p) => p.kind === 'feed');
    expect(cuts.length).toBeGreaterThan(20);
    const levels = [...new Set(cuts.map((p) => +p.z.toFixed(4)))].sort((a, b) => b - a);
    expect(levels).toContain(-2);
    expect(levels).toContain(-4);
    expect(Math.min(...levels)).toBeCloseTo(-5, 4); // the flat bottom, cut to depth
    // the flat end mill's bottom never comes within the allowance of the pyramid under it
    const R = flat.diameter / 2;
    for (const p of cuts) {
      if (p.z <= -5 + 1e-6) continue;
      let top = 0;
      for (let a = 0; a < 16; a++) for (const rr of [0, R / 2, R]) top = Math.max(top, pyrZ(20, 5, p.x - 10 + rr * Math.cos(a), p.y - 10 + rr * Math.sin(a)));
      // (the grid samples the surface every 0.25 mm: a ridge between samples can be up to ~0.06 higher)
      // never into the model; the allowance is kept except right where the slope meets the floor
      // (the floor is cut with no allowance, and that step falls within one grid cell)
      expect(p.z + 5).toBeGreaterThanOrEqual(top - 0.1);
      if (top > 0.6) expect(p.z + 5).toBeGreaterThanOrEqual(top + 0.5 - 0.1);
    }
    // starts and ends at the safe height
    expect(r.moves[0]).toEqual({ kind: 'rapid', z: 5 });
    expect(r.moves.at(-1)).toEqual({ kind: 'rapid', z: 5 });
    expect(r.depth).toBeCloseTo(5, 4);
  });

  it('finishing: the ball rides on the surface and reaches it', () => {
    const r = raster3dOp(m, ball, { ...RASTER3D_DEFAULTS, model: 'm', pass: 'finish', stepover: 0.5, dir: 'x' }, ctx);
    const cuts = trace(r.moves).filter((p) => p.kind === 'feed');
    const R = ball.diameter / 2;
    let touching = 0;
    for (const p of cuts) {
      // lowest point of the ball's sphere over the pyramid: never into it
      let gap = Infinity;
      for (let a = 0; a < 24; a++)
        for (const rr of [0, R / 3, (2 * R) / 3, R]) {
          const x = p.x + rr * Math.cos((a * Math.PI) / 12), y = p.y + rr * Math.sin((a * Math.PI) / 12);
          gap = Math.min(gap, p.z + 5 + R - Math.sqrt(R * R - rr * rr) - pyrZ(20, 5, x - 10, y - 10));
        }
      expect(gap).toBeGreaterThan(-0.1);
      if (gap < 0.05) touching++;
    }
    expect(touching / cuts.length).toBeGreaterThan(0.9);
  });

  it('a model bigger than the grid limit is refused with a message', () => {
    const big = model(pyramid(2000, 5), { res: 0.25 });
    expect(raster3dOp(big, flat, { ...RASTER3D_DEFAULTS, model: 'm' }, ctx).warnings[0]).toMatch(/resolution coarser/);
  });

  it('a job with roughing then finishing writes a MASSO file that matches the golden file', async () => {
    const job = newJob('Pyramid 3D', 'woodworker');
    job.stock = { x: 60, y: 60, z: 19.05 };
    job.models = [model(pyramid(20, 5), { at: { x: 20, y: 20 }, res: 0.5, margin: 2 })];
    job.ops = [
      { id: 'r', kind: 'raster3d', name: '3D rough', toolNumber: 1, rpm: 18000, feed: 2000, plunge: 600, enabled: true, params: { model: 'm', pass: 'rough', stepdown: 3, stepover: 2.5, allowance: 0.5 } },
      { id: 'f', kind: 'raster3d', name: '3D finish', toolNumber: 3, rpm: 18000, feed: 1500, plunge: 500, enabled: true, params: { model: 'm', pass: 'finish', stepover: 1.5, dir: 'x' } },
    ];
    const b = buildJob(job, emptyDoc(), DEFAULT_TOOLS);
    expect(b.ops.flatMap((o) => o.warnings)).toEqual([]);
    expect(b.ops.every((o) => o.moves.length > 0)).toBe(true);
    const g = jobGcode(job, b, 'golden');
    expect(g.text.match(/T\d+ M6/g)).toEqual(['T1 M6', 'T3 M6']);
    await expect(g.text).toMatchFileSnapshot('golden/pyramid_3d.nc');
  });
});
