import type { MachGrid } from './heightfield';

/** Maps a flat-part point (x, y in the picture plane, h = height above the back) to 3D. */
export type PointMap = (x: number, y: number, h: number) => [number, number, number];

/**
 * Indexed, closed triangle mesh (mm). The first `topTris` triangles are the picture / relief
 * surface, and `h` holds each vertex's height above the back (−1 for vertices not on that
 * surface), so the preview can shade the picture side separately from walls and back.
 */
export interface Mesh {
  pos: Float32Array;
  idx: Uint32Array;
  h: Float32Array;
  topTris: number;
}

/** Growable mesh builder */
class MB {
  pos: number[] = [];
  h: number[] = [];
  idx: number[] = [];
  vert(p: [number, number, number], h = -1): number {
    this.pos.push(p[0], p[1], p[2]);
    this.h.push(h);
    return this.h.length - 1;
  }
  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }
  done(topTris: number): Mesh {
    return { pos: Float32Array.from(this.pos), idx: Uint32Array.from(this.idx), h: Float32Array.from(this.h), topTris };
  }
}

const gridX = (g: MachGrid) => (i: number) => (i === g.nx - 1 ? g.widthMm : i * g.dx);
const gridY =(g: MachGrid) => (j: number) => (j === g.ny - 1 ? g.heightMm : j * g.dy);

/**
 * Closed mesh of a full rectangular heightfield: top = 2 triangles per grid cell, 4 side walls
 * down to the back (h = 0), back = one strip per grid column (only the edge columns carry every
 * row, so the back stays a valid closed surface when bent by `map`). Outward-facing triangles.
 */
export function heightfieldMesh(g: MachGrid, map?: PointMap): Mesh {
  const { nx, ny, z } = g;
  const X = gridX(g), Y = gridY(g);
  const P: PointMap = map ?? ((x, y, h) => [x, y, h]);
  const m = new MB();
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) m.vert(P(X(i), Y(j), z[j * nx + i]), z[j * nx + i]);
  const T = (i: number, j: number) => j * nx + i;
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) m.quad(T(i, j), T(i + 1, j), T(i + 1, j + 1), T(i, j + 1));
  const topTris = m.idx.length / 3;

  // back vertices: only on the boundary
  const B = new Int32Array(nx * ny).fill(-1);
  const bot = (i: number, j: number) => {
    const k = j * nx + i;
    if (B[k] < 0) B[k] = m.vert(P(X(i), Y(j), 0));
    return B[k];
  };
  // boundary loop, counter-clockwise seen from the top side: bottom edge → right → top → left
  const loop: [number, number][] = [];
  for (let i = 0; i < nx - 1; i++) loop.push([i, 0]);
  for (let j = 0; j < ny - 1; j++) loop.push([nx - 1, j]);
  for (let i = nx - 1; i > 0; i--) loop.push([i, ny - 1]);
  for (let j = ny - 1; j > 0; j--) loop.push([0, j]);
  for (let k = 0; k < loop.length; k++) {
    const [ai, aj] = loop[k];
    const [bi, bj] = loop[(k + 1) % loop.length];
    m.quad(bot(ai, aj), bot(bi, bj), T(bi, bj), T(ai, aj));
  }
  // back (normal −h): zip each column strip between its left and right row lists
  const rowsOf = (i: number) => (i === 0 || i === nx - 1 ? Array.from({ length: ny }, (_, j) => j) : [0, ny - 1]);
  for (let i = 0; i < nx - 1; i++) {
    const A = rowsOf(i), Bc = rowsOf(i + 1);
    let pa = 0, pb = 0;
    while (pa < A.length - 1 || pb < Bc.length - 1) {
      const advA = pb >= Bc.length - 1 || (pa < A.length - 1 && A[pa + 1] <= Bc[pb + 1]);
      if (advA) {
        m.tri(bot(i, A[pa]), bot(i, A[pa + 1]), bot(i + 1, Bc[pb]));
        pa++;
      } else {
        m.tri(bot(i, A[pa]), bot(i + 1, Bc[pb + 1]), bot(i + 1, Bc[pb]));
        pb++;
      }
    }
  }
  return m.done(topTris);
}

/** Binary STL (mm, outward-facing CCW triangles). */
export function meshToStl(m: Mesh): Uint8Array {
  const { pos, idx } = m;
  const triCount = idx.length / 3;
  const buf = new ArrayBuffer(84 + 50 * triCount);
  const dv = new DataView(buf);
  const headerText = 'Onefinity CAM binary STL (mm)';
  for (let i = 0; i < headerText.length; i++) dv.setUint8(i, headerText.charCodeAt(i));
  dv.setUint32(80, triCount, true);
  let off = 84;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true);
    for (let k = 0; k < 3; k++) {
      const p = idx[t + k] * 3;
      dv.setFloat32(off + 12 + 12 * k, pos[p], true);
      dv.setFloat32(off + 16 + 12 * k, pos[p + 1], true);
      dv.setFloat32(off + 20 + 12 * k, pos[p + 2], true);
    }
    dv.setUint16(off + 48, 0, true);
    off += 50;
  }
  return new Uint8Array(buf);
}

/** Every-other-row/column subsample of a grid (keeps the last row/column) for a lighter preview. */
