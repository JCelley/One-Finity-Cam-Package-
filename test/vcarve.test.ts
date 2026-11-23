import { describe, it, expect } from 'vitest';
import { entity } from '../src/cad/doc';
import type { Pt, Shape } from '../src/cad/geom';
import type { Move } from '../src/cam/toolpath';
import type { Ctx } from '../src/cam/ops/contour';
import { vcarveRegion } from '../src/cam/ops/vcarve';
import { inlayOp, vbitOf, vcarveOp, INLAY_DEFAULTS, VCARVE_DEFAULTS } from '../src/cam/ops/inlay';

const ctx: Ctx = { z: (d) => -d, safeZ: 5, clear: 1, tol: 0.005 };
const rect = (x: number, y: number, w: number, h: number): Shape => ({ kind: 'poly', closed: true, pts: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] });

function cuts(moves: Move[]) {
  const out: { x: number; y: number; z: number }[] = [];
  let c = { x: 0, y: 0, z: 5 };
  for (const m of moves) {
    if (m.kind !== 'feed' && m.kind !== 'rapid') continue;
    c = { x: m.x ?? c.x, y: m.y ?? c.y, z: m.z ?? c.z };
    if (m.kind === 'feed') out.push(c);
  }
  return out;
}

/** distance from p to the outline of rect (0,0,w,h), negative outside */
const inset = (p: Pt, w: number, h: number) => Math.min(p.x, w - p.x, p.y, h - p.y);

describe('V-carve', () => {
  it('a 90° bit in a 20 × 10 rectangle: tip on the centre line, depth = distance to the nearest wall', () => {
    const r = vcarveOp([entity(rect(0, 0, 20, 10))], vbitOf(90, 0), { ...VCARVE_DEFAULTS, maxDepth: 20 }, ctx);
    expect(r.warnings).toEqual([]);
    const c = cuts(r.moves);
    expect(c.length).toBeGreaterThan(4);
    for (const p of c) {
      // the cone (45°) touches the walls exactly: its depth equals the room to the nearest wall
      expect(-p.z).toBeCloseTo(inset(p, 20, 10), 1);
      expect(-p.z).toBeLessThanOrEqual(5 + 1e-6);
    }
    // the deepest line is the middle, 5 deep (half the width), running 5..15 along X
    const deep = c.filter((p) => Math.abs(p.z + 5) < 1e-3);
    expect(Math.min(...deep.map((p) => p.x))).toBeCloseTo(5, 1);
    expect(Math.max(...deep.map((p) => p.x))).toBeCloseTo(15, 1);
    // and it reaches into the corners (sharp inside corners)
    expect(c.some((p) => Math.hypot(p.x, p.y) < 0.5 && p.z > -0.5)).toBe(true);
  });

  it('a 60° bit goes deeper for the same width', () => {
    const r = vcarveOp([entity(rect(0, 0, 20, 10))], vbitOf(60, 0), { ...VCARVE_DEFAULTS, maxDepth: 20 }, ctx);
    const deepest = Math.min(...cuts(r.moves).map((p) => p.z));
    expect(-deepest).toBeCloseTo(5 / Math.tan(Math.PI / 6), 1);
  });

  it('the depth cap leaves a flat middle, reported for clearing', () => {
    const r = vcarveOp([entity(rect(0, 0, 40, 30))], vbitOf(90, 0), { ...VCARVE_DEFAULTS, maxDepth: 3 }, ctx);
    expect(Math.min(...cuts(r.moves).map((p) => p.z))).toBeCloseTo(-3);
    expect(r.warnings.join()).toMatch(/clearing tool/);
    const withClear = vcarveOp([entity(rect(0, 0, 40, 30))], vbitOf(90, 0), { ...VCARVE_DEFAULTS, maxDepth: 3, clearTool: 1 }, ctx);
    expect(withClear.flat).toHaveLength(1);
    // flat area = the rectangle shrunk by 3 (the bit's reach at 3 deep): 34 × 24
    const xs = withClear.flat[0].map((p) => p.x), ys = withClear.flat[0].map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(34, 2);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(24, 2);
    expect(withClear.flatDepth).toBe(3);
  });

  it('a flat-tipped bit carves shallower by its tip', () => {
    const r = vcarveOp([entity(rect(0, 0, 20, 10))], vbitOf(90, 2), { ...VCARVE_DEFAULTS, maxDepth: 20 }, ctx);
    expect(-Math.min(...cuts(r.moves).map((p) => p.z))).toBeCloseTo(4, 1);
  });

  it('holes stay standing: an O carves a ring, never inside the hole', () => {
    const ring = vcarveOp([entity({ kind: 'circle', c: { x: 0, y: 0 }, r: 10 }), entity({ kind: 'circle', c: { x: 0, y: 0 }, r: 6 })], vbitOf(90, 0), { ...VCARVE_DEFAULTS, maxDepth: 20 }, ctx);
    for (const p of cuts(ring.moves)) {
      const r = Math.hypot(p.x, p.y);
      expect(r).toBeGreaterThan(6 - 1e-3);
      expect(r).toBeLessThan(10 + 1e-3);
      // depth = distance to the nearer circle
      expect(-p.z).toBeCloseTo(Math.min(r - 6, 10 - r), 1);
    }
  });

  it('inside corners of an L: the tip runs into the corner (sweeps the reflex vertex)', () => {
    const L: Shape = { kind: 'poly', closed: true, pts: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 20 }, { x: 0, y: 20 }] };
    const r = vcarveRegion([(L as Extract<Shape, { kind: 'poly' }>).pts], vbitOf(90, 0), { maxDepth: 20, startDepth: 0, stepdown: 100, spacing: 0.2 }, ctx);
    const c = cuts(r.moves);
    // never gouges: every tip position is at least its depth from every wall of the L
    const wallDist = (p: Pt) => {
      const segs: [Pt, Pt][] = L.kind === 'poly' ? L.pts.map((a, i) => [a, L.pts[(i + 1) % L.pts.length]]) : [];
      return Math.min(...segs.map(([a, b]) => {
        const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
      }));
    };
    for (const p of c) expect(-p.z).toBeLessThanOrEqual(wallDist(p) + 0.02);
    // deepest where the arms meet: the circle touching both outer walls and the inside corner
    expect(-Math.min(...c.map((p) => p.z))).toBeCloseTo((6 * Math.SQRT2) / (1 + Math.SQRT2), 1);
  });
});

describe('inlay', () => {
  const heart = [entity(rect(10, 10, 30, 20))];
  it('pocket = V-carve to the pocket depth', () => {
    const r = inlayOp(heart, vbitOf(60, 0), { ...INLAY_DEFAULTS, side: 'pocket', pocketDepth: 4, clearTool: 1 }, ctx);
    expect(Math.min(...cuts(r.moves).map((p) => p.z))).toBeCloseTo(-4, 3);
    expect(r.flatDepth).toBe(4);
    expect(r.flat.length).toBe(1);
  });

  it('plug: mirrored, walls start at pocket depth − gap, cut down to that + proud, outside the shape', () => {
    const asym = [entity({ kind: 'poly', closed: true, pts: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 0, y: 20 }] })]; // right angle at the left
    const p = { ...INLAY_DEFAULTS, side: 'plug' as const, pocketDepth: 5, gap: 1, proud: 2, margin: 6, clearTool: 1 };
    const r = inlayOp(asym, vbitOf(60, 0), p, ctx);
    expect(r.warnings.join()).toMatch(/separate board/);
    const c = cuts(r.moves);
    // never deeper than 4 + 2, and never shallower than the start depth where it touches the shape
    expect(Math.min(...c.map((q) => q.z))).toBeGreaterThanOrEqual(-6 - 1e-6);
    // mirrored: the right angle is now at (30, 0); the tip never enters the mirrored triangle
    const insideMirrored = (q: Pt) => q.x > 1e-3 && q.x < 30 - 1e-3 && q.y > 1e-3 && q.y < (20 * q.x) / 30 - 1e-3;
    for (const q of c) expect(insideMirrored(q)).toBe(false);
    // the walls start at the start depth (4): the tip is never shallower than that
    for (const q of c) expect(q.z).toBeLessThanOrEqual(-4 + 1e-6);
    expect(r.flatDepth).toBe(6);
  });

  it('refuses a glue gap as deep as the pocket', () => {
    expect(inlayOp(heart, vbitOf(60, 0), { ...INLAY_DEFAULTS, gap: 5, pocketDepth: 5 }, ctx).warnings[0]).toMatch(/gap/);
  });
});

describe('V-carve in a job', () => {
  it('clears flats with an end mill first, then V-carves; one tool change; inlay halves stay apart', async () => {
    const { emptyDoc } = await import('../src/cad/doc');
    const { newJob } = await import('../src/io/formats');
    const { buildJob, jobGcode } = await import('../src/cam/build');
    const { DEFAULT_TOOLS } = await import('../src/cam/tools/library');
    const doc = emptyDoc();
    const box = entity(rect(10, 10, 60, 40));
    doc.entities.push(box);
    const job = newJob('Sign', 'woodworker');
    job.ops = [
      { id: 'v', kind: 'vcarve', name: 'Carve', toolNumber: 5, rpm: 18000, feed: 1500, plunge: 500, enabled: true, params: { geometry: [box.id], maxDepth: 3, clearTool: 1 } },
    ];
    const b = buildJob(job, doc, DEFAULT_TOOLS);
    expect(b.ops.map((o) => [o.id, o.tool?.number])).toEqual([['v:clear', 1], ['v', 5]]);
    expect(b.ops.every((o) => o.moves.length > 0)).toBe(true);
    expect(b.ops.flatMap((o) => o.warnings)).toEqual([]);
    const g = jobGcode(job, b, 'golden');
    expect(g.text.match(/T\d+ M6/g)).toEqual(['T1 M6', 'T5 M6']);

    job.ops = [
      { id: 'a', kind: 'inlay', name: 'Pocket', toolNumber: 4, rpm: 18000, feed: 1500, plunge: 500, enabled: true, params: { geometry: [box.id], side: 'pocket' } },
      { id: 'b', kind: 'inlay', name: 'Plug', toolNumber: 4, rpm: 18000, feed: 1500, plunge: 500, enabled: true, params: { geometry: [box.id], side: 'plug' } },
    ];
    const b2 = buildJob(job, doc, DEFAULT_TOOLS);
    expect(() => jobGcode(job, b2)).toThrow(/different boards/);
    expect(jobGcode(job, b2, 'x', ['b']).fileName).toBe('Sign_Plug.nc');
  });

  it('a V-carve with a straight bit is refused', async () => {
    const { emptyDoc } = await import('../src/cad/doc');
    const { newJob } = await import('../src/io/formats');
    const { buildJob } = await import('../src/cam/build');
    const { DEFAULT_TOOLS } = await import('../src/cam/tools/library');
    const doc = emptyDoc();
    const box = entity(rect(0, 0, 10, 10));
    doc.entities.push(box);
    const job = newJob('x', 'woodworker');
    job.ops = [{ id: 'v', kind: 'vcarve', name: 'Carve', toolNumber: 1, rpm: 18000, feed: 1500, plunge: 500, enabled: true, params: { geometry: [box.id] } }];
    expect(buildJob(job, doc, DEFAULT_TOOLS).ops[0].warnings.join()).toMatch(/needs a V-bit/);
  });
});
