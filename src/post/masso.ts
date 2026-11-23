import type { Move } from '../cam/toolpath';
import { moveBounds } from '../cam/toolpath';
import type { LibraryTool } from '../cam/tools/library';
import type { MachineModel } from '../cam/machines';
import { toolLabel } from '../core/heightfieldCam';

/**
 * Post processor for the MASSO G3 / MASSO Touch controller on an Onefinity.
 *
 * What it emits (all standard MASSO G-code):
 *  - header comments, then `G90 G94 G17 G21|G20 G40 G49 G80` (absolute, feed/min, XY plane,
 *    units, cancel cutter comp / tool length / canned cycles) and the work offset `G54`–`G59`
 *  - per tool: retract `G53 G0 Z0` (machine top, MASSO's Z home), `T# M6` (runs MASSO's
 *    tool-change routine: manual change position and, if set up, the auto tool-setter), then
 *    `G43 H#` so the measured length of that tool-table slot is applied, `M3 S…`, optional dwell
 *  - G0 / G1 / G2 / G3 (I J incremental centres), modal: repeated words are left out
 *  - end: retract, `M5`, optional park, `M30`
 * Lengths are written in the chosen units with 4 (in) / 3 (mm) decimals.
 */
export interface MassoOp {
  name: string;
  tool: LibraryTool;
  rpm: number;
  /** cutting / plunge feed (mm/min) */
  feed: number;
  plunge: number;
  moves: Move[];
}

export interface MassoJob {
  name: string;
  ops: MassoOp[];
  units: 'mm' | 'in';
  /** work offset 1–6 → G54–G59 */
  wcs: 1 | 2 | 3 | 4 | 5 | 6;
  /** safe height above Z0 for retracts between ops (mm) */
  safeZ: number;
  /** where X0 Y0 and Z0 are, for the header */
  zeroNote?: string;
  /** apply tool length with G43 H# after each tool change (default true) */
  toolLength?: boolean;
  /** retract to machine Z top with G53 G0 Z0 before tool changes and at the end (default true) */
  machineRetract?: boolean;
  /** seconds to dwell after M3; MASSO also has its own spindle spin-up delay (default 0) */
  spindleDelay?: number;
  /** after the job: move to X0 Y0 of the work offset (default false) */
  parkAtZero?: boolean;
  machine?: MachineModel;
  /** fixed text for the header instead of the current date (tests / golden files) */
  stamp?: string;
}

export interface MassoResult {
  text: string;
  /** suggested file name for the MASSO USB loader */
  fileName: string;
  warnings: string[];
  lines: number;
}

/** MASSO reads short, plain file names most reliably: letters, digits, _ and -, `.nc` extension */
export function massoFileName(name: string, maxLen = 30): string {
  const base = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'job';
  return `${base.slice(0, maxLen).replace(/_$/, '')}.nc`;
}

export function postMasso(job: MassoJob): MassoResult {
  if (!job.ops.length) throw new Error('job has no operations');
  const inch = job.units === 'in';
  const k = inch ? 1 / 25.4 : 1;
  const dec = inch ? 4 : 3;
  const num = (v: number) => {
    const s = (v * k).toFixed(dec).replace(/\.?0+$/, '');
    return s === '-0' ? '0' : s;
  };
  const fnum = (v: number) => (inch ? (v * k).toFixed(2).replace(/\.?0+$/, '') : String(Math.round(v)));
  const clean = (s: string) => s.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
  const toolLen = job.toolLength ?? true;
  const machRetract = job.machineRetract ?? true;
  const L: string[] = [];
  const warnings: string[] = [];

  for (const op of job.ops) {
    if (!(op.feed > 0) || !(op.plunge > 0)) throw new Error(`${op.name}: feed and plunge must be > 0`);
    if (!(op.rpm > 0)) throw new Error(`${op.name}: spindle speed must be > 0`);
    const sp = job.machine?.spindle;
    if (sp && (op.rpm < sp.minRpm || op.rpm > sp.maxRpm)) warnings.push(`${op.name}: ${op.rpm} rpm is outside the spindle range ${sp.minRpm}–${sp.maxRpm}`);
  }
  if (job.machine) {
    const all = job.ops.flatMap((o) => o.moves);
    const b = moveBounds(all, { x: 0, y: 0, z: job.safeZ });
    const t = job.machine.travel;
    const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
    if (sx > t.x || sy > t.y) warnings.push(`toolpath spans ${sx.toFixed(1)} × ${sy.toFixed(1)} mm, more than the ${job.machine.name} travel ${t.x} × ${t.y} mm`);
    if (sz > t.z) warnings.push(`toolpath spans ${sz.toFixed(1)} mm in Z, more than the ${t.z} mm Z travel`);
  }

  const fmtLen = (mm: number) => `${num(mm)} ${job.units}`;
  L.push('%');
  L.push(`(${clean(job.name)})`);
  L.push(`(Onefinity CAM - MASSO post${job.stamp !== undefined ? ` - ${clean(job.stamp)}` : ` - ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`})`);
  if (job.machine) L.push(`(Machine: ${clean(job.machine.name)})`);
  L.push(`(Work offset: G${53 + job.wcs}${job.zeroNote ? `, ${clean(job.zeroNote)}` : ''})`);
  const seen = new Set<number>();
  for (const op of job.ops)
    if (!seen.has(op.tool.number)) {
      seen.add(op.tool.number);
      L.push(`(T${op.tool.number}: ${clean(op.tool.name)} - ${clean(toolLabel(op.tool.cutter, fmtLen))}, ${op.tool.flutes} fl)`);
    }
  L.push(`G90 G94 G17 ${inch ? 'G20' : 'G21'} G40 G49 G80`);
  L.push(`G${53 + job.wcs}`);

  // modal state (in job units after formatting; null = unknown)
  let gMode = '';
  let fCur = '';
  const pos: { x: string | null; y: string | null; z: string | null } = { x: null, y: null, z: null };
  const word = (axis: 'x' | 'y' | 'z', v: number | undefined, force = false): string => {
    if (v === undefined) return '';
    const s = num(v);
    if (!force && pos[axis] === s) return '';
    pos[axis] = s;
    return `${axis.toUpperCase()}${s}`;
  };
  const emit = (g: string, words: string[], f?: string) => {
    const w = words.filter(Boolean);
    if (!w.length && g !== 'G2' && g !== 'G3') return;
    const parts: string[] = [];
    if (g !== gMode || g === 'G2' || g === 'G3') parts.push(g);
    parts.push(...w);
    if (f !== undefined && f !== fCur) {
      parts.push(`F${f}`);
      fCur = f;
    }
    gMode = g;
    L.push(parts.join(' '));
  };

  let prevTool: number | null = null;
  let prevRpm = -1;
  for (const op of job.ops) {
    if (op.tool.number !== prevTool) {
      // retract before the tool change: machine Z top on MASSO, else the safe height
      if (machRetract) {
        L.push('G53 G0 Z0');
        pos.z = null;
        gMode = 'G0';
      } else emit('G0', [word('z', job.safeZ)]);
      if (prevTool !== null) L.push('M5');
      L.push(`(${clean(op.name)} - T${op.tool.number} ${clean(op.tool.name)})`);
      L.push(`T${op.tool.number} M6`);
      if (toolLen) L.push(`G43 H${op.tool.number}`);
      L.push(`M3 S${Math.round(op.rpm)}`);
      if ((job.spindleDelay ?? 0) > 0) L.push(`G4 P${job.spindleDelay}`);
      // after a tool change the controller may have moved: state everything again
      pos.x = pos.y = pos.z = null;
      gMode = '';
      prevTool = op.tool.number;
      prevRpm = op.rpm;
    } else {
      L.push(`(${clean(op.name)})`);
      if (op.rpm !== prevRpm) {
        L.push(`S${Math.round(op.rpm)}`);
        prevRpm = op.rpm;
      }
    }
    const F = (r: 'cut' | 'plunge') => fnum(r === 'cut' ? op.feed : op.plunge);
    // first move after a tool change: Z up to safe before going across
    let needSafe = pos.z === null;
    for (const m of op.moves) {
      if (m.kind === 'comment') {
        L.push(`(${clean(m.text)})`);
        continue;
      }
      if (m.kind === 'dwell') {
        L.push(`G4 P${+m.seconds.toFixed(3)}`);
        continue;
      }
      if (needSafe) {
        needSafe = false;
        // still up at the tool-change height: go across first, then down to the safe height
        if (m.kind === 'rapid' && (m.x !== undefined || m.y !== undefined)) {
          emit('G0', [word('x', m.x), word('y', m.y)]);
          emit('G0', [word('z', job.safeZ)]);
          if (m.z !== undefined) emit('G0', [word('z', m.z)]);
          continue;
        }
        emit('G0', [word('z', job.safeZ)]);
      }
      if (m.kind === 'rapid') emit('G0', [word('x', m.x), word('y', m.y), word('z', m.z)]);
      else if (m.kind === 'feed') emit('G1', [word('x', m.x), word('y', m.y), word('z', m.z)], F(m.rate));
      else {
        if (pos.x === null || pos.y === null) throw new Error(`${op.name}: arc with no known start point`);
        emit(m.cw ? 'G2' : 'G3', [word('x', m.x, true), word('y', m.y, true), word('z', m.z), `I${num(m.i)}`, `J${num(m.j)}`], F(m.rate));
      }
    }
  }
  if (machRetract) L.push('G53 G0 Z0');
  else emit('G0', [word('z', job.safeZ)]);
  L.push('M5');
  if (job.parkAtZero) L.push('G0 X0 Y0');
  L.push('M30');
  L.push('%');
  return { text: L.join('\n') + '\n', fileName: massoFileName(job.name), warnings, lines: L.length };
}
