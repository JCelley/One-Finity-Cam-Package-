import type { Machine } from '../core/heightfieldCam';

/**
 * Onefinity models and their working envelopes (mm). Travel figures are the nominal cutting area
 * from Onefinity's published specs, rounded down; VERIFY against your own machine's soft limits in
 * MASSO (Settings → Axis) and edit here or override per job. Z travel is the full Z stroke, not
 * the clearance under the gantry.
 */
export interface MachineModel {
  id: string;
  name: string;
  travel: { x: number; y: number; z: number };
  spindle: Machine;
  /** rapid (G0) speed for run-time estimates, mm/min; VERIFY against MASSO's axis max speeds */
  rapid: number;
}

const router: Machine = { minRpm: 10000, maxRpm: 30000, maxFeed: 5000 };

export const MACHINES: MachineModel[] = [
  { id: 'machinist', name: 'Onefinity Machinist', travel: { x: 406, y: 406, z: 133 }, spindle: router, rapid: 10000 },
  { id: 'woodworker', name: 'Onefinity Woodworker (X-35)', travel: { x: 816, y: 816, z: 133 }, spindle: router, rapid: 10000 },
  { id: 'journeyman', name: 'Onefinity Journeyman (X-50)', travel: { x: 1220, y: 816, z: 133 }, spindle: router, rapid: 10000 },
  { id: 'foreman', name: 'Onefinity Elite Foreman', travel: { x: 1240, y: 1240, z: 160 }, spindle: router, rapid: 10000 },
  { id: 'elite-journeyman', name: 'Onefinity Elite Journeyman', travel: { x: 1240, y: 830, z: 160 }, spindle: router, rapid: 10000 },
  { id: 'elite-woodworker', name: 'Onefinity Elite Woodworker', travel: { x: 830, y: 830, z: 160 }, spindle: router, rapid: 10000 },
];

export const machineById = (id: string): MachineModel => {
  const m = MACHINES.find((q) => q.id === id);
  if (!m) throw new Error(`unknown machine '${id}'`);
  return m;
};
