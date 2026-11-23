/**
 * Single-line (stroke) fonts for engraving: the letters are centre lines, not outlines, so a
 * V-bit or a small end mill follows each stroke once. Read from SVG fonts (`<font>` with
 * `<glyph d=…>`), the format the Hershey and EMS engraving fonts are distributed in.
 * Glyph paths are in font units, Y up, the pen at 0 on the baseline.
 */
export interface StrokeGlyph {
  /** advance width, font units */
  adv: number;
  /** path data, font units, Y up ('' for a space) */
  d: string;
}

export interface StrokeFont {
  kind: 'stroke';
  name: string;
  unitsPerEm: number;
  /** height of the capitals, font units (measured from 'H': the files' own cap-height is unreliable) */
  cap: number;
  /** advance of characters the font doesn't have */
  missingAdv: number;
  glyphs: Map<string, StrokeGlyph>;
}

const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = m[3] ?? m[4];
  return out;
};

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e] ?? all),
  );

/** highest Y in a path made of M/L/C/Z commands with absolute coordinates */
function topOf(d: string): number {
  const nums = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
  let top = -Infinity;
  for (let i = 1; i < nums.length; i += 2) top = Math.max(top, nums[i]);
  return top;
}

export function parseSvgFont(xml: string): StrokeFont {
  const fontTag = xml.match(/<font\b[^>]*>/)?.[0];
  if (!fontTag) throw new Error('not an SVG font: no <font> element');
  const face = attrs(xml.match(/<font-face\b[^>]*>/)?.[0] ?? '');
  const defAdv = Number(attrs(fontTag)['horiz-adv-x'] ?? 0);
  const unitsPerEm = Number(face['units-per-em'] ?? 1000);
  const missing = attrs(xml.match(/<missing-glyph\b[^>]*>/)?.[0] ?? '');
  const glyphs = new Map<string, StrokeGlyph>();
  for (const m of xml.matchAll(/<glyph\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (a.unicode === undefined) continue;
    glyphs.set(decode(a.unicode), { adv: Number(a['horiz-adv-x'] ?? defAdv), d: a.d ?? '' });
  }
  const h = glyphs.get('H')?.d;
  const measured = h ? topOf(h) : NaN;
  const cap = measured > 0 ? measured : Number(face['cap-height']) > 0 ? Number(face['cap-height']) : unitsPerEm * 0.7;
  return { kind: 'stroke', name: face['font-family'] ?? 'Single-line font', unitsPerEm, cap, missingAdv: Number(missing['horiz-adv-x'] ?? defAdv), glyphs };
}
