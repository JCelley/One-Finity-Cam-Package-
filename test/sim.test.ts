import { describe, it, expect } from 'vitest';
import { entity, emptyDoc } from '../src/cad/doc';
import type { Shape } from '../src/cad/geom';
import { buildJob, jobGcode } from '../src/cam/build';
import { machineById } from '../src/cam/machines';
import { DEFAULT_TOOLS } from '../src/cam/tools/library';
import { newJob } from '../src/io/formats';
import { interpret, segAt, segPoint, splitLine } from '../src/sim/gcode';
import { analyse, Cutting } from '../src/sim/simulate';
import { placeJob, simTool } from '../src/sim/setup';

const machine = machineById('woodworker');
const rect = (x: number, y: number, w: number, h: number): Shape => ({ kind: 'poly', closed: true, pts: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] });
const lib = new Map(DEFAULT_TOOLS.map((t) => [t.number, simTool(t)]));
const tools = (n: number) => lib.get(n);
const toolLen = (n: number) => lib.get(n)?.len ?? 0;

/** a 100 × 70 × 12 board at machine (50, 50), Z0 on its top */
const place = placeJob(machine, { x: 100, y: 70, z: 12 }, 'top', { x: 50, y: 50 }, 0.5);
const run = (text: string, extra: Partial<Parameters<typeof interpret>[1]> = {}) => interpret(text, { offsets: [place.offset], toolLen, rapid: machine.rapid, ...extra });
const check = (text: string) => analyse(run(text), place.setup, tools).warnings;
const head = 'G90 G94 G17 G21 G40 G49 G80\nG54\nG53 G0 Z0\nT1 M6\nG43 H1\nM3 S18000\nG0 X10 Y10\nZ5\n';

describe('reading G-code', () => {
  it('words and comments', () => {
    expect(splitLine('N10 g1 x1.5 Y-.25 (cut) F1500 ; the end')).toEqual({ words: [['N', 10], ['G', 1], ['X', 1.5], ['Y', -0.25], ['F', 1500]], comment: 'cut the end' });
  });

  it('work offset, tool length, G53, inches, arcs and times', () => {
    const p = run(`${head}G1 Z-1 F600\nG20 G1 X1 F10\nG21 G3 X25.4 Y30 I0 J10 F1200\nG91 G1 X-5\nG90\nG4 P2\nG53 G0 Z0\nM5\nM30\n`);
    expect(p.issues).toEqual([]);
    expect(p.tools).toEqual([1]);
    const L = lib.get(1)!.len;
    const o = place.offset;
    const at = (line: string) => [...p.segs].reverse().find((s) => p.lines[s.line] === line)!;
    // G0 X10 Y10 at the top: the tip hangs the tool length below the nose at machine Z0
    expect(at('G0 X10 Y10').to).toEqual({ x: o.x + 10, y: o.y + 10, z: -L });
    expect(at('Z5').to.z).toBeCloseTo(o.z + 5, 9);
    expect(at('G1 Z-1 F600').to.z).toBeCloseTo(o.z - 1, 9);
    // 6 mm at 600 mm/min = 0.6 s
    expect(at('G1 Z-1 F600').t1 - at('G1 Z-1 F600').t0).toBeCloseTo(0.6, 6);
    // inches: X1 = 25.4 mm, F10 = 254 mm/min
    expect(at('G20 G1 X1 F10').to.x).toBeCloseTo(o.x + 25.4, 9);
    expect(at('G20 G1 X1 F10').feed).toBeCloseTo(254, 9);
    // a half circle of radius 10 round (25.4, 20): π·10 mm at 1200 mm/min
    const arc = at('G21 G3 X25.4 Y30 I0 J10 F1200');
    expect(arc.arc!.sweep).toBeCloseTo(Math.PI, 9);
    expect(arc.t1 - arc.t0).toBeCloseTo(((Math.PI * 10) / 1200) * 60, 6);
    // G91: 5 back in X from where it was
    expect(at('G91 G1 X-5').to.x).toBeCloseTo(at('G21 G3 X25.4 Y30 I0 J10 F1200').to.x - 5, 9);
    expect(at('G4 P2').t1 - at('G4 P2').t0).toBe(2);
    // G53 Z0: the nose at the top
    expect(at('G53 G0 Z0').to.z).toBeCloseTo(-L, 9);
    expect(p.duration).toBeCloseTo(p.segs.at(-1)!.t1, 9);
  });

  it('arcs: positions along the sweep, and an arc that does not close is reported', () => {
    const p = run(`${head}G1 Z-1 F600\nG1 X20 Y10\nG3 X10 Y20 I-10 J0 F1200\nG2 X20 Y10 I0 J-9\nM30\n`);
    const a = p.segs.find((s) => s.kind === 'arc')!;
    const c = { x: place.offset.x + 10, y: place.offset.y + 10 };
    // a quarter circle radius 10, counter-clockwise from 0° to 90°
    expect(a.arc!.sweep).toBeCloseTo(Math.PI / 2, 9);
    const m = segPoint(a, 0.5);
    expect(Math.hypot(m.x - c.x, m.y - c.y)).toBeCloseTo(10, 6);
    expect(Math.atan2(m.y - c.y, m.x - c.x)).toBeCloseTo(Math.PI / 4, 6);
    expect(a.length).toBeCloseTo((Math.PI / 2) * 10, 6);
    expect(p.issues.map((i) => i.text).join()).toMatch(/arc's start and end/);
    expect(segAt(p.segs, a.t0 + 0.01)).toBe(p.segs.indexOf(a));
  });

  it('reports what it cannot simulate', () => {
    const p = run('G90\nG18\nG81 X1\nM8\nT2\nG1 X5\n');
    const t = p.issues.map((i) => `${i.line}: ${i.text}`);
    expect(t).toContain('1: G18: only the XY plane (G17) is simulated');
    expect(t).toContain('2: G81 is not simulated');
    expect(t.join()).toMatch(/5: A cutting move with no feed rate/);
    expect(t.join()).toMatch(/no M30/);
  });

  it('without G43 the tip is a tool length lower; with tloOnM6 the M6 applies it', () => {
    const txt = 'G21 G90 G54\nT1 M6\nG0 X0 Y0 Z5\nM30\n';
    const L = lib.get(1)!.len;
    expect(run(txt).segs.at(-1)!.to.z).toBeCloseTo(place.offset.z + 5 - L, 9);
    expect(run(txt, { tloOnM6: true }).segs.at(-1)!.to.z).toBeCloseTo(place.offset.z + 5, 9);
  });
});

describe('cutting the stock', () => {
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
    ];
    return { job, doc };
  }

  it('the posted file of a job cuts its pocket, hole and outline, with no warnings', () => {
    const { job, doc } = sampleJob();
    const b = buildJob(job, doc, DEFAULT_TOOLS);
    const g = jobGcode(job, b, 'sim');
    const p = run(g.text);
    expect(p.issues).toEqual([]);
    // the file's run time: the CAM's estimate plus the trips to the tool change
    expect(p.duration).toBeGreaterThan(b.seconds * 0.98);
    expect(p.duration).toBeLessThan(b.seconds * 1.1 + 10);
    const { warnings, final } = analyse(p, place.setup, tools);
    expect(warnings).toEqual([]);
    const s = final.stock, o = place.offset;
    const h = (x: number, y: number) => s.at(o.x + x, o.y + y) - o.z;
    expect(h(50, 35)).toBeCloseTo(-3, 3); // pocket floor
    expect(h(5, 5)).toBe(0); // uncut board
    expect(h(20, 20)).toBeCloseTo(-12.5, 3); // the hole, through into the spoilboard
    expect(h(98, 35)).toBe(0);
    expect(h(50, 10 - 3.175)).toBeLessThan(-9.9); // the outline: through, or down to a tab
    expect(h(60, 35)).toBeCloseTo(-3, 3);
  });

  it('playing forward in steps ends with the same stock as one run', () => {
    const { job, doc } = sampleJob();
    const p = run(jobGcode(job, buildJob(job, doc, DEFAULT_TOOLS), 'sim').text);
    const all = analyse(p, place.setup, tools).final.stock.z;
    const c = new Cutting(p, place.setup, tools);
    for (let t = 0; t <= p.duration + 1; t += p.duration / 37) {
      const i = segAt(p.segs, t), s = p.segs[i];
      c.advanceTo(i, s.t1 > s.t0 ? Math.min(1, (t - s.t0) / (s.t1 - s.t0)) : 1);
    }
    c.advanceTo(p.segs.length, 0);
    let diff = 0;
    for (let k = 0; k < all.length; k++) diff = Math.max(diff, Math.abs(all[k] - c.stock.z[k]));
    // (samples fall in other places along a move: a ramp's floor can differ by a hair)
    expect(diff).toBeLessThan(0.02);
    // going back is refused (the caller starts again from a fresh stock)
    expect(c.advanceTo(0, 0)).toBeNull();
  });
});

describe('simulator warnings', () => {
  const kinds = (text: string) => check(text).map((w) => w.kind);

  it('a clean file has none', () => {
    expect(check(`${head}G1 Z-2 F500\nX40 F1500\nG0 Z5\nG53 G0 Z0\nM5\nM30\n`)).toEqual([]);
  });

  it('a rapid through the stock', () => {
    const w = check(`${head}G0 Z-2\nX40\nG0 Z5\nM5\nM30\n`);
    expect(w.map((q) => q.kind)).toEqual(['rapid']);
    expect(w[0].line).toBe(head.split('\n').length - 1);
  });

  it('cutting with the spindle stopped, or with no tool', () => {
    expect(kinds(`${head}M5\nG1 Z-2 F500\nX40\nM30\n`)).toEqual(['spindle']);
    expect(kinds('G21 G90 G54\nG0 X10 Y10 Z5\nG1 Z-2 F500\nM30\n')).toEqual(['notool']);
  });

  it('deeper than the flutes: once, with a count', () => {
    // T2 (1/8" flat) has 12.7 mm flutes; the bottom of the board is 12 down: cut into the spoilboard
    const t = head.replace(/T1 M6\nG43 H1/, 'T2 M6\nG43 H2');
    const w = check(`${t}G1 Z-13.5 F300\nX40 F1000\nY40\nG0 Z5\nM30\n`);
    const fl = w.find((q) => q.kind === 'flutes')!;
    expect(fl.text).toMatch(/T2 cuts 13\.5 mm deep, more than its 12\.7 mm flutes/);
    expect(fl.count).toBe(3);
    expect(w.map((q) => q.kind)).toContain('bed');
  });

  it("plunging with a tool that can't", () => {
    const noPlunge = new Map(lib);
    noPlunge.set(1, { ...lib.get(1)!, plunge: false });
    const a = (txt: string) => analyse(run(txt), place.setup, (n) => noPlunge.get(n)).warnings.map((w) => w.kind);
    expect(a(`${head}G1 Z-2 F500\nX40\nG0 Z5\nM30\n`)).toEqual(['plunge']);
    // a 3° ramp in is fine
    expect(a(`${head}G1 Z0 F500\nX48.16 Z-2\nX40\nG0 Z5\nM30\n`)).toEqual([]);
  });

  it('past the machine travel', () => {
    const w = check(`${head}G0 X900\nG0 Y-60\nM30\n`);
    expect(w.map((q) => q.kind)).toEqual(['travel', 'travel']);
    expect(w[0].text).toMatch(/X travel/);
    expect(w[1].text).toMatch(/Y travel/);
    // Z: a tool length offset for a much longer tool puts the nose above the top
    expect(kinds(`${head}G0 Z60\nM30\n`)).toEqual([]);
    expect(kinds(`${head}G0 Z120\nM30\n`)).toEqual(['travel']);
  });

  it('a tool that is not in the library', () => {
    const w = check(head.replace(/T1 M6\nG43 H1/, 'T42 M6\nG43 H42') + 'M30\n');
    expect(w.map((q) => q.text)).toEqual(['T42 is not in the tool library: simulated as a 3 mm flat end mill']);
  });
});
