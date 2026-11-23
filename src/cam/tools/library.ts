import type { Cutter } from '../../core/cutter';
import { recommend, toolLabel, type Machine, type Material, type Recommendation } from '../../core/heightfieldCam';

/**
 * A tool in the library. `number` is the MASSO tool-table slot: T# M6 and G43 H# use it, so the
 * tool length MASSO measured for that slot is the one applied. Keep these numbers identical to
 * the tool table on the MASSO Touch.
 */
export interface LibraryTool {
  number: number;
  name: string;
  cutter: Cutter;
  flutes: number;
  /** cutting length (mm): deepest single cut it can take */
  fluteLength: number;
  shank: number;
  notes?: string;
}

const IN = 25.4;

/** a starter library of common router bits; renumber to match your MASSO tool table */
export const DEFAULT_TOOLS: LibraryTool[] = [
  { number: 1, name: '1/4" flat end mill', cutter: { type: 'flat', diameter: IN / 4, angle: 0 }, flutes: 2, fluteLength: 25.4, shank: IN / 4 },
  { number: 2, name: '1/8" flat end mill', cutter: { type: 'flat', diameter: IN / 8, angle: 0 }, flutes: 2, fluteLength: 12.7, shank: IN / 4 },
  { number: 3, name: '1/8" ball end mill', cutter: { type: 'ball', diameter: IN / 8, angle: 0 }, flutes: 2, fluteLength: 12.7, shank: IN / 4 },
  { number: 4, name: '60° V-bit', cutter: { type: 'vbit', diameter: 0, angle: 60 }, flutes: 2, fluteLength: 11, shank: IN / 4 },
  { number: 5, name: '90° V-bit', cutter: { type: 'vbit', diameter: 0, angle: 90 }, flutes: 2, fluteLength: 6.35, shank: IN / 4 },
  { number: 6, name: '1/16" tapered ball nose, 3.6°', cutter: { type: 'taperedBall', diameter: IN / 32, angle: 7.2 }, flutes: 2, fluteLength: 25.4, shank: IN / 4 },
  { number: 7, name: '1/2" flat end mill (surfacing)', cutter: { type: 'flat', diameter: IN / 2, angle: 0 }, flutes: 2, fluteLength: 25.4, shank: IN / 2 },
];

export function validateLibrary(tools: LibraryTool[]): string[] {
  const errs: string[] = [];
  const seen = new Set<number>();
  for (const t of tools) {
    if (!Number.isInteger(t.number) || t.number < 1 || t.number > 100) errs.push(`${t.name}: tool number ${t.number} must be a whole number 1–100`);
    if (seen.has(t.number)) errs.push(`tool number ${t.number} is used twice`);
    seen.add(t.number);
    if (t.cutter.type !== 'vbit' && !(t.cutter.diameter > 0)) errs.push(`${t.name}: diameter must be > 0`);
    if ((t.cutter.type === 'vbit' || t.cutter.type === 'taperedBall') && !(t.cutter.angle > 0 && t.cutter.angle < 180)) errs.push(`${t.name}: angle must be between 0 and 180°`);
  }
  return errs;
}

export const describeTool = (t: LibraryTool) => `T${t.number} ${toolLabel(t.cutter, (mm) => `${+mm.toFixed(3)} mm`)}, ${t.flutes} fl`;

export const feedsFor = (t: LibraryTool, material: Material, op: 'rough' | 'finish', mach?: Machine): Recommendation => recommend(material, t.cutter, t.flutes, op, mach);
