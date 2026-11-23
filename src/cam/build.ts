import type { CadDoc } from '../cad/doc';
import type { JobFile, JobOp } from '../io/formats';
import { postMasso, type MassoResult } from '../post/masso';
import { machineById } from './machines';
import type { LibraryTool } from './tools/library';
import type { Move } from './toolpath';
import { DEFAULT_TOL, fmtMm, type Ctx } from './ops/contour';
import { profileOp, PROFILE_DEFAULTS, type ProfileParams } from './ops/profile';
import { pocketOp, POCKET_DEFAULTS, type PocketParams } from './ops/pocket';
import { drillOp, DRILL_DEFAULTS, type DrillParams } from './ops/drill';

/**
 * Turns a job (drawing + operations) into moves per operation, with warnings and run-time
 * estimates, and into a MASSO G-code file. Pure: runs in the worker and in tests.
 */

export type OpKind = 'profile' | 'pocket' | 'drill';
export const OP_DEFAULTS = { profile: PROFILE_DEFAULTS, pocket: POCKET_DEFAULTS, drill: DRILL_DEFAULTS };
export const OP_LABEL: Record<OpKind, string> = { profile: 'Profile', pocket: 'Pocket', drill: 'Drill' };

/** the op's settings merged over the defaults (old files keep working when settings are added) */
export function opParams<K extends OpKind>(op: JobOp & { kind: K }): (typeof OP_DEFAULTS)[K] & { geometry: string[] } {
  const d = OP_DEFAULTS[op.kind];
  const p = op.params as Record<string, unknown>;
  const merged = { ...structuredClone(d), ...p } as Record<string, unknown>;
  if ('tabs' in d) merged.tabs = { ...(d as ProfileParams).tabs, ...((p.tabs as object) ?? {}) };
  merged.geometry = Array.isArray(p.geometry) ? p.geometry : [];
  return merged as unknown as (typeof OP_DEFAULTS)[K] & { geometry: string[] };
}

export interface MoveStats {
  seconds: number;
  cutLength: number;
  rapidLength: number;
  /** lowest work Z reached */
  minZ: number;
}

/** run time of a move list (feeds as given, rapids at `rapid` mm/min, no acceleration) */
export function moveStats(moves: Move[], feed: number, plunge: number, rapid: number, start = { x: 0, y: 0, z: 0 }): MoveStats {
  let c = { ...start };
  let t = 0, cut = 0, rap = 0, minZ = Infinity;
  for (const m of moves) {
    if (m.kind === 'dwell') {
      t += m.seconds / 60;
      continue;
    }
    if (m.kind === 'comment') continue;
    const n = { x: m.x ?? c.x, y: m.y ?? c.y, z: m.z ?? c.z };
    let d = Math.hypot(n.x - c.x, n.y - c.y, n.z - c.z);
    if (m.kind === 'arc') {
      const r = Math.hypot(m.i, m.j);
      const a0 = Math.atan2(-m.j, -m.i), a1 = Math.atan2(n.y - (c.y + m.j), n.x - (c.x + m.i));
      let sw = m.cw ? a0 - a1 : a1 - a0;
      while (sw <= 1e-12) sw += 2 * Math.PI;
      d = Math.hypot(r * sw, n.z - c.z);
    }
    if (m.kind === 'rapid') {
      t += d / rapid;
      rap += d;
    } else {
      t += d / (m.rate === 'plunge' ? plunge : feed);
      cut += d;
    }
    minZ = Math.min(minZ, n.z);
    c = n;
  }
  return { seconds: t * 60, cutLength: cut, rapidLength: rap, minZ };
}

export interface BuiltOp {
  id: string;
  name: string;
  kind: OpKind;
  tool: LibraryTool | null;
  moves: Move[];
  warnings: string[];
  stats: MoveStats;
}

export interface BuiltJob {
  ops: BuiltOp[];
  seconds: number;
  /** work Z of the stock top and the safe height */
  zTop: number;
  safeZ: number;
}

export function jobContext(job: JobFile, fmt: (mm: number) => string = fmtMm): Ctx {
  const zTop = job.zZero === 'top' ? 0 : job.stock.z;
  return { z: (d) => zTop - d, safeZ: zTop + job.safeZ, clear: 1, tol: DEFAULT_TOL, fmt };
}

/** lengths in messages: inches as 0.000", mm as 0.00 mm */
export const lengthFormatter = (units: 'mm' | 'in') => (units === 'in' ? (mm: number) => `${+(mm / 25.4).toFixed(3)}"` : fmtMm);

export function buildJob(job: JobFile, doc: CadDoc, library: LibraryTool[], fmt: (mm: number) => string = fmtMm): BuiltJob {
  const ctx = jobContext(job, fmt);
  const machine = machineById(job.machineId);
  const byId = new Map(doc.entities.map((e) => [e.id, e]));
  const tools = new Map([...job.tools, ...library].map((t) => [t.number, t]));
  for (const t of library) tools.set(t.number, t);
  const ops: BuiltOp[] = [];
  for (const op of job.ops) {
    if (!op.enabled || !(op.kind in OP_DEFAULTS)) continue;
    const kind = op.kind as OpKind;
    const tool = tools.get(op.toolNumber) ?? null;
    const warnings: string[] = [];
    let moves: Move[] = [];
    if (!tool) warnings.push(`Tool T${op.toolNumber} is not in the tool library`);
    else {
      const p = opParams(op as JobOp & { kind: OpKind });
      const items = p.geometry.map((id) => byId.get(id)).filter((e) => e !== undefined);
      if (items.length < p.geometry.length) warnings.push(`${p.geometry.length - items.length} of its drawing items no longer exist`);
      const dia = tool.cutter.diameter;
      if (tool.cutter.type === 'vbit' && kind !== 'drill') warnings.push('A V-bit cuts a V, not a straight wall: profile/pocket sizes assume its tip width');
      const r =
        kind === 'profile' ? profileOp(items, dia, p as ProfileParams, ctx)
        : kind === 'pocket' ? pocketOp(items, dia, p as PocketParams, ctx)
        : drillOp(items, dia, p as DrillParams, ctx);
      moves = r.moves;
      warnings.push(...r.warnings);
      const depth = (p as { depth: number }).depth;
      if (depth - ((p as { top: number }).top ?? 0) > tool.fluteLength + 1e-6) warnings.push(`Cuts ${fmt(depth)} deep but the tool's flutes are only ${fmt(tool.fluteLength)} long`);
      if (depth > job.stock.z + 2) warnings.push(`Goes ${fmt(depth - job.stock.z)} below the bottom of the stock, into the spoilboard`);
      if (kind === 'profile' && (p as ProfileParams).tabs.count > 0 && (p as ProfileParams).tabs.height >= depth) warnings.push('Tab height is at least the cut depth: nothing is cut where the tabs are');
    }
    const stats = moveStats(moves, op.feed, op.plunge, machine.rapid, { x: 0, y: 0, z: ctx.safeZ });
    ops.push({ id: op.id, name: op.name, kind, tool, moves, warnings, stats });
  }
  return { ops, seconds: ops.reduce((s, o) => s + o.stats.seconds, 0), zTop: ctx.z(0), safeZ: ctx.safeZ };
}

/** the MASSO file for the built operations (those with moves) */
export function jobGcode(job: JobFile, built: BuiltJob, stamp?: string): MassoResult {
  const src = new Map(job.ops.map((o) => [o.id, o]));
  const ops = built.ops
    .filter((o) => o.tool && o.moves.length)
    .map((o) => {
      const j = src.get(o.id)!;
      return { name: o.name, tool: o.tool!, rpm: j.rpm, feed: j.feed, plunge: j.plunge, moves: o.moves };
    });
  if (!ops.length) throw new Error('No toolpaths to write: add an operation with drawing items and a tool');
  return postMasso({
    name: job.name,
    ops,
    units: job.units,
    wcs: job.wcs,
    safeZ: built.safeZ,
    zeroNote: `X0 Y0 front-left corner of the stock, Z0 ${job.zZero === 'top' ? 'top of the stock' : 'spoilboard'}`,
    machine: machineById(job.machineId),
    stamp,
  });
}
