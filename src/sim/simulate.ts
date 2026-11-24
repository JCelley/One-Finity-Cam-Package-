import { toolProfile, type Cutter } from '../core/cutter';
import { toolRadiusAt } from '../core/heightfieldCam';
import type { MachineModel } from '../cam/machines';
import { segPoint, type Program, type Seg } from './gcode';

/** a tool as the simulator sees it */
export interface SimTool {
  number: number;
  name: string;
  cutter: Cutter;
  /** cutting length (mm) */
  fluteLength: number;
  shank: number;
  /** false: not centre-cutting, it must not plunge (only ramp in gently) */
  plunge: boolean;
  /** how far the tip sits below the spindle nose (mm) */
  len: number;
}

/** stick-out used for the picture and the Z travel checks when the real one isn't known */
export const stickOut = (fluteLength: number) => fluteLength + 15;

export interface SimSetup {
  machine: MachineModel;
  /** machine Z of the spoilboard top, as reached by a tool tip */
  bedZ: number;
  /** the stock: front-left corner on the bed (machine X/Y) and its size; it lies on the bed */
  stock: { x0: number; y0: number; x: number; y: number; z: number };
  /** grid spacing of the stock (mm) */
  cell: number;
}

/** stands in for a tool number that isn't in the library (and for no tool at all) */
export const FALLBACK: SimTool = { number: 0, name: '3 mm flat (stand-in)', cutter: { type: 'flat', diameter: 3, angle: 0 }, fluteLength: 12, shank: 3, plunge: true, len: stickOut(12) };

/** grid spacing for a stock: about `cells` points in all, never finer than 0.2 mm */
export const cellFor = (x: number, y: number, cells = 360_000) => Math.max(0.2, Math.sqrt((x * y) / cells));

export type WarnKind = 'travel' | 'rapid' | 'flutes' | 'plunge' | 'spindle' | 'bed' | 'notool' | 'gcode';

export interface SimWarning {
  kind: WarnKind;
  /** first line (0-based) it happens on */
  line: number;
  text: string;
  /** how many lines it happens on */
  count: number;
}

/** the stock as a heightfield of machine Z over a grid of cells */
export class StockGrid {
  readonly nx: number;
  readonly ny: number;
  readonly z: Float32Array;
  readonly top: number;
  readonly bottom: number;
  constructor(readonly s: SimSetup) {
    this.nx = Math.max(2, Math.round(s.stock.x / s.cell) + 1);
    this.ny = Math.max(2, Math.round(s.stock.y / s.cell) + 1);
    this.bottom = s.bedZ;
    this.top = s.bedZ + s.stock.z;
    this.z = new Float32Array(this.nx * this.ny).fill(this.top);
  }
  get dx() {
    return this.s.stock.x / (this.nx - 1);
  }
  get dy() {
    return this.s.stock.y / (this.ny - 1);
  }
  reset() {
    this.z.fill(this.top);
  }
  /** height at a machine X/Y (nearest cell), or the bed off the stock */
  at(x: number, y: number) {
    const i = Math.round((x - this.s.stock.x0) / this.dx), j = Math.round((y - this.s.stock.y0) / this.dy);
    return i < 0 || j < 0 || i >= this.nx || j >= this.ny ? this.bottom : this.z[j * this.nx + i];
  }
}

/** cells under a tool: offsets and the height of the tool's surface above its tip there */
interface Kernel {
  di: Int32Array;
  dj: Int32Array;
  h: Float32Array;
}

function kernelOf(t: SimTool, dx: number, dy: number): Kernel {
  const reach = Math.max(t.cutter.diameter / 2, Math.min(toolRadiusAt(t.cutter, t.fluteLength), Math.max(t.shank, t.cutter.diameter) / 2));
  const ri = Math.ceil(reach / dx), rj = Math.ceil(reach / dy);
  const di: number[] = [], dj: number[] = [], h: number[] = [];
  for (let j = -rj; j <= rj; j++)
    for (let i = -ri; i <= ri; i++) {
      const d = Math.hypot(i * dx, j * dy);
      if (d > reach + 1e-9 && (i || j)) continue;
      const p = i || j ? toolProfile(t.cutter, d) : 0;
      if (!Number.isFinite(p)) continue;
      di.push(i);
      dj.push(j);
      h.push(p);
    }
  return { di: Int32Array.from(di), dj: Int32Array.from(dj), h: Float32Array.from(h) };
}

/** what one stretch of cutting did */
interface CutStats {
  /** volume removed (mm³) */
  removed: number;
  /** deepest material met above the tip where it cut (mm) */
  engage: number;
  /** grid cells changed: a box, for redrawing */
  i0: number;
  i1: number;
  j0: number;
  j1: number;
}

/**
 * Plays a program into a stock: material removal by stamping the tool's shape along every move,
 * forwards in time from wherever it got to (going back means starting again from the full stock).
 */
export class Cutting {
  readonly stock: StockGrid;
  private kernels = new Map<number, Kernel>();
  /** processed up to segment `seg`, fraction `f` of it */
  seg = 0;
  f = 0;
  constructor(
    readonly prog: Program,
    readonly setup: SimSetup,
    readonly tools: (n: number) => SimTool | undefined,
  ) {
    this.stock = new StockGrid(setup);
  }

  reset() {
    this.stock.reset();
    this.seg = 0;
    this.f = 0;
  }

  private kernel(n: number): Kernel {
    const t = this.tools(n) ?? FALLBACK;
    let k = this.kernels.get(n);
    if (!k) this.kernels.set(n, (k = kernelOf(t, this.stock.dx, this.stock.dy)));
    return k;
  }

  /** cuts segment s from fraction fa to fb */
  cutPart(s: Seg, fa: number, fb: number, st: CutStats) {
    if (s.kind === 'dwell' || s.kind === 'change' || fb <= fa) return;
    const g = this.stock;
    const top = g.top;
    if (s.from.z >= top && s.to.z >= top) return;
    const k = this.kernel(s.tool);
    const { nx, ny, z } = g;
    const dx = g.dx, dy = g.dy, x0 = this.setup.stock.x0, y0 = this.setup.stock.y0;
    const len = s.arc ? Math.abs(s.arc.sweep) * s.arc.r : Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y);
    const n = Math.max(1, Math.ceil(((fb - fa) * len) / (Math.min(dx, dy) / 2)));
    for (let q = 0; q <= n; q++) {
      const p = segPoint(s, fa + ((fb - fa) * q) / n);
      if (p.z >= top) continue;
      const ci = Math.round((p.x - x0) / dx), cj = Math.round((p.y - y0) / dy);
      for (let m = 0; m < k.h.length; m++) {
        const i = ci + k.di[m], j = cj + k.dj[m];
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const idx = j * nx + i;
        const nz = p.z + k.h[m];
        const old = z[idx];
        if (nz < old - 1e-4) {
          st.removed += (old - nz) * dx * dy;
          if (old - p.z > st.engage) st.engage = old - p.z;
          z[idx] = nz;
          if (i < st.i0) st.i0 = i;
          if (i > st.i1) st.i1 = i;
          if (j < st.j0) st.j0 = j;
          if (j > st.j1) st.j1 = j;
        }
      }
    }
  }

  /** cuts forward to segment `seg`, fraction `f`; returns the cells changed (or null) */
  advanceTo(seg: number, f: number): CutStats | null {
    const st: CutStats = { removed: 0, engage: 0, i0: Infinity, i1: -1, j0: Infinity, j1: -1 };
    const segs = this.prog.segs;
    if (seg < this.seg || (seg === this.seg && f < this.f)) return null;
    while (this.seg < seg && this.seg < segs.length) {
      this.cutPart(segs[this.seg], this.f, 1, st);
      this.seg++;
      this.f = 0;
    }
    if (this.seg < segs.length) {
      this.cutPart(segs[this.seg], this.f, f, st);
      this.f = f;
    }
    return st.i1 >= 0 ? st : null;
  }
}

const fmtMm = (v: number) => `${+v.toFixed(2)} mm`;

/**
 * Runs the whole program once into a fresh stock and checks every move: travel limits, rapids
 * through material, cuts deeper than the flutes, plunges with a tool that can't, cutting with the
 * spindle stopped or no tool, and going far into the spoilboard. Returns the warnings (one per
 * kind and tool, with the first line and a count) and the finished stock.
 */
export function analyse(prog: Program, setup: SimSetup, tools: (n: number) => SimTool | undefined, fmt: (mm: number) => string = fmtMm): { warnings: SimWarning[]; final: Cutting } {
  const c = new Cutting(prog, setup, tools);
  const found = new Map<string, SimWarning>();
  const warn = (key: string, kind: WarnKind, line: number, text: string) => {
    const w = found.get(key);
    if (w) {
      if (w.line !== line) w.count++;
    } else found.set(key, { kind, line, text, count: 1 });
  };
  for (const i of prog.issues) warn(`g${i.line}${i.text}`, 'gcode', i.line, i.text);
  const seen = new Set<number>();
  for (const n of prog.tools)
    if (n > 0 && !seen.has(n)) {
      seen.add(n);
      if (!tools(n)) warn(`lib${n}`, 'gcode', prog.segs.find((s) => s.tool === n)?.line ?? 0, `T${n} is not in the tool library: simulated as a 3 mm flat end mill`);
    }
  const t = setup.machine.travel;
  for (let si = 0; si < prog.segs.length; si++) {
    const s = prog.segs[si];
    if (s.kind === 'dwell' || s.kind === 'change') continue;
    // travel: the nose at the ends (and along an arc)
    const pts = s.arc ? Array.from({ length: 17 }, (_, q) => segPoint(s, q / 16)) : [s.to];
    const e = 0.01;
    if (pts.some((p) => p.x < -e || p.x > t.x + e)) warn('travelX', 'travel', s.line, `Goes past the X travel of the ${setup.machine.name} (0 to ${fmt(t.x)})`);
    if (pts.some((p) => p.y < -e || p.y > t.y + e)) warn('travelY', 'travel', s.line, `Goes past the Y travel of the ${setup.machine.name} (0 to ${fmt(t.y)})`);
    if (pts.some((p) => p.z + s.len > e || p.z + s.len < -t.z - e)) warn('travelZ', 'travel', s.line, `Goes past the Z travel of the ${setup.machine.name} (${fmt(t.z)} down from the top), with T${s.tool} sticking out ${fmt(s.len)}`);
    if (Math.min(s.from.z, s.to.z) < setup.bedZ - 1) warn('bed', 'bed', s.line, `Goes ${fmt(setup.bedZ - Math.min(s.from.z, s.to.z))} into the spoilboard`);
    const st: CutStats = { removed: 0, engage: 0, i0: Infinity, i1: -1, j0: Infinity, j1: -1 };
    c.cutPart(s, 0, 1, st);
    c.seg = si + 1;
    if (st.removed < 0.01) continue;
    const tool = tools(s.tool);
    const T = s.tool ? `T${s.tool}` : 'the tool';
    if (s.kind === 'rapid') warn(`rapid${s.tool}`, 'rapid', s.line, `A rapid (G0) goes through the stock with ${T}`);
    if (!s.tool) warn('notool', 'notool', s.line, 'Cuts with no tool loaded (no T# M6 before it)');
    else if (s.rpm <= 0 && s.kind !== 'rapid') warn(`spindle${s.tool}`, 'spindle', s.line, `${T} cuts with the spindle stopped`);
    if (tool && st.engage > tool.fluteLength + 0.01) warn(`flutes${s.tool}`, 'flutes', s.line, `${T} cuts ${fmt(st.engage)} deep, more than its ${fmt(tool.fluteLength)} flutes`);
    if (tool && !tool.plunge && s.kind !== 'rapid') {
      const dz = s.from.z - s.to.z, dxy = s.arc ? Math.abs(s.arc.sweep) * s.arc.r : Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y);
      if (dz > 0.05 && dz > dxy * Math.tan((15 * Math.PI) / 180)) warn(`plunge${s.tool}`, 'plunge', s.line, `${T} goes down into the material steeper than 15°, but it can't plunge`);
    }
  }
  return { warnings: [...found.values()].sort((a, b) => a.line - b.line), final: c };
}
