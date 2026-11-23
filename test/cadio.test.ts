import { describe, it, expect } from 'vitest';
import { parseDxf, writeDxf } from '../src/cad/dxf';
import { parseSvg, writeSvg } from '../src/cad/svg';
import { flatten, shapeBox, shapeLength, type Shape } from '../src/cad/geom';
import { regionArea } from '../src/cad/ops';

const slot: Shape = { kind: 'poly', closed: true, pts: [{ x: 0, y: 0 }, { x: 20, y: 0, b: 1 }, { x: 20, y: 10 }, { x: 0, y: 10, b: 1 }] };
const items: { shape: Shape; layer: string }[] = [
  { shape: { kind: 'line', a: { x: 0, y: 0 }, b: { x: 50, y: 25 } }, layer: 'Cut' },
  { shape: { kind: 'circle', c: { x: 10, y: 10 }, r: 4 }, layer: 'Cut' },
  { shape: { kind: 'arc', c: { x: 30, y: 30 }, r: 5, a0: 0, a1: Math.PI / 2 }, layer: 'Engrave' },
  { shape: slot, layer: 'Engrave' },
];

const sameGeometry = (a: Shape, b: Shape) => {
  expect(b.kind).toBe(a.kind);
  expect(shapeLength(b)).toBeCloseTo(shapeLength(a), 3);
  const ba = shapeBox(a), bb = shapeBox(b);
  for (const k of ['x0', 'y0', 'x1', 'y1'] as const) expect(bb[k]).toBeCloseTo(ba[k], 3);
};

describe('DXF', () => {
  it('round-trips lines, circles, arcs and bulged polylines with layers', () => {
    const r = parseDxf(writeDxf(items));
    expect(r.units).toBe('mm');
    expect(r.layers.sort()).toEqual(['Cut', 'Engrave']);
    expect(r.shapes).toHaveLength(4);
    r.shapes.forEach((s, i) => sameGeometry(items[i].shape, s.shape));
    expect(regionArea([r.shapes[3].shape], 0.001)).toBeCloseTo(200 + Math.PI * 25, 1);
  });

  it('inch export scales and says so', () => {
    const r = parseDxf(writeDxf([items[1]], 'in'));
    expect(r.units).toBe('in');
    expect(r.toMm).toBe(25.4);
    expect((r.shapes[0].shape as Extract<Shape, { kind: 'circle' }>).r * r.toMm).toBeCloseTo(4, 4);
  });

  const dxf = (ents: string, extra = '') =>
    ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '1', '0', 'ENDSEC', extra, '0', 'SECTION', '2', 'ENTITIES', ents, '0', 'ENDSEC', '0', 'EOF'].filter(Boolean).join('\n');

  it('reads LWPOLYLINE with bulges, mirrored (extrusion −Z) arcs, and skips text', () => {
    const lw = ['0', 'LWPOLYLINE', '8', 'A', '90', '2', '70', '1', '10', '0', '20', '0', '42', '1', '10', '10', '20', '0', '42', '1'].join('\n');
    const arc = ['0', 'ARC', '8', 'B', '10', '5', '20', '0', '40', '5', '50', '0', '51', '90', '230', '-1'].join('\n');
    const txt = ['0', 'TEXT', '8', 'B', '10', '0', '20', '0', '1', 'hi'].join('\n');
    const r = parseDxf(dxf([lw, arc, txt].join('\n')));
    expect(r.units).toBe('in');
    expect(r.skipped).toEqual({ TEXT: 1 });
    const circle = r.shapes[0].shape;
    expect(regionArea([circle], 0.001)).toBeCloseTo(Math.PI * 25, 1);
    // OCS arc at (5,0) from 0° to 90° is world (−5,0) from 90° to 180°
    const a = r.shapes[1].shape as Extract<Shape, { kind: 'arc' }>;
    expect(a.c.x).toBeCloseTo(-5);
    expect(a.a0).toBeCloseTo(Math.PI / 2);
    expect(a.a1).toBeCloseTo(Math.PI);
  });

  it('expands block inserts with rotation and scale', () => {
    const blocks = ['0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '8', '0', '2', 'SQ', '70', '0', '10', '0', '20', '0', '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '10', '21', '0', '0', 'ENDBLK', '0', 'ENDSEC'].join('\n');
    const ins = ['0', 'INSERT', '8', 'Parts', '2', 'SQ', '10', '100', '20', '50', '41', '2', '42', '2', '50', '90'].join('\n');
    const r = parseDxf(dxf(ins, blocks));
    const l = r.shapes[0];
    expect(l.layer).toBe('Parts');
    const s = l.shape as Extract<Shape, { kind: 'line' }>;
    expect(s.a.x).toBeCloseTo(100);
    expect(s.b.x).toBeCloseTo(100);
    expect(s.b.y).toBeCloseTo(70);
  });

  it('flattens a spline through its ends', () => {
    // clamped cubic with 4 control points = a Bézier
    const sp = ['0', 'SPLINE', '8', '0', '71', '3', ...[0, 0, 0, 0, 1, 1, 1, 1].flatMap((k) => ['40', String(k)]), ...[[0, 0], [0, 10], [10, 10], [10, 0]].flatMap(([x, y]) => ['10', String(x), '20', String(y)])].join('\n');
    const r = parseDxf(dxf(sp));
    const pts = flatten(r.shapes[0].shape).pts;
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1].x).toBeCloseTo(10);
    expect(Math.max(...pts.map((p) => p.y))).toBeCloseTo(7.5, 1);
  });

  it('refuses non-DXF text', () => {
    expect(() => parseDxf('hello\nworld')).toThrow(/DXF/);
  });
});

describe('SVG', () => {
  it('round-trips through its own export (Y flipped back, arcs kept as arcs)', () => {
    const r = parseSvg(writeSvg(items, 0));
    expect(r.shapes).toHaveLength(4);
    // export moves the drawing so its box starts at 0,0; compare sizes and lengths
    const box = (ss: Shape[]) => ss.reduce((b, s) => shapeBox(s, b), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    const a = box(items.map((i) => i.shape)), b = box(r.shapes.map((s) => s.shape));
    expect(b.x1 - b.x0).toBeCloseTo(a.x1 - a.x0, 3);
    expect(b.y1 - b.y0).toBeCloseTo(a.y1 - a.y0, 3);
    expect(r.shapes[1].shape.kind).toBe('circle');
    expect(shapeLength(r.shapes[2].shape)).toBeCloseTo(shapeLength(items[2].shape), 3);
    expect(regionArea([r.shapes[3].shape], 0.001)).toBeCloseTo(200 + Math.PI * 25, 1);
    // the quarter arc's centre: same place relative to the box
    const sh = r.shapes[2].shape as Extract<Shape, { kind: 'poly' }>;
    const mid = flatten(sh).pts;
    expect(Math.max(...mid.map((p) => p.y)) - b.y0).toBeCloseTo(35 - a.y0, 3);
  });

  it('uses document units: 100 × 50 mm with a viewBox in other units', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 1000 500"><rect x="0" y="0" width="1000" height="100"/></svg>`;
    const r = parseSvg(svg);
    expect(r.widthMm).toBe(100);
    const b = shapeBox(r.shapes[0].shape);
    // top strip of the picture → near the top of the drawing (y 40..50)
    expect(b.y0).toBeCloseTo(40);
    expect(b.y1).toBeCloseTo(50);
    expect(b.x1).toBeCloseTo(100);
  });

  it('unitless sizes are 96 px per inch; transforms and nested groups apply', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><g transform="translate(48,48)"><g transform="scale(2)"><circle r="12"/></g></g></svg>`;
    const r = parseSvg(svg);
    const c = r.shapes[0].shape as Extract<Shape, { kind: 'circle' }>;
    expect(c.kind).toBe('circle');
    expect(c.r).toBeCloseTo(24 * (25.4 / 96));
    expect(c.c.x).toBeCloseTo(12.7);
    expect(c.c.y).toBeCloseTo(12.7);
  });

  it('paths: relative commands, Béziers, compact arc flags, close', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
      <path d="M10 10 h20 v20 h-20 z M50,50 c0,-10 20,-10 20,0 s-20,10 -20,0z M10 80a5 5 0 1010 0a5 5 0 10-10 0z"/></svg>`;
    const r = parseSvg(svg);
    expect(r.shapes).toHaveLength(3);
    expect(Math.abs(regionArea([r.shapes[0].shape]))).toBeCloseTo(400, 3);
    expect(Math.abs(regionArea([r.shapes[2].shape], 0.001))).toBeCloseTo(Math.PI * 25, 1);
    const p = r.shapes[2].shape as Extract<Shape, { kind: 'poly' }>;
    expect(p.pts.every((v, i) => i === p.pts.length - 1 || v.b !== undefined || p.pts.length <= 3)).toBe(true);
  });

  it('a skewed circle is flattened, hidden things are skipped', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><circle cx="50" cy="50" r="10" transform="skewX(20)"/><rect width="5" height="5" style="display:none"/><text>x</text></svg>`;
    const r = parseSvg(svg);
    expect(r.shapes).toHaveLength(1);
    expect(r.shapes[0].shape.kind).toBe('poly');
    expect(r.skipped).toEqual({ text: 1 });
  });
});
