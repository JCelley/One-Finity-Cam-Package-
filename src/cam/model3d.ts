import type { MachGrid } from '../core/heightfield';
import { rasterizeTop } from '../core/rasterize';
import { triBounds } from '../core/stlRead';

/**
 * A 3D model (from an STL) placed on the stock, for the 3D raster operations. The triangles are
 * kept in the job as they came from the file (base64 of little-endian float32 corners, 9 per
 * triangle), and the placement says how they sit on the board:
 * which of the model's axes points up, a turn about Z, a uniform scale, where the front-left
 * corner of its footprint goes, and how deep its top sits below the stock top.
 */
export type UpAxis = '+z' | '-z' | '+y' | '-y' | '+x' | '-x';

export interface Model3D {
  id: string;
  name: string;
  /** base64 float32 triangle corners, the file's own units */
  tris: string;
  up: UpAxis;
  /** degrees about Z, counter-clockwise (after `up`) */
  turn: number;
  /** file units → mm (25.4 for a model drawn in inches) times any resizing */
  scale: number;
  /** front-left corner of the placed footprint on the stock (mm, work X/Y) */
  at: { x: number; y: number };
  /** depth of the model's highest point below the stock top (mm); 0 = flush with the top */
  top: number;
  /** border cleared round the footprint, down to the model's bottom (mm) */
  margin: number;
  /** grid spacing for the toolpaths (mm): finer is more exact and slower */
  res: number;
}

export const MODEL_DEFAULTS: Omit<Model3D, 'id' | 'name' | 'tris'> = { up: '+z', turn: 0, scale: 1, at: { x: 0, y: 0 }, top: 0, margin: 0, res: 0.25 };

export function encodeTris(t: Float32Array): string {
  const b = new Uint8Array(t.buffer, t.byteOffset, t.byteLength);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function decodeTris(s: string): Float32Array {
  const bin = atob(s);
  const b = new Uint8Array(bin.length - (bin.length % 4));
  for (let i = 0; i < b.length; i++) b[i] = bin.charCodeAt(i);
  return new Float32Array(b.buffer);
}

/** the model's axes turned so `up` points to +Z (right-handed turns, nothing mirrored) */
function upMap(up: UpAxis): (x: number, y: number, z: number) => [number, number, number] {
  switch (up) {
    case '-z': return (x, y, z) => [x, -y, -z];
    case '+y': return (x, y, z) => [x, -z, y];
    case '-y': return (x, y, z) => [x, z, -y];
    case '+x': return (x, y, z) => [-z, y, x];
    case '-x': return (x, y, z) => [z, y, -x];
    default: return (x, y, z) => [x, y, z];
  }
}

export interface Placed {
  /** triangle corners in work X/Y (mm) and Z = height above the model's bottom (mm) */
  tris: Float32Array;
  /** footprint on the stock */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** model height (mm) */
  height: number;
}

/** turns, scales and moves the model's triangles into place */
export function placeModel(m: Model3D, raw: Float32Array = decodeTris(m.tris)): Placed {
  const f = upMap(m.up);
  const a = (m.turn * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), k = m.scale;
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 3) {
    const [x, y, z] = f(raw[i], raw[i + 1], raw[i + 2]);
    out[i] = (x * c - y * s) * k;
    out[i + 1] = (x * s + y * c) * k;
    out[i + 2] = z * k;
  }
  const { min, max } = triBounds(out);
  const dx = m.at.x - min[0], dy = m.at.y - min[1];
  for (let i = 0; i < out.length; i += 3) {
    out[i] += dx;
    out[i + 1] += dy;
    out[i + 2] -= min[2];
  }
  return { tris: out, x0: m.at.x, y0: m.at.y, x1: m.at.x + max[0] - min[0], y1: m.at.y + max[1] - min[1], height: max[2] - min[2] };
}

/** the size of the placed model (mm) without placing it: for the size fields */
export function modelSize(m: Model3D, raw?: Float32Array) {
  const p = placeModel({ ...m, at: { x: 0, y: 0 } }, raw);
  return { x: p.x1, y: p.y1, z: p.height };
}

/**
 * The machining grid of a placed model: its footprint plus the margin, heights above the model's
 * bottom, and where it sits: grid point (i, j) is at work (ox + i·dx, oy + j·dy), and a height h
 * is `stockTop − h` below the stock top.
 */
export interface ModelGrid {
  g: MachGrid;
  ox: number;
  oy: number;
  /** stock top as a height above the model's bottom */
  stockTop: number;
}

export function modelGrid(m: Model3D, placed: Placed = placeModel(m)): ModelGrid {
  const mg = Math.max(0, m.margin);
  const ox = placed.x0 - mg, oy = placed.y0 - mg;
  const w = placed.x1 - placed.x0 + 2 * mg, h = placed.y1 - placed.y0 + 2 * mg;
  const res = Math.min(5, Math.max(0.05, m.res));
  const g = rasterizeTop(placed.tris, ox, oy, Math.max(w, res), Math.max(h, res), res, 0, 0);
  return { g, ox, oy, stockTop: m.top + placed.height };
}
