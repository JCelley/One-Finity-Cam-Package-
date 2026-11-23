import type { Box, Pt } from '../../cad/geom';

/**
 * Screen ↔ drawing mapping: `scale` screen px per mm, (ox, oy) = screen position of drawing 0,0.
 * The drawing is Y up, the screen Y down.
 */
export class Viewport {
  scale = 2;
  ox = 60;
  oy = 400;
  toScreen(p: Pt): Pt {
    return { x: this.ox + p.x * this.scale, y: this.oy - p.y * this.scale };
  }
  toWorld(x: number, y: number): Pt {
    return { x: (x - this.ox) / this.scale, y: (this.oy - y) / this.scale };
  }
  /** zoom by factor k keeping the screen point (sx, sy) fixed */
  zoomAt(sx: number, sy: number, k: number) {
    const w = this.toWorld(sx, sy);
    this.scale = Math.min(2000, Math.max(0.02, this.scale * k));
    this.ox = sx - w.x * this.scale;
    this.oy = sy + w.y * this.scale;
  }
  pan(dx: number, dy: number) {
    this.ox += dx;
    this.oy += dy;
  }
  /** fit a drawing box into a w × h screen with a margin */
  fit(b: Box, w: number, h: number, margin = 40) {
    const bw = Math.max(1e-3, b.x1 - b.x0), bh = Math.max(1e-3, b.y1 - b.y0);
    this.scale = Math.min(2000, Math.max(0.02, Math.min((w - 2 * margin) / bw, (h - 2 * margin) / bh)));
    this.ox = w / 2 - ((b.x0 + b.x1) / 2) * this.scale;
    this.oy = h / 2 + ((b.y0 + b.y1) / 2) * this.scale;
  }
}

/** a "nice" grid step (1, 2, 5 × 10ⁿ in the display unit) giving at least `minPx` between lines */
export function gridStep(scale: number, unitMm: number, minPx = 12): number {
  const raw = minPx / scale / unitMm;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p * unitMm;
  return 10 * p * unitMm;
}
