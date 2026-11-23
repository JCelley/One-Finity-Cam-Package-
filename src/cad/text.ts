import type { Font } from 'opentype.js';
import type { Pt, Shape } from './geom';
import { unionNonZero, type Xform } from './ops';
import { pathDataShapes } from './svg';

/**
 * Text → closed outlines (mm, Y up), ready for V-carving, pocketing or profiling.
 * `height` is the height of the capital letters, the way sign makers size lettering.
 */
export interface TextOpts {
  text: string;
  /** cap height, mm */
  height: number;
  /** extra space between letters, mm (negative tightens) */
  spacing: number;
  /** distance between baselines as a multiple of the cap height */
  lineSpacing: number;
  align: 'left' | 'center' | 'right';
  /** where the first line's baseline starts (left), middles (center) or ends (right) */
  at: Pt;
  /** degrees, counter-clockwise */
  angle: number;
  /**
   * Bend the baseline round a circle of this radius (mm); 0 or absent = straight. Each letter is
   * placed upright to the curve; spacing is measured along the baseline.
   */
  arc?: number;
  /** 'top': over the top of the circle, like an arch; 'bottom': under it, like a smile */
  arcSide?: 'top' | 'bottom';
}

export const TEXT_DEFAULTS: Omit<TextOpts, 'text' | 'at'> = { height: 25.4, spacing: 0, lineSpacing: 1.6, align: 'left', angle: 0, arc: 0, arcSide: 'top' };

/** n ∘ m: apply m first */
const compose = (n: Xform, m: Xform): Xform => ({
  a: n.a * m.a + n.c * m.b,
  b: n.b * m.a + n.d * m.b,
  c: n.a * m.c + n.c * m.d,
  d: n.b * m.c + n.d * m.d,
  e: n.a * m.e + n.c * m.f + n.e,
  f: n.b * m.e + n.d * m.f + n.f,
});

/**
 * Where a letter goes, in the text's own frame (baseline along +X from the anchor, Y up): its
 * baseline middle at distance `s` along the line, on line `dy` (≤ 0 for lines below the first).
 * Straight: a plain shift. On an arc: round the circle's centre, turned square to the curve.
 */
function placeOnLine(s: number, dy: number, o: TextOpts): { p: Pt; turn: number } {
  const R = o.arc ?? 0;
  if (!(R > 0)) return { p: { x: s, y: dy }, turn: 0 };
  if (o.arcSide === 'bottom') {
    // centre above the baseline; lines further down sit on bigger circles
    const r = R - dy, t = s / r;
    return { p: { x: r * Math.sin(t), y: R - r * Math.cos(t) }, turn: t };
  }
  // centre below the baseline; lines further down sit on smaller circles
  const r = R + dy, t = s / Math.max(r, 1e-6);
  return { p: { x: r * Math.sin(t), y: r * Math.cos(t) - R }, turn: -t };
}

/** cap height of a font in font units (OS/2 table, else the height of 'H', else 70 % of the em) */
export function capHeight(font: Font): number {
  const os2 = (font.tables as { os2?: { sCapHeight?: number } }).os2;
  if (os2?.sCapHeight && os2.sCapHeight > 0) return os2.sCapHeight;
  const h = font.charToGlyph('H');
  const bb = h?.getBoundingBox();
  if (bb && bb.y2 > 0) return bb.y2;
  return font.unitsPerEm * 0.7;
}

export function textOutlines(font: Font, o: TextOpts, tol = 0.01): Shape[] {
  const lines = o.text.replace(/\r/g, '').split('\n');
  if (!lines.some((l) => l.trim())) return [];
  const fontSize = (o.height * font.unitsPerEm) / capHeight(font);
  const scale = fontSize / font.unitsPerEm;
  const rad = (o.angle * Math.PI) / 180, cs = Math.cos(rad), sn = Math.sin(rad);
  // the text's own frame → the drawing: turn by the angle, move to the anchor
  const frame: Xform = { a: cs, b: sn, c: -sn, d: cs, e: o.at.x, f: o.at.y };
  const raw: Shape[] = [];
  lines.forEach((line, li) => {
    const glyphs = font.stringToGlyphs(line);
    // lay the line out: advance widths, kerning, extra spacing
    const xs: number[] = [];
    let x = 0;
    glyphs.forEach((g, i) => {
      xs.push(x);
      x += (g.advanceWidth ?? 0) * scale + o.spacing;
      if (i + 1 < glyphs.length) x += font.getKerningValue(g, glyphs[i + 1]) * scale;
    });
    const width = glyphs.length ? x - o.spacing : 0;
    const dx = o.align === 'left' ? 0 : o.align === 'center' ? -width / 2 : -width;
    const dy = -li * o.lineSpacing * o.height;
    glyphs.forEach((g, i) => {
      // glyph paths come Y-down (screen); flip, place on the line, rotate, move to `at`
      const d = g.getPath(0, 0, fontSize).toPathData(4);
      if (!d) return;
      // glyph frame (Y down, pen at 0) → about its baseline middle, Y up → placed on the line
      const half = ((g.advanceWidth ?? 0) * scale) / 2;
      const { p, turn } = placeOnLine(xs[i] + dx + half, dy, o);
      const ct = Math.cos(turn), st = Math.sin(turn);
      const local: Xform = { a: ct, b: st, c: st, d: -ct, e: p.x - half * ct, f: p.y - half * st };
      const m = compose(frame, local);
      raw.push(...pathDataShapes(d, m, tol).filter((s) => s.kind === 'poly' && s.closed));
    });
  });
  return unionNonZero(raw, tol);
}
