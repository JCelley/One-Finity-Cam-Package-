import type { MachineModel } from '../cam/machines';
import type { LibraryTool } from '../cam/tools/library';
import type { WorkOffset } from './gcode';
import { stickOut, type SimSetup, type SimTool } from './simulate';

/** a library tool for the simulator (its tip `stickOut` below the nose) */
export const simTool = (t: LibraryTool): SimTool => ({ number: t.number, name: t.name, cutter: t.cutter, fluteLength: t.fluteLength, shank: t.shank, plunge: t.plunge !== false, len: stickOut(t.fluteLength) });

/**
 * Where a job sits on the machine: the spoilboard top 10 mm below the lowest the nose goes (a
 * schematic figure), the stock on it with its front-left corner at machine (`at.x`, `at.y`), and
 * the work offset at that corner, Z0 on the stock top or the spoilboard.
 */
export function placeJob(machine: MachineModel, stock: { x: number; y: number; z: number }, zZero: 'top' | 'bottom', at: { x: number; y: number }, cell: number): { setup: SimSetup; offset: WorkOffset } {
  const bedZ = -machine.travel.z - 10;
  return {
    setup: { machine, bedZ, stock: { x0: at.x, y0: at.y, x: stock.x, y: stock.y, z: stock.z }, cell },
    offset: { x: at.x, y: at.y, z: bedZ + (zZero === 'top' ? stock.z : 0) },
  };
}

/** stock corner that centres it front-to-back near the front-left of the bed */
export const defaultAt = (machine: MachineModel, stock: { x: number; y: number }) => ({
  x: Math.max(0, Math.min(50, machine.travel.x - stock.x)),
  y: Math.max(0, Math.min(50, machine.travel.y - stock.y)),
});
