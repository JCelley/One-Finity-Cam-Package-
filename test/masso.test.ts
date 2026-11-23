import { describe, it, expect } from 'vitest';
import { postMasso, massoFileName, type MassoJob } from '../src/post/masso';
import { DEFAULT_TOOLS, validateLibrary } from '../src/cam/tools/library';
import { machineById } from '../src/cam/machines';
import { moveBounds, pathsToMoves, type Move } from '../src/cam/toolpath';

const t1 = DEFAULT_TOOLS.find((t) => t.number === 1)!;
const t4 = DEFAULT_TOOLS.find((t) => t.number === 4)!;

/** 50 × 30 rectangle with 5 mm corner radii, tool on the line, 2 passes of 3 mm, then a V line */
function sampleJob(units: 'mm' | 'in' = 'mm'): MassoJob {
  const r = 5, W = 50, H = 30;
  const lap = (z: number): Move[] => [
    { kind: 'feed', x: r, y: 0, z, rate: 'plunge' },
    { kind: 'feed', x: W - r, y: 0, rate: 'cut' },
    { kind: 'arc', cw: false, x: W, y: r, i: 0, j: r, rate: 'cut' },
    { kind: 'feed', x: W, y: H - r, rate: 'cut' },
    { kind: 'arc', cw: false, x: W - r, y: H, i: -r, j: 0, rate: 'cut' },
    { kind: 'feed', x: r, y: H, rate: 'cut' },
    { kind: 'arc', cw: false, x: 0, y: H - r, i: 0, j: -r, rate: 'cut' },
    { kind: 'feed', x: 0, y: r, rate: 'cut' },
    { kind: 'arc', cw: false, x: r, y: 0, i: r, j: 0, rate: 'cut' },
  ];
  return {
    name: 'Test plate (rev A)',
    units,
    wcs: 1,
    safeZ: 5,
    zeroNote: 'X0 Y0 front-left of stock, Z0 top of stock',
    machine: machineById('woodworker'),
    stamp: 'golden',
    ops: [
      {
        name: 'Profile on line',
        tool: t1,
        rpm: 18000,
        feed: 1500,
        plunge: 500,
        moves: [{ kind: 'rapid', x: r, y: 0 }, { kind: 'rapid', z: 1 }, ...lap(-3), ...lap(-6), { kind: 'rapid', z: 5 }],
      },
      {
        name: 'Second profile same tool',
        tool: t1,
        rpm: 16000,
        feed: 1500,
        plunge: 500,
        moves: [{ kind: 'rapid', x: 10, y: 10 }, { kind: 'feed', z: -1, rate: 'plunge' }, { kind: 'feed', x: 20, rate: 'cut' }, { kind: 'rapid', z: 5 }],
      },
      {
        name: 'V line',
        tool: t4,
        rpm: 18000,
        feed: 1200,
        plunge: 400,
        moves: [{ kind: 'rapid', x: 10, y: 15 }, { kind: 'feed', z: -2, rate: 'plunge' }, { kind: 'feed', x: 40, rate: 'cut' }, { kind: 'dwell', seconds: 0.5 }, { kind: 'rapid', z: 5 }],
      },
    ],
  };
}

describe('MASSO post', () => {
  it('matches the golden file (mm)', async () => {
    const r = postMasso(sampleJob('mm'));
    expect(r.warnings).toEqual([]);
    await expect(r.text).toMatchFileSnapshot('golden/test_plate_mm.nc');
  });

  it('matches the golden file (inch)', async () => {
    await expect(postMasso(sampleJob('in')).text).toMatchFileSnapshot('golden/test_plate_in.nc');
  });

  it('tool change sequence: retract, T# M6, G43 H#, spindle on, then across before down', () => {
    const lines = postMasso(sampleJob()).text.split('\n');
    const i = lines.indexOf('T4 M6');
    expect(i).toBeGreaterThan(0);
    expect(lines.slice(i - 3, i + 5)).toEqual(['G53 G0 Z0', 'M5', '(V line - T4 60° V-bit)', 'T4 M6', 'G43 H4', 'M3 S18000', 'G0 X10 Y15', 'Z5']);
    // same tool, new speed: no tool change, just S
    expect(lines).toContain('S16000');
    expect(lines.filter((l) => / M6$/.test(l))).toEqual(['T1 M6', 'T4 M6']);
  });

  it('header, units, work offset and end of program', () => {
    const t = postMasso({ ...sampleJob(), wcs: 3 }).text;
    expect(t).toMatch(/^%\n\(Test plate rev A\)\n/);
    expect(t).toContain('G90 G94 G17 G21 G40 G49 G80\nG56\n');
    expect(t.trimEnd().split('\n').slice(-4)).toEqual(['G53 G0 Z0', 'M5', 'M30', '%']);
  });

  it('arcs carry their own G word and I/J; feed is modal', () => {
    const t = postMasso(sampleJob()).text;
    expect(t).toContain('G3 X50 Y5 I0 J5');
    const feeds = t.match(/F\d+/g)!;
    // plunge then cut, per lap and per op
    expect(feeds.slice(0, 4)).toEqual(['F500', 'F1500', 'F500', 'F1500']);
  });

  it('options: no G43, no machine retract, dwell, park', () => {
    const t = postMasso({ ...sampleJob(), toolLength: false, machineRetract: false, spindleDelay: 2, parkAtZero: true }).text;
    expect(t).not.toContain('G43');
    expect(t).not.toContain('G53');
    expect(t).toContain('M3 S18000\nG4 P2\n');
    expect(t).toContain('G0 X0 Y0\nM30');
  });

  it('warns when the toolpath does not fit the machine or the spindle range', () => {
    const job = sampleJob();
    job.machine = machineById('machinist');
    job.ops[0].moves.push({ kind: 'rapid', x: 500 });
    job.ops[0].rpm = 40000;
    const w = postMasso(job).warnings;
    expect(w.some((s) => /travel/.test(s))).toBe(true);
    expect(w.some((s) => /40000 rpm/.test(s))).toBe(true);
  });

  it('rejects bad feeds and arcs with no start', () => {
    const job = sampleJob();
    job.ops[0].feed = 0;
    expect(() => postMasso(job)).toThrow(/feed/);
    const j2 = sampleJob();
    j2.ops[0].moves = [{ kind: 'arc', cw: true, x: 1, y: 1, i: 1, j: 0, rate: 'cut' }];
    expect(() => postMasso(j2)).toThrow(/arc/);
  });

  it('file names MASSO can load', () => {
    expect(massoFileName('Test plate (rev A)')).toBe('Test_plate_rev_A.nc');
    expect(massoFileName('Ünïcode / slashes\\ & stuff')).toBe('Unicode_slashes_stuff.nc');
    expect(massoFileName('')).toBe('job.nc');
    expect(massoFileName('x'.repeat(80)).length).toBe(33);
  });
});

describe('toolpath helpers', () => {
  it('bounds include arc extremes', () => {
    const b = moveBounds([{ kind: 'rapid', x: 10, y: 0, z: 0 }, { kind: 'arc', cw: false, x: 10, y: 0, i: -10, j: 0, rate: 'cut' }]);
    expect(b.min[0]).toBeCloseTo(-10);
    expect(b.max[1]).toBeCloseTo(10);
    expect(b.min[1]).toBeCloseTo(-10);
  });

  it('heightfield paths to moves: Z0 at the stock top, never below the path', () => {
    const m = pathsToMoves([Float32Array.from([0, 0, 8, 10, 0, 7])], 10, 5);
    expect(m).toContainEqual({ kind: 'feed', z: -2, rate: 'plunge' });
    expect(m).toContainEqual({ kind: 'feed', x: 10, y: 0, z: -3, rate: 'cut' });
  });

  it('default tool library is valid', () => {
    expect(validateLibrary(DEFAULT_TOOLS)).toEqual([]);
    expect(validateLibrary([t1, { ...t1, name: 'dup' }])).toContain('tool number 1 is used twice');
  });
});
