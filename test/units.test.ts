import { describe, it, expect } from 'vitest';
import { fmtLen, parseAngle, parseLen } from '../src/ui/units';

describe('typed lengths', () => {
  it('decimals in the display units', () => {
    expect(parseLen('2', 'in')).toBeCloseTo(50.8);
    expect(parseLen('2', 'mm')).toBe(2);
    expect(parseLen('.5', 'in')).toBeCloseTo(12.7);
    expect(parseLen('-1.25', 'mm')).toBe(-1.25);
  });
  it('fractions and mixed numbers', () => {
    expect(parseLen('1/4', 'in')).toBeCloseTo(6.35);
    expect(parseLen('1 1/2', 'in')).toBeCloseTo(38.1);
    expect(parseLen('-3/8', 'in')).toBeCloseTo(-9.525);
    expect(parseLen('1/0', 'in')).toBeNull();
  });
  it('a unit suffix overrides the display units', () => {
    expect(parseLen('6mm', 'in')).toBe(6);
    expect(parseLen('1/4"', 'mm')).toBeCloseTo(6.35);
    expect(parseLen('0.5 in', 'mm')).toBeCloseTo(12.7);
  });
  it('rejects junk', () => {
    expect(parseLen('', 'mm')).toBeNull();
    expect(parseLen('abc', 'mm')).toBeNull();
    expect(parseLen('1,2', 'mm')).toBeNull();
  });
  it('formats and parses angles', () => {
    expect(fmtLen(25.4, 'in')).toBe('1');
    expect(fmtLen(1 / 3, 'mm')).toBe('0.333');
    expect(parseAngle('90')).toBeCloseTo(Math.PI / 2);
    expect(parseAngle('45°')).toBeCloseTo(Math.PI / 4);
    expect(parseAngle('x')).toBeNull();
  });
});
