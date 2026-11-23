import { describe, it, expect } from 'vitest';
import { arc3, bulgeArc, flatten, intersect, prims, shapeBox, shapeDistance, shapeLength, signedArea, type Shape } from '../src/cad/geom';
import { emptyDoc, entity, History, joinShapes, readDoc } from '../src/cad/doc';
import { findSnap } from '../src/cad/snap';
import { booleanShapes, mirrorAcross, offsetShapes, regionArea, rotateAbout, scaleAbout, transformShape, translate } from '../src/cad/ops';

const rect = (x: number, y: number, w: number, h: number): Shape => ({ kind: 'poly', closed: true, pts: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] });
const close = (a: { x: number; y: number }, x: number, y: number, d = 6) => {
  expect(a.x).toBeCloseTo(x, d);
  expect(a.y).toBeCloseTo(y, d);
};

describe('geometry', () => {
  it('bulge 1 is a CCW half circle centred on the chord', () => {
    const a = bulgeArc({ x: 0, y: 0 }, { x: 10, y: 0 }, 1);
    close(a.c, 5, 0);
    expect(a.r).toBeCloseTo(5);
    expect(a.sweep).toBeCloseTo(Math.PI);
    // CCW from (0,0) to (10,0) goes below the chord
    const pts = flatten({ kind: 'poly', closed: false, pts: [{ x: 0, y: 0, b: 1 }, { x: 10, y: 0 }] }).pts;
    expect(Math.min(...pts.map((p) => p.y))).toBeCloseTo(-5, 1);
    close(pts[pts.length - 1], 10, 0);
  });

  it('a CW bulge flattens in polyline order', () => {
    const pts = flatten({ kind: 'poly', closed: false, pts: [{ x: 0, y: 0, b: -1 }, { x: 10, y: 0 }] }).pts;
    close(pts[0], 0, 0);
    close(pts[pts.length - 1], 10, 0);
    expect(Math.max(...pts.map((p) => p.y))).toBeCloseTo(5, 1);
  });

  it('boxes include arc extremes, lengths and distances', () => {
    const arc: Shape = { kind: 'arc', c: { x: 0, y: 0 }, r: 10, a0: -Math.PI / 4, a1: Math.PI / 4 };
    const b = shapeBox(arc);
    expect(b.x1).toBeCloseTo(10);
    expect(b.y1).toBeCloseTo(10 * Math.SQRT1_2);
    expect(shapeLength({ kind: 'circle', c: { x: 0, y: 0 }, r: 1 })).toBeCloseTo(2 * Math.PI);
    expect(shapeDistance(rect(0, 0, 10, 10), { x: 5, y: 13 })).toBeCloseTo(3);
  });

  it('intersections: line–line, line–circle, circle–circle, respecting arc extents', () => {
    expect(intersect({ t: 'seg', a: { x: 0, y: 0 }, b: { x: 10, y: 10 } }, { t: 'seg', a: { x: 0, y: 10 }, b: { x: 10, y: 0 } })).toHaveLength(1);
    const circ = prims({ kind: 'circle', c: { x: 0, y: 0 }, r: 5 })[0];
    expect(intersect({ t: 'seg', a: { x: -10, y: 0 }, b: { x: 10, y: 0 } }, circ)).toHaveLength(2);
    const c2 = prims({ kind: 'circle', c: { x: 8, y: 0 }, r: 5 })[0];
    const xs = intersect(circ, c2);
    expect(xs).toHaveLength(2);
    close(xs[0], 4, 3);
    // upper half arc only meets the line y = -1 nowhere
    const upper = prims({ kind: 'arc', c: { x: 0, y: 0 }, r: 5, a0: 0, a1: Math.PI })[0];
    expect(intersect({ t: 'seg', a: { x: -10, y: -1 }, b: { x: 10, y: -1 } }, upper)).toHaveLength(0);
  });

  it('3-point arc goes through the middle point', () => {
    const a = arc3({ x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 })!;
    close(a.c, 0, 0);
    expect(a.a0).toBeCloseTo(0);
    expect(a.a1).toBeCloseTo(Math.PI);
    const b = arc3({ x: -10, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 0 })!;
    expect(b.a0).toBeCloseTo(0); // stored CCW: from the right end over the top
    expect(arc3({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 })).toBeNull();
  });
});

describe('document', () => {
  it('undo / redo by snapshots', () => {
    const d = emptyDoc();
    const h = new History(d);
    d.entities.push(entity({ kind: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }));
    expect(h.commit(d)).toBe(true);
    expect(h.commit(d)).toBe(false); // nothing changed
    d.entities.push(entity({ kind: 'circle', c: { x: 0, y: 0 }, r: 3 }));
    h.commit(d);
    expect(h.undo()!.entities).toHaveLength(1);
    expect(h.undo()!.entities).toHaveLength(0);
    expect(h.undo()).toBeNull();
    expect(h.redo()!.entities).toHaveLength(1);
    expect(h.canRedo).toBe(true);
  });

  it('joins loose lines and arcs into a closed outline, in any direction', () => {
    // 20 × 10 slot: two lines and two half circles, one line backwards
    const items = [
      entity({ kind: 'line', a: { x: 0, y: 0 }, b: { x: 20, y: 0 } }),
      entity({ kind: 'arc', c: { x: 20, y: 5 }, r: 5, a0: -Math.PI / 2, a1: Math.PI / 2 }),
      entity({ kind: 'line', a: { x: 0, y: 10 }, b: { x: 20, y: 10 } }),
      entity({ kind: 'arc', c: { x: 0, y: 5 }, r: 5, a0: Math.PI / 2, a1: (3 * Math.PI) / 2 }),
      entity({ kind: 'line', a: { x: 100, y: 0 }, b: { x: 101, y: 0 } }),
    ];
    const { joined, used } = joinShapes(items);
    expect(joined).toHaveLength(1);
    expect(used.size).toBe(4);
    const j = joined[0] as Extract<Shape, { kind: 'poly' }>;
    expect(j.closed).toBe(true);
    expect(j.pts).toHaveLength(4);
    expect(Math.abs(regionArea([j], 0.001))).toBeCloseTo(20 * 10 + Math.PI * 25, 1);
  });

  it('reads drawings from job files', () => {
    expect(readDoc(null).entities).toEqual([]);
    expect(() => readDoc({ version: 1, layers: [], entities: [{ kind: 'blob' }] })).toThrow(/unknown/);
  });
});

describe('snapping', () => {
  const shapes: Shape[] = [rect(0, 0, 10, 10), { kind: 'circle', c: { x: 20, y: 5 }, r: 5 }, { kind: 'line', a: { x: -5, y: 5 }, b: { x: 5, y: 5 } }];
  const o = { radius: 1, grid: 5, kinds: {} };
  it('prefers ends, then intersections, centres, midpoints', () => {
    expect(findSnap(shapes, { x: 9.6, y: 0.3 }, o)).toMatchObject({ kind: 'end', p: { x: 10, y: 0 } });
    expect(findSnap(shapes, { x: 0.2, y: 4.8 }, o)!.kind).toBe('intersection');
    expect(findSnap(shapes, { x: 20.3, y: 5.2 }, o)).toMatchObject({ kind: 'center', p: { x: 20, y: 5 } });
    expect(findSnap(shapes, { x: 5.2, y: 9.9 }, o)).toMatchObject({ kind: 'mid' });
  });
  it('falls back to the grid, or nothing', () => {
    expect(findSnap(shapes, { x: 41.2, y: 38.9 }, o)).toEqual({ kind: 'grid', p: { x: 40, y: 40 } });
    expect(findSnap(shapes, { x: 41.2, y: 38.9 }, { ...o, grid: 0 })).toBeNull();
  });
});

describe('transforms', () => {
  it('rotate, scale, move keep arcs as arcs', () => {
    const arc: Shape = { kind: 'arc', c: { x: 10, y: 0 }, r: 2, a0: 0, a1: Math.PI / 2 };
    const r = transformShape(arc, rotateAbout({ x: 0, y: 0 }, Math.PI / 2));
    close(r.c, 0, 10);
    expect(r.a0).toBeCloseTo(Math.PI / 2);
    expect(r.a1).toBeCloseTo(Math.PI);
    const s = transformShape(arc, scaleAbout({ x: 0, y: 0 }, 2));
    expect(s.r).toBeCloseTo(4);
    close(transformShape(arc, translate(1, 2)).c, 11, 2);
  });
  it('a mirror keeps arcs CCW and flips bulges', () => {
    const arc: Shape = { kind: 'arc', c: { x: 0, y: 0 }, r: 5, a0: 0, a1: Math.PI / 2 }; // first quadrant
    const m = transformShape(arc, mirrorAcross({ x: 0, y: 0 }, Math.PI / 2)); // across the Y axis
    // now the second quadrant, still CCW: from 90° to 180°
    expect(m.a0).toBeCloseTo(Math.PI / 2);
    expect(m.a1).toBeCloseTo(Math.PI);
    const p = transformShape({ kind: 'poly', closed: false, pts: [{ x: 0, y: 0, b: 0.5 }, { x: 10, y: 0 }] } as Shape, mirrorAcross({ x: 0, y: 0 }, 0));
    expect((p as Extract<Shape, { kind: 'poly' }>).pts[0].b).toBe(-0.5);
  });
});

describe('offsets and booleans', () => {
  it('union, difference, intersection of two squares', () => {
    const a = [rect(0, 0, 10, 10)], b = [rect(5, 5, 10, 10)];
    expect(regionArea(booleanShapes('union', a, b))).toBeCloseTo(175, 3);
    expect(regionArea(booleanShapes('difference', a, b))).toBeCloseTo(75, 3);
    expect(regionArea(booleanShapes('intersection', a, b))).toBeCloseTo(25, 3);
  });
  it('offsets out with round corners and in, nested outlines become islands', () => {
    const out = offsetShapes([rect(0, 0, 10, 10)], 1, 0.001);
    expect(regionArea(out, 0.001)).toBeCloseTo(100 + 40 + Math.PI, 2);
    const inn = offsetShapes([rect(0, 0, 10, 10)], -1);
    expect(regionArea(inn)).toBeCloseTo(64, 3);
    // a frame: 20 × 20 with a 10 × 10 hole, offset 1 mm into the material: 18² minus the hole grown by 1 mm (round corners)
    const frame = offsetShapes([rect(0, 0, 20, 20), rect(5, 5, 10, 10)], -1);
    expect(regionArea(frame)).toBeCloseTo(324 - (100 + 40 + Math.PI), 1);
    expect(signedArea(flatten(out[0]).pts)).toBeGreaterThan(0);
  });
});
