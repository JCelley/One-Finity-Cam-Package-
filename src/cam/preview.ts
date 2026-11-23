import type { Move } from './toolpath';

/** segment kinds for colouring the toolpath preview */
export const SEG_RAPID = 0, SEG_CUT = 1, SEG_PLUNGE = 2;

export interface PreviewPath {
  /** 6 floats per segment: x0 y0 z0 x1 y1 z1 (work coordinates, mm) */
  pos: Float32Array;
  /** one kind per segment */
  kind: Uint8Array;
  /** where the tool ends up (the next operation starts here) */
  end: { x: number; y: number; z: number };
}

/** line segments of a move list (arcs split into short chords) for drawing */
export function previewOf(moves: Move[], start: { x: number; y: number; z: number }): PreviewPath {
  const pos: number[] = [];
  const kind: number[] = [];
  let c = { ...start };
  const seg = (a: typeof c, b: typeof c, k: number) => {
    if (a.x === b.x && a.y === b.y && a.z === b.z) return;
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    kind.push(k);
  };
  for (const m of moves) {
    if (m.kind === 'dwell' || m.kind === 'comment') continue;
    const n = { x: m.x ?? c.x, y: m.y ?? c.y, z: m.z ?? c.z };
    if (m.kind === 'arc') {
      const cx = c.x + m.i, cy = c.y + m.j, r = Math.hypot(m.i, m.j);
      const a0 = Math.atan2(c.y - cy, c.x - cx), a1 = Math.atan2(n.y - cy, n.x - cx);
      let sw = m.cw ? a0 - a1 : a1 - a0;
      while (sw <= 1e-12) sw += 2 * Math.PI;
      const steps = Math.max(4, Math.ceil((sw * r) / 0.5));
      let p = c;
      for (let k = 1; k <= steps; k++) {
        const a = a0 + (m.cw ? -1 : 1) * (sw * k) / steps;
        const q = k === steps ? n : { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), z: c.z + ((n.z - c.z) * k) / steps };
        seg(p, q, m.rate === 'plunge' ? SEG_PLUNGE : SEG_CUT);
        p = q;
      }
    } else seg(c, n, m.kind === 'rapid' ? SEG_RAPID : m.rate === 'plunge' ? SEG_PLUNGE : SEG_CUT);
    c = n;
  }
  return { pos: Float32Array.from(pos), kind: Uint8Array.from(kind), end: c };
}
