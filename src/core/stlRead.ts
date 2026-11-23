/**
 * STL reader: binary or ASCII → triangle corner positions, 9 floats per triangle (x, y, z of each
 * corner), in the file's own units. Normals are ignored (the corners are what matter).
 */
export function parseStl(data: ArrayBuffer | Uint8Array): Float32Array {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length >= 84) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(80, true);
    // binary files say how many triangles they hold; ASCII ones start with "solid" (but some
    // binary exporters also put "solid" in the header, so the size check comes first)
    if (84 + 50 * n === bytes.length) return readBinary(dv, n);
  }
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart();
  if (/^solid\b/i.test(head)) {
    const tris = readAscii(new TextDecoder().decode(bytes));
    if (tris.length) return tris;
  }
  if (bytes.length >= 84) {
    // a binary file whose count is off (some exporters write junk after the triangles)
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = Math.min(dv.getUint32(80, true), Math.floor((bytes.length - 84) / 50));
    if (n > 0) return readBinary(dv, n);
  }
  throw new Error("that file isn't an STL this app can read");
}

function readBinary(dv: DataView, n: number): Float32Array {
  const out = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) {
    const off = 84 + 50 * t + 12;
    for (let k = 0; k < 9; k++) out[t * 9 + k] = dv.getFloat32(off + 4 * k, true);
  }
  return out;
}

function readAscii(text: string): Float32Array {
  const out: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  for (let m; (m = re.exec(text)); ) out.push(Number(m[1]), Number(m[2]), Number(m[3]));
  const whole = out.length - (out.length % 9);
  if (out.slice(0, whole).some((v) => !Number.isFinite(v))) throw new Error('the STL has a corner that is not a number');
  return Float32Array.from(out.slice(0, whole));
}

/** box round the triangles */
export function triBounds(t: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = t[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  return { min, max };
}
