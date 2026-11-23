import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'opentype.js';
import { capHeight, textOutlines, TEXT_DEFAULTS } from '../src/cad/text';
import { shapeBox, type Box, type Shape } from '../src/cad/geom';
import { regionArea } from '../src/cad/ops';

const load = (p: string) => {
  const b = readFileSync(p);
  return parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const mont = load('node_modules/@fontsource/montserrat/files/montserrat-latin-700-normal.woff');
const box = (ss: Shape[]) => ss.reduce<Box>((b, s) => shapeBox(s, b), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

describe('text outlines', () => {
  it('capital letters are exactly the cap height, sitting on the baseline at the anchor', () => {
    const s = textOutlines(mont, { ...TEXT_DEFAULTS, text: 'HELLO', height: 20, at: { x: 10, y: 5 } });
    expect(s.length).toBeGreaterThanOrEqual(5);
    const b = box(s);
    expect(b.y0).toBeCloseTo(5, 0); // O dips a hair below the baseline
    expect(b.y1 - 5).toBeGreaterThan(19.5);
    expect(b.y1 - 5).toBeLessThan(20.6);
    expect(b.x0).toBeGreaterThanOrEqual(10);
    expect(s.every((x) => x.kind === 'poly' && x.closed)).toBe(true);
  });

  it('counters are holes: an O has an outer loop and an inner one, area of a ring', () => {
    const o = textOutlines(mont, { ...TEXT_DEFAULTS, text: 'O', height: 20, at: { x: 0, y: 0 } });
    expect(o).toHaveLength(2);
    const a = regionArea(o);
    const b = box(o);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan((b.x1 - b.x0) * (b.y1 - b.y0) * 0.6);
  });

  it('centre and right alignment, spacing, rotation, lines', () => {
    const base = { ...TEXT_DEFAULTS, text: 'TEST', height: 10, at: { x: 0, y: 0 } };
    const left = box(textOutlines(mont, base));
    const ctr = box(textOutlines(mont, { ...base, align: 'center' }));
    const right = box(textOutlines(mont, { ...base, align: 'right' }));
    expect((ctr.x0 + ctr.x1) / 2).toBeCloseTo(0, 0);
    expect(right.x1).toBeLessThanOrEqual(0.5);
    const wide = box(textOutlines(mont, { ...base, spacing: 5 }));
    expect(wide.x1 - wide.x0).toBeCloseTo(left.x1 - left.x0 + 15, 0);
    const up = box(textOutlines(mont, { ...base, angle: 90 }));
    expect(up.y1 - up.y0).toBeCloseTo(left.x1 - left.x0, 0);
    const two = box(textOutlines(mont, { ...base, text: 'TEST\nTEST' }));
    expect(two.y0).toBeCloseTo(-16, 0);
  });

  it('blank text gives nothing; script fonts join their letters into one outline', () => {
    expect(textOutlines(mont, { ...TEXT_DEFAULTS, text: '  \n ', at: { x: 0, y: 0 } })).toEqual([]);
    const script = load('node_modules/@fontsource/great-vibes/files/great-vibes-latin-400-normal.woff');
    expect(capHeight(script)).toBeGreaterThan(0);
    const s = textOutlines(script, { ...TEXT_DEFAULTS, text: 'mn', height: 20, at: { x: 0, y: 0 } });
    expect(s.length).toBeGreaterThanOrEqual(1);
    expect(s.length).toBeLessThanOrEqual(2);
  });
});

describe('text on an arc', () => {
  const pts = (ss: Shape[]) => ss.flatMap((s) => (s.kind === 'poly' ? s.pts : []));
  const base = { ...TEXT_DEFAULTS, text: 'ARCHED TEXT', height: 10, align: 'center' as const, at: { x: 0, y: 0 } };

  it('over the top: letters stand on the circle (centre below), between R and R + cap height', () => {
    const R = 60;
    const s = textOutlines(mont, { ...base, arc: R, arcSide: 'top' });
    const c = { x: 0, y: -R };
    for (const p of pts(s)) {
      const r = Math.hypot(p.x - c.x, p.y - c.y);
      expect(r).toBeGreaterThan(R - 0.6);
      expect(r).toBeLessThan(R + 10.8);
    }
    // centred: as much to the left as to the right, and highest in the middle
    const b = box(s);
    // (centring uses advance widths, so letters' side space shifts the ink a little)
    expect(Math.abs(b.x0 + b.x1)).toBeLessThan(0.1 * (b.x1 - b.x0));
    expect(b.y1).toBeLessThan(11);
    // it really bends: the ends sit well below the middle
    expect(b.y0).toBeLessThan(-5);
  });

  it('under the bottom: letters hang inside the circle (centre above), reading left to right', () => {
    const R = 60;
    const s = textOutlines(mont, { ...base, arc: R, arcSide: 'bottom' });
    const c = { x: 0, y: R };
    for (const p of pts(s)) {
      const r = Math.hypot(p.x - c.x, p.y - c.y);
      expect(r).toBeLessThan(R + 0.6);
      expect(r).toBeGreaterThan(R - 10.8);
    }
    const b = box(s);
    expect(b.y0).toBeGreaterThan(-1); // the middle is the lowest point
    expect(b.y1).toBeGreaterThan(5); // the ends curl up
    // first letter on the left: the 'A' is left of the 'T' at the end
    const left = s.filter((x) => shapeBox(x).x1 < 0), right = s.filter((x) => shapeBox(x).x0 > 0);
    expect(left.length).toBeGreaterThan(0);
    expect(right.length).toBeGreaterThan(0);
  });

  it('the length along the arc matches the straight length (spacing kept)', () => {
    const straight = box(textOutlines(mont, { ...base, text: 'MMMM' }));
    const R = 40;
    const arched = textOutlines(mont, { ...base, text: 'MMMM', arc: R, arcSide: 'top' });
    // angle the letters span at the baseline ≈ straight width / R
    const angs = pts(arched).filter((p) => Math.hypot(p.x, p.y + R) < R + 0.5).map((p) => Math.atan2(p.x, p.y + R));
    expect(Math.max(...angs) - Math.min(...angs)).toBeCloseTo((straight.x1 - straight.x0) / R, 1);
  });

  it('radius 0 is straight text', () => {
    expect(textOutlines(mont, { ...base, arc: 0 })).toEqual(textOutlines(mont, base));
  });
});
