import type { Font } from 'opentype.js';
import type { Pt, Shape } from './geom';
import { unionNonZero, type Xform } from './ops';
import { pathDataShapes } from './svg';
import type { StrokeFont } from './strokeFont';

/** an outline font (opentype.js) or a single-line engraving font */
export type TextFont = Font | StrokeFont;
export const isStroke = (f: TextFont): f is StrokeFont => (f as StrokeFont).kind === 'stroke';

/**
 * Text → closed outlines (mm, Y up), ready for V-carving, pocketing or profiling.
 * `height` is the height of the capital letters, the way sign makers size lettering.
 * With a single-line font the result is the letters' centre lines (mostly open polylines) instead.
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
export function capHeight(font: TextFont): number {
  if (isStroke(font)) return font.cap;
  const os2 = (font.tables as { os2?: { sCapHeight?: number } }).os2;
  if (os2?.sCapHeight && os2.sCapHeight > 0) return os2.sCapHeight;
  const h = font.charToGlyph('H');
  const bb = h?.getBoundingBox();
  if (bb && bb.y2 > 0) return bb.y2;
  return font.unitsPerEm * 0.7;
}

/** one glyph laid out: advance (font units), kerning to the next (font units), path and how to read it */
interface Laid {
  adv: number;
  kern: number;
  /** left and right of the drawn strokes (font units), for single-line fonts */
  ink?: [number, number];
  /** path data and the map from its coordinates to the glyph frame (Y down, at the font size) */
  path: (fontSize: number) => { d: string; pre: Xform };
}

function layoutLine(font: TextFont, line: string): Laid[] {
  if (isStroke(font)) {
    return Array.from(line).map((ch) => {
      const g = font.glyphs.get(ch);
      return {
        adv: g?.adv ?? font.missingAdv,
        kern: 0,
        ink: g?.d ? inkOf(g.d) : undefined,
        // font units, Y up → font size, Y down
        path: (fs) => ({ d: g?.d ?? '', pre: { a: fs / font.unitsPerEm, b: 0, c: 0, d: -fs / font.unitsPerEm, e: 0, f: 0 } }),
      };
    });
  }
  const glyphs = font.stringToGlyphs(line);
  return glyphs.map((g, i) => ({
    adv: g.advanceWidth ?? 0,
    kern: i + 1 < glyphs.length ? font.getKerningValue(g, glyphs[i + 1]) : 0,
    path: (fs) => ({ d: g.getPath(0, 0, fs).toPathData(4), pre: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } }),
  }));
}

/** x range of a path's coordinates (M/L/C with absolute x y pairs) */
function inkOf(d: string): [number, number] | undefined {
  const n = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
  let a = Infinity, b = -Infinity;
  for (let i = 0; i < n.length; i += 2) { a = Math.min(a, n[i]); b = Math.max(b, n[i]); }
  return a <= b ? [a, b] : undefined;
}

/** drops repeated points and strokes that are only a dot */
function cleanStroke(s: Shape, tol: number): Shape | null {
  if (s.kind !== 'poly') return null;
  const pts = s.pts.filter((p, i) => i === 0 || Math.hypot(p.x - s.pts[i - 1].x, p.y - s.pts[i - 1].y) > tol / 10);
  if (pts.length < 2) return null;
  const closed = s.closed || (pts.length > 2 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= tol / 10);
  if (closed && !s.closed) pts.pop();
  return { kind: 'poly', pts: pts.map(({ x, y }) => ({ x, y })), closed };
}

export function textOutlines(font: TextFont, o: TextOpts, tol = 0.01): Shape[] {
  const lines = o.text.replace(/\r/g, '').split('\n');
  if (!lines.some((l) => l.trim())) return [];
  const fontSize = (o.height * font.unitsPerEm) / capHeight(font);
  const scale = fontSize / font.unitsPerEm;
  const rad = (o.angle * Math.PI) / 180, cs = Math.cos(rad), sn = Math.sin(rad);
  // the text's own frame → the drawing: turn by the angle, move to the anchor
  const frame: Xform = { a: cs, b: sn, c: -sn, d: cs, e: o.at.x, f: o.at.y };
  const raw: Shape[] = [];
  lines.forEach((line, li) => {
    const glyphs = layoutLine(font, line);
    // lay the line out: advance widths, kerning, extra spacing
    const xs: number[] = [];
    let x = 0;
    glyphs.forEach((g) => {
      xs.push(x);
      x += g.adv * scale + o.spacing + g.kern * scale;
    });
    let x0 = 0, x1 = glyphs.length ? x - o.spacing : 0;
    // single-line fonts (Hershey) sit off-centre in their advance widths: align by the strokes
    if (isStroke(font)) {
      const ink = glyphs.flatMap((g, i) => (g.ink ? [xs[i] + g.ink[0] * scale, xs[i] + g.ink[1] * scale] : []));
      if (ink.length) [x0, x1] = [Math.min(...ink), Math.max(...ink)];
    }
    const dx = o.align === 'left' ? -x0 : o.align === 'center' ? -(x0 + x1) / 2 : -x1;
    const dy = -li * o.lineSpacing * o.height;
    glyphs.forEach((g, i) => {
      // glyph paths come Y-down (screen); flip, place on the line, rotate, move to `at`
      const { d, pre } = g.path(fontSize);
      if (!d) return;
      // glyph frame (Y down, pen at 0) → about its baseline middle, Y up → placed on the line
      const half = (g.adv * scale) / 2;
      const { p, turn } = placeOnLine(xs[i] + dx + half, dy, o);
      const ct = Math.cos(turn), st = Math.sin(turn);
      const local: Xform = { a: ct, b: st, c: st, d: -ct, e: p.x - half * ct, f: p.y - half * st };
      const m = compose(frame, compose(local, pre));
      const shapes = pathDataShapes(d, m, tol);
      if (isStroke(font)) for (const s of shapes) { const c = cleanStroke(s, tol); if (c) raw.push(c); }
      else raw.push(...shapes.filter((s) => s.kind === 'poly' && s.closed));
    });
  });
  // outlines: overlapping glyph contours merged into regions; strokes stay as they are
  return isStroke(font) ? raw : unionNonZero(raw, tol);
}
