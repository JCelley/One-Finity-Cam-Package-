import { describe, it, expect } from 'vitest';
import { entity, emptyDoc, type Entity } from '../src/cad/doc';
import type { Pt, Shape } from '../src/cad/geom';
import type { Move } from '../src/cam/toolpath';
import { profileOp, PROFILE_DEFAULTS, tabIntervals } from '../src/cam/ops/profile';
import { pocketOp, POCKET_DEFAULTS, rasterLines } from '../src/cam/ops/pocket';
import { drillOp, DRILL_DEFAULTS } from '../src/cam/ops/drill';
import { levels, type Ctx } from '../src/cam/ops/contour';
import { buildJob, jobGcode, moveStats } from '../src/cam/build';
import { newJob } from '../src/io/formats';
import { DEFAULT_TOOLS } from '../src/cam/tools/library';

const ctx: Ctx = { z: (d) => -d, safeZ: 5, clear: 1, tol: 0.005 };
const rect = (x: number, y: number, w: number, h: number): Shape => ({ kind: 'poly', closed: true, pts: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] });
const D = 6.35, R = D / 2;

/** positions the tool passes through (absolute, filled from modal moves) */
function trace(moves: Move[], start = { x: 0, y: 0, z: 5 }) {
  const out: { x: number; y: number; z: number; kind: string; rate?: string }[] = [];
  let c = { ...start };
  for (const m of moves) {
    if (m.kind === 'dwell' || m.kind === 'comment' || m.kind === 'arc') continue;
    c = { x: m.x ?? c.x, y: m.y ?? c.y, z: m.z ?? c.z };
    out.push({ ...c, kind: m.kind, rate: m.kind === 'feed' ? m.rate : undefined });
  }
  return out;
}

/** distance from p to the outline of rect (0,0,50,30) */
const rectDist = (p: Pt) => {
  const dx = Math.max(-p.x, 0, p.x - 50), dy = Math.max(-p.y, 0, p.y - 30);
  const inside = p.x >= 0 && p.x <= 50 && p.y >= 0 && p.y <= 30;
  return inside ? -Math.min(p.x, 50 - p.x, p.y, 30 - p.y) : Math.hypot(dx, dy);
};

describe('depth passes', () => {
  it('even passes, none deeper than the stepdown', () => {
    expect(levels(0, 6, 3)).toEqual([3, 6]);
    expect(levels(0, 7, 3)).toHaveLength(3);
    expect(levels(0, 7, 3)[2]).toBeCloseTo(7);
    expect(levels(2, 2, 1)).toEqual([]);
  });
  it('tabs fit or are dropped', () => {
    expect(tabIntervals(100, 4, 10)).toHaveLength(4);
    expect(tabIntervals(30, 4, 10)).toEqual([]);
  });
});

describe('profile', () => {
  const part = [entity(rect(0, 0, 50, 30))];

  it('outside: the tool centre rides one radius off the part, down to depth in passes', () => {
    const r = profileOp(part, D, { ...PROFILE_DEFAULTS, side: 'outside', depth: 6, stepdown: 2, ramp: 0 }, ctx);
    expect(r.warnings).toEqual([]);
    const cuts = trace(r.moves).filter((p) => p.kind === 'feed');
    for (const p of cuts) expect(rectDist(p)).toBeGreaterThan(R - 0.01);
    for (const p of cuts) expect(rectDist(p)).toBeLessThan(R + 0.01);
    expect(Math.min(...cuts.map((p) => p.z))).toBeCloseTo(-6);
    expect(new Set(cuts.map((p) => p.z.toFixed(3)))).toEqual(new Set(['-2.000', '-4.000', '-6.000']));
  });

  it('inside: one radius inside, and the allowance is left on the wall', () => {
    const r = profileOp(part, D, { ...PROFILE_DEFAULTS, side: 'inside', allowance: 0.5 }, ctx);
    for (const p of trace(r.moves).filter((q) => q.kind === 'feed')) expect(rectDist(p)).toBeCloseTo(-(R + 0.5), 2);
  });

  it('climb goes clockwise round the outside, conventional counter-clockwise', () => {
    const turn = (climb: boolean) => {
      const pts = trace(profileOp(part, D, { ...PROFILE_DEFAULTS, climb, depth: 1, stepdown: 1, ramp: 0 }, ctx).moves).filter((p) => p.kind === 'feed' && p.z === -1);
      let a = 0;
      for (let i = 0; i + 1 < pts.length; i++) a += pts[i].x * pts[i + 1].y - pts[i + 1].x * pts[i].y;
      return Math.sign(a);
    };
    expect(turn(true)).toBe(-1);
    expect(turn(false)).toBe(1);
  });

  it('ramps in instead of plunging, never below the pass depth', () => {
    const r = profileOp(part, D, { ...PROFILE_DEFAULTS, depth: 3, stepdown: 3, ramp: 5 }, ctx);
    const t = trace(r.moves);
    const plunges = t.filter((p, i) => i > 0 && p.kind === 'feed' && p.rate === 'plunge');
    expect(plunges).toHaveLength(0);
    expect(Math.min(...t.map((p) => p.z))).toBeCloseTo(-3);
  });

  it('tabs: the last passes rise to tab height over the tabs', () => {
    const r = profileOp(part, D, { ...PROFILE_DEFAULTS, depth: 6, stepdown: 2, ramp: 0, tabs: { count: 2, width: 5, height: 2 } }, ctx);
    const t = trace(r.moves).filter((p) => p.kind === 'feed');
    expect(t.some((p) => Math.abs(p.z + 4) < 1e-6)).toBe(true);
    // at full depth there are gaps (tabs): points at -4 appear after the tool first reached -6
    const firstDeep = t.findIndex((p) => Math.abs(p.z + 6) < 1e-6);
    expect(t.slice(firstDeep).some((p) => Math.abs(p.z + 4) < 1e-6)).toBe(true);
  });

  it('a tool too big for the inside is reported, not cut', () => {
    const r = profileOp([entity(rect(0, 0, 5, 5))], D, { ...PROFILE_DEFAULTS, side: 'inside' }, ctx);
    expect(r.moves).toHaveLength(0);
    expect(r.warnings[0]).toMatch(/too big/);
  });

  it('open lines are cut on the line, alternating direction', () => {
    const r = profileOp([entity({ kind: 'line', a: { x: 0, y: 0 }, b: { x: 20, y: 0 } })], 3, { ...PROFILE_DEFAULTS, side: 'on', depth: 2, stepdown: 1 }, ctx);
    const f = trace(r.moves).filter((p) => p.kind === 'feed');
    expect(f.every((p) => Math.abs(p.y) < 1e-9)).toBe(true);
    expect(f[f.length - 1].x).toBeCloseTo(0);
  });
});

describe('pocket', () => {
  const frame = [entity(rect(0, 0, 50, 30)), entity(rect(20, 10, 10, 10))]; // island in the middle

  const covers = (moves: Move[], depth: number) => {
    // every point of the area the tool can reach is within a radius of a cut at full depth
    const t = trace(moves);
    const segs: [Pt, Pt][] = [];
    for (let i = 1; i < t.length; i++) if (t[i].kind === 'feed' && Math.abs(t[i].z + depth) < 1e-6 && Math.abs(t[i - 1].z + depth) < 1e-6) segs.push([t[i - 1], t[i]]);
    const near = (p: Pt) => segs.some(([a, b]) => {
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const u = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
      return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy) <= R + 1e-3;
    });
    let missed = 0;
    for (let x = R + 0.25; x < 50 - R; x += 1)
      for (let y = R + 0.25; y < 30 - R; y += 1) {
        const dx = Math.max(20 - x, 0, x - 30), dy = Math.max(10 - y, 0, y - 20);
        if (Math.hypot(dx, dy) > R + 0.01 && !near({ x, y })) missed++;
      }
    return missed;
  };

  for (const strategy of ['offset', 'raster'] as const)
    it(`${strategy}: clears the area, keeps out of the island and the walls, to depth`, () => {
      const r = pocketOp(frame, D, { ...POCKET_DEFAULTS, strategy, depth: 4, stepdown: 2 }, ctx);
      expect(r.warnings).toEqual([]);
      const cuts = trace(r.moves).filter((p) => p.kind === 'feed');
      for (const p of cuts) {
        expect(p.x).toBeGreaterThan(R - 0.01);
        expect(p.x).toBeLessThan(50 - R + 0.01);
        expect(p.y).toBeGreaterThan(R - 0.01);
        expect(p.y).toBeLessThan(30 - R + 0.01);
        // at least a radius from the island (its corners are rounded by the tool)
        const dx = Math.max(20 - p.x, 0, p.x - 30), dy = Math.max(10 - p.y, 0, p.y - 20);
        expect(Math.hypot(dx, dy)).toBeGreaterThan(R - 0.01);
        expect(p.z).toBeGreaterThanOrEqual(-4 - 1e-9);
      }
      expect(covers(r.moves, 4)).toBe(0);
    });

  it('raster lines are clipped by the region', () => {
    const rows = rasterLines([[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]], 2, 0);
    expect(rows.length).toBe(6);
    for (const s of rows) expect(Math.abs(s[1].x - s[0].x)).toBeCloseTo(10);
  });

  it('a pocket too small for the tool is reported', () => {
    expect(pocketOp([entity(rect(0, 0, 4, 4))], D, POCKET_DEFAULTS, ctx).warnings.join()).toMatch(/too big/);
  });
});

describe('drill', () => {
  it('pecks each hole, nearest next, clears chips between pecks', () => {
    const holes: Entity[] = [entity({ kind: 'circle', c: { x: 30, y: 0 }, r: 2 }), entity({ kind: 'circle', c: { x: 10, y: 0 }, r: 2 })];
    const r = drillOp(holes, 4, { ...DRILL_DEFAULTS, depth: 7, peck: 3, dwell: 0.5 }, ctx);
    expect(r.warnings).toEqual([]);
    const t = trace(r.moves);
    const feeds = t.filter((p) => p.kind === 'feed');
    expect(feeds.map((p) => p.z)).toEqual([-3, -6, -7, -3, -6, -7]);
    expect(feeds[0].x).toBe(10); // nearest to the origin first
    expect(r.moves.filter((m) => m.kind === 'dwell')).toHaveLength(2);
  });
});

describe('job build', () => {
  function sampleJob() {
    const doc = emptyDoc();
    const part = entity(rect(10, 10, 80, 50));
    const pocket = entity(rect(30, 25, 40, 20));
    const hole = entity({ kind: 'circle', c: { x: 20, y: 20 }, r: 3.175 });
    doc.entities.push(part, pocket, hole);
    const job = newJob('Test', 'woodworker');
    job.stock = { x: 100, y: 70, z: 12 };
    job.ops = [
      { id: 'p', kind: 'pocket', name: 'Pocket', toolNumber: 1, rpm: 18000, feed: 1500, plunge: 500, enabled: true, params: { geometry: [pocket.id], depth: 3 } },
      { id: 'd', kind: 'drill', name: 'Drill', toolNumber: 1, rpm: 18000, feed: 1500, plunge: 500, enabled: true, params: { geometry: [hole.id], depth: 12.5 } },
      { id: 'c', kind: 'profile', name: 'Cutout', toolNumber: 1, rpm: 18000, feed: 1500, plunge: 500, enabled: true, params: { geometry: [part.id], depth: 12.5, stepdown: 4, tabs: { count: 2, width: 6, height: 2 } } },
      { id: 'x', kind: 'profile', name: 'Off', toolNumber: 1, rpm: 18000, feed: 1500, plunge: 500, enabled: false, params: {} },
    ];
    return { job, doc };
  }

  it('builds enabled ops with times and warnings', () => {
    const { job, doc } = sampleJob();
    const b = buildJob(job, doc, DEFAULT_TOOLS);
    expect(b.ops.map((o) => o.name)).toEqual(['Pocket', 'Drill', 'Cutout']);
    for (const o of b.ops) expect(o.moves.length).toBeGreaterThan(0);
    expect(b.seconds).toBeGreaterThan(30);
    // T1's flutes are 25.4 mm: no warning; the hole is the tool's size: no warning
    expect(b.ops.flatMap((o) => o.warnings)).toEqual([]);
    expect(Math.min(...b.ops.map((o) => o.stats.minZ))).toBeCloseTo(-12.5);
  });

  it('Z0 at the spoilboard shifts every Z up by the stock thickness', () => {
    const { job, doc } = sampleJob();
    job.zZero = 'bottom';
    const b = buildJob(job, doc, DEFAULT_TOOLS);
    expect(Math.min(...b.ops.map((o) => o.stats.minZ))).toBeCloseTo(-0.5);
    expect(b.safeZ).toBeCloseTo(17);
  });

  it('flags missing items, deep cuts and missing tools', () => {
    const { job, doc } = sampleJob();
    job.ops[0].params.geometry = ['gone'];
    job.ops[1].toolNumber = 99;
    job.ops[2].params.depth = 30;
    const w = buildJob(job, doc, DEFAULT_TOOLS).ops.map((o) => o.warnings.join(' | '));
    expect(w[0]).toMatch(/no longer exist/);
    expect(w[1]).toMatch(/T99/);
    expect(w[2]).toMatch(/flutes/);
    expect(w[2]).toMatch(/spoilboard/);
  });

  it('time estimate: feed moves at feed, rapids at the rapid speed', () => {
    const s = moveStats([{ kind: 'rapid', x: 100 }, { kind: 'feed', x: 200, rate: 'cut' }, { kind: 'feed', z: -10, rate: 'plunge' }, { kind: 'dwell', seconds: 2 }], 1000, 100, 10000);
    expect(s.seconds).toBeCloseTo(0.6 + 6 + 6 + 2);
  });

  it('writes a MASSO file that matches the golden file', async () => {
    const { job, doc } = sampleJob();
    const g = jobGcode(job, buildJob(job, doc, DEFAULT_TOOLS), 'golden');
    expect(g.fileName).toBe('Test.nc');
    expect(g.text).toContain('T1 M6');
    expect(g.text.match(/ M6/g)).toHaveLength(1); // one tool for all three ops
    await expect(g.text).toMatchFileSnapshot('golden/sample_job.nc');
  });
});

describe('pocket links', () => {
  it('moves at depth between rings are short (never a long diagonal through uncut material)', () => {
    const r = pocketOp([entity(rect(0, 0, 60, 40))], D, { ...POCKET_DEFAULTS, depth: 2, stepdown: 2, stepover: 0.4 }, ctx);
    const t = trace(r.moves);
    // a feed move at depth that is not along a ring's straight edge (both x and y change) is a link
    for (let i = 1; i < t.length; i++) {
      const a = t[i - 1], b = t[i];
      if (b.kind !== 'feed' || a.z !== -2 || b.z !== -2) continue;
      if (Math.abs(a.x - b.x) > 1e-6 && Math.abs(a.y - b.y) > 1e-6) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThanOrEqual(1.5 * 0.4 * D * Math.SQRT2 + 1e-6);
    }
  });
});

describe('preview segments', () => {
  it('one segment per move, coloured by kind, arcs split into chords', async () => {
    const { previewOf, SEG_RAPID, SEG_CUT, SEG_PLUNGE } = await import('../src/cam/preview');
    const p = previewOf(
      [
        { kind: 'rapid', x: 10, y: 0 },
        { kind: 'feed', z: -2, rate: 'plunge' },
        { kind: 'feed', x: 20, rate: 'cut' },
        { kind: 'arc', cw: false, x: 30, y: 10, i: 0, j: 10, rate: 'cut' },
        { kind: 'dwell', seconds: 1 },
      ],
      { x: 0, y: 0, z: 5 },
    );
    expect([...p.kind.slice(0, 3)]).toEqual([SEG_RAPID, SEG_PLUNGE, SEG_CUT]);
    expect(p.kind.length).toBeGreaterThan(6);
    expect(p.pos.length).toBe(p.kind.length * 6);
    expect(p.end).toEqual({ x: 30, y: 10, z: -2 });
  });
});
