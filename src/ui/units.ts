/** display units shared by the whole UI (stored per browser) */
export type Units = 'mm' | 'in';

const KEY = 'ofc-units';
let current: Units = 'in';
try {
  if (localStorage.getItem(KEY) === 'mm') current = 'mm';
} catch {
  /* storage blocked */
}
const listeners = new Set<(u: Units) => void>();

export const getUnits = () => current;
export function setUnits(u: Units) {
  current = u;
  try {
    localStorage.setItem(KEY, u);
  } catch {
    /* storage blocked */
  }
  for (const f of listeners) f(u);
}
export const onUnits = (f: (u: Units) => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** mm → text in the display units, trailing zeros trimmed */
export function fmtLen(mm: number, u: Units = current, places?: number): string {
  const v = u === 'in' ? mm / 25.4 : mm;
  const s = v.toFixed(places ?? (u === 'in' ? 4 : 3)).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/**
 * A length typed by the user → mm. Accepts decimals, fractions ("1/4", "1 1/2", "-3/8") and a unit
 * suffix that overrides the display units ("6mm", "0.25in", '1/4"'). Null if it isn't a length.
 */
export function parseLen(text: string, u: Units = current): number | null {
  let s = text.trim().toLowerCase();
  let unit: Units = u;
  const m = /(mm|in|")$/.exec(s);
  if (m) {
    unit = m[1] === 'mm' ? 'mm' : 'in';
    s = s.slice(0, -m[1].length).trim();
  }
  let v: number;
  const frac = /^([-+])?(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (frac) {
    const den = +frac[4];
    if (!den) return null;
    v = (frac[2] ? +frac[2] : 0) + +frac[3] / den;
    if (frac[1] === '-') v = -v;
  } else if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(s)) v = parseFloat(s);
  else return null;
  return unit === 'in' ? v * 25.4 : v;
}

/** an angle typed in degrees → radians, or null */
export function parseAngle(text: string): number | null {
  const s = text.trim().replace(/°$/, '');
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(s) ? (parseFloat(s) * Math.PI) / 180 : null;
}
