/**
 * Regular heightfield over the part in machine-style coordinates: X right, Y away from you,
 * z = height above the part bottom (mm). Row 0 is the front edge (Y = 0). Used by the 3D raster
 * operations (from an STL or any other surface) and the cutter simulation.
 */
export interface MachGrid {
  nx: number;
  ny: number;
  /** grid spacing in X and Y (mm) */
  dx: number;
  dy: number;
  widthMm: number;
  heightMm: number;
  /** nx * ny heights, row-major */
  z: Float32Array;
  zMin: number;
  zMax: number;
}

/** builds a grid by sampling f(x, y) → height (mm) at spacing ≤ `spacing` */
export function sampleGrid(widthMm: number, heightMm: number, spacing: number, f: (x: number, y: number) => number): MachGrid {
  const nx = Math.max(2, Math.round(widthMm / spacing) + 1);
  const ny = Math.max(2, Math.round(heightMm / spacing) + 1);
  const dx = widthMm / (nx - 1), dy = heightMm / (ny - 1);
  const z = new Float32Array(nx * ny);
  let zMin = Infinity, zMax = -Infinity;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const v = f(i * dx, j * dy);
      z[j * nx + i] = v;
      if (v < zMin) zMin = v;
      if (v > zMax) zMax = v;
    }
  return { nx, ny, dx, dy, widthMm, heightMm, z, zMin, zMax };
}
