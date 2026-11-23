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
}

export const TEXT_DEFAULTS: Omit<TextOpts, 'text' | 'at'> = { height: 25.4, spacing: 0, lineSpacing: 1.6, align: 'left', angle: 0 };

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
      const ox = xs[i] + dx, oy = dy;
      const m: Xform = { a: cs, b: sn, c: sn, d: -cs, e: o.at.x + ox * cs - oy * sn, f: o.at.y + ox * sn + oy * cs };
      raw.push(...pathDataShapes(d, m, tol).filter((s) => s.kind === 'poly' && s.closed));
    });
  });
  return unionNonZero(raw, tol);
}
