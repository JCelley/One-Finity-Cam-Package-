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
