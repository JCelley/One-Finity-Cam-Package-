import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { emptyDoc, entity } from '../src/cad/doc';
import type { Shape } from '../src/cad/geom';
import { parseSvgFont } from '../src/cad/strokeFont';
import { textOutlines, TEXT_DEFAULTS } from '../src/cad/text';
import { engraveOp, ENGRAVE_DEFAULTS, grooveWidth } from '../src/cam/ops/engrave';
import type { Ctx } from '../src/cam/ops/contour';
import type { Move } from '../src/cam/toolpath';
import { buildJob, jobGcode } from '../src/cam/build';
import { newJob } from '../src/io/formats';
import { DEFAULT_TOOLS } from '../src/cam/tools/library';

const ctx: Ctx = { z: (d) => -d, safeZ: 5, clear: 1, tol: 0.005 };
const line = (x0: number, y0: number, x1: number, y1: number): Shape => ({ kind: 'line', a: { x: x0, y: y0 }, b: { x: x1, y: y1 } });

function trace(moves: Move[], start = { x: 0, y: 0, z: 5 }) {
  const out: { x: number; y: number; z: number; kind: string }[] = [];
  let c = { ...start };
  for (const m of moves) {
    if (m.kind === 'dwell' || m.kind === 'comment' || m.kind === 'arc') continue;
    c = { x: m.x ?? c.x, y: m.y ?? c.y, z: m.z ?? c.z };
    out.push({ ...c, kind: m.kind });
  }
  return out;
}

describe('engrave', () => {
  it('follows each line itself at depth, nearest next, from the nearer end, lifting only a little between', () => {
    // far line first in the drawing, written right to left
    const items = [line(100, 0, 60, 0), line(10, 0, 30, 0)].map((s) => entity(s));
    const { moves, warnings } = engraveOp(items, { ...ENGRAVE_DEFAULTS, depth: 0.8 }, ctx);
    expect(warnings).toEqual([]);
    const t = trace(moves);
    const cuts = t.filter((p) => p.kind === 'feed');
    expect(cuts.every((p) => p.y === 0 && Math.abs(p.z + 0.8) < 1e-9)).toBe(true);
    // the near line first, from its near end; then the far one from x 60
    expect(cuts.map((p) => p.x)).toEqual([10, 30, 60, 100]);
    // safe height at the start and the end only; between strokes up to 2 mm
    const first = t.findIndex((p) => p.kind === 'feed'), last = t.length - 1 - [...t].reverse().findIndex((p) => p.kind === 'feed');
    expect(t[0].z).toBe(5);
    expect(Math.max(...t.slice(first, last).map((p) => p.z))).toBe(2);
    expect(moves.at(-1)).toEqual({ kind: 'rapid', z: 5 });
  });

  it('passes: open lines back and forth, loops round again from the nearest point', () => {
    const items = [entity(line(0, 0, 20, 0)), entity({ kind: 'circle', c: { x: 50, y: 0 }, r: 5 })];
    const { moves } = engraveOp(items, { ...ENGRAVE_DEFAULTS, depth: 2, stepdown: 1 }, ctx);
    const cuts = trace(moves).filter((p) => p.kind === 'feed');
    const depths = [...new Set(cuts.map((p) => +(-p.z).toFixed(6)))];
    expect(depths).toEqual([1, 2]);
    // line: there at 1 mm, back at 2 mm
    expect(cuts.slice(0, 4).map((p) => [p.x, -p.z])).toEqual([[0, 1], [20, 1], [20, 2], [0, 2]]);
    // the circle is entered at its point nearest (0,0)… after the line, the tool is at x 0
    const loop = cuts.slice(4);
    // (the circle is cut as short chords, so its nearest point is a hair inside the true circle)
    expect(loop[0].x).toBeCloseTo(45, 1);
    expect(loop[0].y).toBeCloseTo(0, 6);
    for (const p of loop) expect(Math.hypot(p.x - 50, p.y)).toBeCloseTo(5, 2);
    // …and each pass closes back on it
    const atStart = loop.filter((p) => Math.abs(p.x - loop[0].x) < 1e-9 && Math.abs(p.y - loop[0].y) < 1e-9);
    expect(atStart.length).toBe(4); // plunge + close, per pass
  });

  it('groove widths', () => {
    // a V-bit's diameter is its tip flat (0 = sharp)
    expect(grooveWidth({ type: 'vbit', diameter: 0, angle: 60 }, 1)).toBeCloseTo(2 * Math.tan(Math.PI / 6));
    expect(grooveWidth({ type: 'vbit', diameter: 0, angle: 90 }, 1)).toBeCloseTo(2);
    expect(grooveWidth({ type: 'vbit', diameter: 0.2, angle: 90 }, 1)).toBeCloseTo(2.2);
    expect(grooveWidth({ type: 'ball', diameter: 3, angle: 0 }, 0.5)).toBeCloseTo(2 * Math.sqrt(1.5 ** 2 - 1));
    expect(grooveWidth({ type: 'flat', diameter: 3.175, angle: 0 }, 0.5)).toBeCloseTo(3.175);
  });

  it('nothing chosen, or no depth', () => {
    expect(engraveOp([], ENGRAVE_DEFAULTS, ctx).warnings[0]).toMatch(/Nothing to cut/);
    expect(engraveOp([entity(line(0, 0, 1, 0))], { ...ENGRAVE_DEFAULTS, depth: 0 }, ctx).warnings[0]).toMatch(/Depth/);
  });

  it('single-line text with a V-bit: writes a MASSO file that matches the golden file', async () => {
    const font = parseSvgFont(readFileSync('src/assets/strokefonts/HersheySans1.svg', 'utf8'));
    const doc = emptyDoc();
    doc.entities = textOutlines(font, { ...TEXT_DEFAULTS, text: 'HI', height: 10, at: { x: 20, y: 20 } }).map((s, i) => ({ ...entity(s), id: `s${i}` }));
    const job = newJob('Engrave', 'woodworker');
    job.ops = [{ id: 'e', kind: 'engrave', name: 'Engrave HI', toolNumber: 4, rpm: 18000, feed: 1500, plunge: 500, enabled: true, params: { depth: 0.5, geometry: doc.entities.map((e) => e.id) } }];
    const b = buildJob(job, doc, DEFAULT_TOOLS);
    expect(b.ops[0].warnings).toEqual([]);
    expect(b.ops[0].tool?.cutter.type).toBe('vbit');
    const g = jobGcode(job, b, 'golden');
    expect(g.text).toContain('T4 M6');
    // three strokes of H, one of I; lifting to Z2 between them
    expect(g.text.match(/Z-0\.5/g)?.length).toBe(4);
    await expect(g.text).toMatchFileSnapshot('golden/engrave_text.nc');
  });
});
