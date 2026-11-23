import type { LibraryTool } from '../cam/tools/library';
import { validateLibrary } from '../cam/tools/library';
import type { ToolType } from '../core/cutter';

/**
 * On-disk formats. Plain JSON with a `format` tag and a `version`, so old files keep opening:
 * when a format changes, bump its version and add a step to its `migrate` chain below. Files from
 * a newer version than this app knows are refused rather than half-read.
 */

export const TOOLS_FORMAT = 'onefinity-cam-tools';
export const TOOLS_VERSION = 1;
export const TOOLS_EXT = '.ofc-tools.json';

export const JOB_FORMAT = 'onefinity-cam-job';
export const JOB_VERSION = 1;
export const JOB_EXT = '.ofc-job.json';

export interface ToolLibraryFile {
  format: typeof TOOLS_FORMAT;
  version: number;
  name: string;
  saved: string;
  tools: LibraryTool[];
}

/** one operation in a job: its kind and settings; the CAM modules read `params` (milestone 3+) */
export interface JobOp {
  id: string;
  kind: 'profile' | 'pocket' | 'drill' | 'vcarve' | 'inlay' | 'raster3d';
  name: string;
  toolNumber: number;
  rpm: number;
  feed: number;
  plunge: number;
  enabled: boolean;
  params: Record<string, unknown>;
}

export interface JobFile {
  format: typeof JOB_FORMAT;
  version: number;
  name: string;
  saved: string;
  machineId: string;
  units: 'mm' | 'in';
  wcs: 1 | 2 | 3 | 4 | 5 | 6;
  safeZ: number;
  material: string;
  stock: { x: number; y: number; z: number };
  zZero: 'top' | 'bottom';
  /** copies of the tools the ops use, so the job opens the same on any machine/library */
  tools: LibraryTool[];
  ops: JobOp[];
  /** the drawing (CAD document); its schema is defined by src/cad (milestone 2) */
  cad: unknown;
}

export class FormatError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new FormatError(`${what} must be a number`);
  return v;
};
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new FormatError(`${what} must be text`);
  return v;
};
const oneOf = <T extends string>(v: unknown, opts: readonly T[], what: string): T => {
  if (!opts.includes(v as T)) throw new FormatError(`${what} must be one of ${opts.join(', ')}`);
  return v as T;
};

const TOOL_TYPES: readonly ToolType[] = ['ball', 'taperedBall', 'vbit', 'flat'];

function readTool(v: unknown, i: number): LibraryTool {
  const w = `tool ${i + 1}`;
  if (!isObj(v) || !isObj(v.cutter)) throw new FormatError(`${w} is not a tool`);
  const t: LibraryTool = {
    number: num(v.number, `${w} number`),
    name: str(v.name, `${w} name`),
    cutter: { type: oneOf(v.cutter.type, TOOL_TYPES, `${w} type`), diameter: num(v.cutter.diameter, `${w} diameter`), angle: num(v.cutter.angle ?? 0, `${w} angle`) },
    flutes: num(v.flutes, `${w} flutes`),
    fluteLength: num(v.fluteLength, `${w} flute length`),
    shank: num(v.shank, `${w} shank`),
  };
  if (v.notes !== undefined) t.notes = str(v.notes, `${w} notes`);
  return t;
}

function readTools(v: unknown): LibraryTool[] {
  if (!Array.isArray(v)) throw new FormatError('tools must be a list');
  const tools = v.map(readTool);
  const errs = validateLibrary(tools);
  if (errs.length) throw new FormatError(errs.join('; '));
  return tools;
}

function parseJson(text: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new FormatError('not a valid JSON file');
  }
  if (!isObj(v)) throw new FormatError('not an Onefinity CAM file');
  return v;
}

function checkHeader(v: Record<string, unknown>, format: string, current: number, label: string): number {
  if (v.format !== format) throw new FormatError(`not an Onefinity CAM ${label} file`);
  const ver = num(v.version, 'version');
  if (ver > current) throw new FormatError(`this ${label} file is from a newer version of Onefinity CAM (format ${ver}); update the app to open it`);
  if (ver < 1 || !Number.isInteger(ver)) throw new FormatError(`unknown ${label} file version ${ver}`);
  return ver;
}

// ---- tool library -------------------------------------------------------------------------------

/** migration steps: MIGRATE_TOOLS[n] turns a version-n file into version n+1 */
const MIGRATE_TOOLS: Record<number, (v: Record<string, unknown>) => Record<string, unknown>> = {};

export function toolLibraryToText(name: string, tools: LibraryTool[], now = new Date()): string {
  const errs = validateLibrary(tools);
  if (errs.length) throw new FormatError(errs.join('; '));
  const f: ToolLibraryFile = { format: TOOLS_FORMAT, version: TOOLS_VERSION, name, saved: now.toISOString(), tools: [...tools].sort((a, b) => a.number - b.number) };
  return JSON.stringify(f, null, 2) + '\n';
}

export function parseToolLibrary(text: string): ToolLibraryFile {
  let v = parseJson(text);
  for (let ver = checkHeader(v, TOOLS_FORMAT, TOOLS_VERSION, 'tool library'); ver < TOOLS_VERSION; ver++) v = MIGRATE_TOOLS[ver](v);
  return { format: TOOLS_FORMAT, version: TOOLS_VERSION, name: str(v.name ?? 'Tools', 'name'), saved: str(v.saved ?? '', 'saved'), tools: readTools(v.tools) };
}

// ---- jobs ---------------------------------------------------------------------------------------

const MIGRATE_JOB: Record<number, (v: Record<string, unknown>) => Record<string, unknown>> = {};

const OP_KINDS: readonly JobOp['kind'][] = ['profile', 'pocket', 'drill', 'vcarve', 'inlay', 'raster3d'];

export function newJob(name: string, machineId: string): JobFile {
  return {
    format: JOB_FORMAT,
    version: JOB_VERSION,
    name,
    saved: '',
    machineId,
    units: 'mm',
    wcs: 1,
    safeZ: 5,
    material: 'hardwood',
    stock: { x: 300, y: 200, z: 19 },
    zZero: 'top',
    tools: [],
    ops: [],
    cad: null,
  };
}

/** the job as text; the tool copies are refreshed to just the tools its ops use */
export function jobToText(job: JobFile, library: LibraryTool[], now = new Date()): string {
  const used = new Set(job.ops.map((o) => o.toolNumber));
  const byNum = new Map([...job.tools, ...library].map((t) => [t.number, t] as const));
  // library wins over the job's old copy: saving picks up edits made to the library
  for (const t of library) byNum.set(t.number, t);
  const tools: LibraryTool[] = [];
  for (const n of [...used].sort((a, b) => a - b)) {
    const t = byNum.get(n);
    if (!t) throw new FormatError(`an operation uses tool ${n}, which is not in the library`);
    tools.push(t);
  }
  const f: JobFile = { ...job, format: JOB_FORMAT, version: JOB_VERSION, saved: now.toISOString(), tools };
  return JSON.stringify(f, null, 2) + '\n';
}

export function parseJob(text: string): JobFile {
  let v = parseJson(text);
  for (let ver = checkHeader(v, JOB_FORMAT, JOB_VERSION, 'job'); ver < JOB_VERSION; ver++) v = MIGRATE_JOB[ver](v);
  if (!isObj(v.stock)) throw new FormatError('stock is missing');
  if (!Array.isArray(v.ops)) throw new FormatError('ops must be a list');
  const tools = readTools(v.tools);
  const ops = v.ops.map((o, i): JobOp => {
    const w = `operation ${i + 1}`;
    if (!isObj(o)) throw new FormatError(`${w} is not an operation`);
    const op: JobOp = {
      id: str(o.id, `${w} id`),
      kind: oneOf(o.kind, OP_KINDS, `${w} kind`),
      name: str(o.name, `${w} name`),
      toolNumber: num(o.toolNumber, `${w} tool`),
      rpm: num(o.rpm, `${w} rpm`),
      feed: num(o.feed, `${w} feed`),
      plunge: num(o.plunge, `${w} plunge`),
      enabled: o.enabled !== false,
      params: isObj(o.params) ? o.params : {},
    };
    if (!tools.some((t) => t.number === op.toolNumber)) throw new FormatError(`${w} uses tool ${op.toolNumber}, which the file does not include`);
    return op;
  });
  return {
    format: JOB_FORMAT,
    version: JOB_VERSION,
    name: str(v.name, 'name'),
    saved: str(v.saved ?? '', 'saved'),
    machineId: str(v.machineId, 'machine'),
    units: oneOf(v.units, ['mm', 'in'] as const, 'units'),
    wcs: Number(oneOf(String(v.wcs), ['1', '2', '3', '4', '5', '6'] as const, 'work offset (1–6 for G54–G59)')) as JobFile['wcs'],
    safeZ: num(v.safeZ, 'safe Z'),
    material: str(v.material, 'material'),
    stock: { x: num(v.stock.x, 'stock X'), y: num(v.stock.y, 'stock Y'), z: num(v.stock.z, 'stock Z') },
    zZero: oneOf(v.zZero, ['top', 'bottom'] as const, 'Z zero'),
    tools,
    ops,
    cad: v.cad ?? null,
  };
}

/**
 * How the tools saved in a job differ from the current library, by tool number: missing from the
 * library, or a different cutter (shape/size/angle). Shown as a warning when a job is opened.
 */
export function toolMismatches(job: JobFile, library: LibraryTool[]): string[] {
  const out: string[] = [];
  for (const t of job.tools) {
    const l = library.find((q) => q.number === t.number);
    if (!l) out.push(`T${t.number} (${t.name}) is not in your tool library`);
    else if (l.cutter.type !== t.cutter.type || Math.abs(l.cutter.diameter - t.cutter.diameter) > 1e-6 || Math.abs(l.cutter.angle - t.cutter.angle) > 1e-6)
      out.push(`T${t.number}: the job was made with ${t.name}, your library has ${l.name}`);
  }
  return out;
}

/** a file name for a document name: keeps letters, digits, spaces, - and _ */
export const safeFileName = (name: string, ext: string) => `${name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'untitled'}${ext}`;
