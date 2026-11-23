import type { MachGrid } from './heightfield';

/**
 * Top-down Z-buffer of a triangle mesh: the highest surface over each grid point (what a 3-axis
 * tool coming down from above can reach). Grid point (i, j) is at (x0 + i·dx, y0 + j·dy); heights
 * are z − `base`. Points no triangle covers get `empty` (normally 0: the model's bottom).
 * Undercuts are lost by nature: only the top is kept.
 */
export function rasterizeTop(tris: Float32Array, x0: number, y0: number, widthMm: number, heightMm: number, spacing: number, base: number, empty = 0): MachGrid {
  const nx = Math.max(2, Math.round(widthMm / spacing) + 1);
  const ny = Math.max(2, Math.round(heightMm / spacing) + 1);
  const dx = widthMm / (nx - 1), dy = heightMm / (ny - 1);
  const z = new Float32Array(nx * ny).fill(-Infinity);
  const eps = 1e-7;
  for (let t = 0; t < tris.length; t += 9) {
    const ax = tris[t] - x0, ay = tris[t + 1] - y0, az = tris[t + 2] - base;
    const bx = tris[t + 3] - x0, by = tris[t + 4] - y0, bz = tris[t + 5] - base;
    const cx = tris[t + 6] - x0, cy = tris[t + 7] - y0, cz = tris[t + 8] - base;
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-12) continue; // seen edge-on from above (a wall): it adds no top
    const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) / dx - eps)), i1 = Math.min(nx - 1, Math.floor(Math.max(ax, bx, cx) / dx + eps));
    const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) / dy - eps)), j1 = Math.min(ny - 1, Math.floor(Math.max(ay, by, cy) / dy + eps));
    for (let j = j0; j <= j1; j++) {
      const py = j * dy;
      for (let i = i0; i <= i1; i++) {
        const px = i * dx;
        const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
        const w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
        const w2 = 1 - w0 - w1;
        if (w0 < -eps || w1 < -eps || w2 < -eps) continue;
        const h = w0 * az + w1 * bz + w2 * cz;
        const k = j * nx + i;
        if (h > z[k]) z[k] = h;
      }
    }
  }
  let zMin = Infinity, zMax = -Infinity;
  for (let k = 0; k < z.length; k++) {
    if (z[k] === -Infinity) z[k] = empty;
    if (z[k] < zMin) zMin = z[k];
    if (z[k] > zMax) zMax = z[k];
  }
  return { nx, ny, dx, dy, widthMm, heightMm, z, zMin, zMax };
}
