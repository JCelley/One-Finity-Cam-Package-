import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect } from 'vitest';
import { DEFAULT_TOOLS } from '../src/cam/tools/library';
import {
  FormatError,
  jobToText,
  newJob,
  parseJob,
  parseToolLibrary,
  toolLibraryToText,
  toolMismatches,
  safeFileName,
  type JobFile,
} from '../src/io/formats';
import { openStore, type JobRecord } from '../src/io/store';

const NOW = new Date('2026-11-22T12:00:00Z');

function sampleJob(): JobFile {
  const j = newJob('Walnut sign', 'woodworker');
  j.ops.push({ id: 'a', kind: 'profile', name: 'Cutout', toolNumber: 1, rpm: 18000, feed: 1500, plunge: 500, enabled: true, params: { side: 'outside', depth: 19.5 } });
  j.ops.push({ id: 'b', kind: 'vcarve', name: 'Letters', toolNumber: 4, rpm: 18000, feed: 1200, plunge: 400, enabled: true, params: {} });
  j.cad = { shapes: [{ type: 'rect', w: 100, h: 50 }] };
  return j;
}

describe('tool library file', () => {
  it('round-trips, sorted by tool number', () => {
    const shuffled = [...DEFAULT_TOOLS].reverse();
    const f = parseToolLibrary(toolLibraryToText('Shop tools', shuffled, NOW));
    expect(f.name).toBe('Shop tools');
    expect(f.saved).toBe(NOW.toISOString());
    expect(f.tools).toEqual(DEFAULT_TOOLS);
  });

  it('refuses broken, foreign and newer files with a clear reason', () => {
    expect(() => parseToolLibrary('not json')).toThrow(FormatError);
    expect(() => parseToolLibrary('{"format":"something-else","version":1}')).toThrow(/not an Onefinity CAM tool library/);
    expect(() => parseToolLibrary(JSON.stringify({ format: 'onefinity-cam-tools', version: 99, tools: [] }))).toThrow(/newer version/);
    const dup = JSON.stringify({ format: 'onefinity-cam-tools', version: 1, tools: [DEFAULT_TOOLS[0], DEFAULT_TOOLS[0]] });
    expect(() => parseToolLibrary(dup)).toThrow(/used twice/);
    const bad = JSON.stringify({ format: 'onefinity-cam-tools', version: 1, tools: [{ ...DEFAULT_TOOLS[0], cutter: { type: 'laser', diameter: 1, angle: 0 } }] });
    expect(() => parseToolLibrary(bad)).toThrow(/tool 1 type/);
  });
});

describe('job file', () => {
  it('round-trips and carries copies of just the tools it uses', () => {
    const text = jobToText(sampleJob(), DEFAULT_TOOLS, NOW);
    const j = parseJob(text);
    expect(j.tools.map((t) => t.number)).toEqual([1, 4]);
    expect(j.ops).toEqual(sampleJob().ops);
    expect(j.cad).toEqual(sampleJob().cad);
    expect(j.saved).toBe(NOW.toISOString());
    expect(toolMismatches(j, DEFAULT_TOOLS)).toEqual([]);
  });

  it('refuses to save an op whose tool is in neither the library nor the job', () => {
    const j = sampleJob();
    j.ops[0].toolNumber = 42;
    expect(() => jobToText(j, DEFAULT_TOOLS)).toThrow(/tool 42/);
  });

  it('opens on a machine whose library changed, and says what differs', () => {
    const j = parseJob(jobToText(sampleJob(), DEFAULT_TOOLS, NOW));
    const lib = DEFAULT_TOOLS.filter((t) => t.number !== 4).map((t) => (t.number === 1 ? { ...t, name: '6 mm flat', cutter: { ...t.cutter, diameter: 6 } } : t));
    expect(toolMismatches(j, lib)).toEqual(['T1: the job was made with 1/4" flat end mill, your library has 6 mm flat', 'T4 (60° V-bit) is not in your tool library']);
  });

  it('checks the fields it reads', () => {
    const v = JSON.parse(jobToText(sampleJob(), DEFAULT_TOOLS, NOW));
    expect(() => parseJob(JSON.stringify({ ...v, wcs: 7 }))).toThrow(/work offset/);
    expect(() => parseJob(JSON.stringify({ ...v, units: 'cm' }))).toThrow(/units/);
    expect(() => parseJob(JSON.stringify({ ...v, ops: [{ ...v.ops[0], toolNumber: 9 }] }))).toThrow(/does not include/);
    expect(() => parseJob(JSON.stringify({ ...v, version: 2 }))).toThrow(/newer version/);
  });

  it('file names', () => {
    expect(safeFileName('Walnut sign: v2/final', '.ofc-job.json')).toBe('Walnut sign v2 final.ofc-job.json');
    expect(safeFileName('  ', '.nc')).toBe('untitled.nc');
  });
});

describe('browser store', () => {
  it('keeps the library and jobs across reopening, recent first', async () => {
    const idb = new IDBFactory();
    const { store } = await openStore(idb);
    expect(store.persistent).toBe(true);
    expect(await store.getLibrary()).toBeNull();
    await store.putLibrary('Shop tools', DEFAULT_TOOLS);
    const rec = (id: string, updated: number): JobRecord => ({ id, job: sampleJob(), dirty: true, updated });
    await store.putJob(rec('old', 1));
    await store.putJob(rec('new', 2));

    const { store: again } = await openStore(idb);
    expect((await again.getLibrary())!.tools).toEqual(DEFAULT_TOOLS);
    expect((await again.recentJobs()).map((r) => r.id)).toEqual(['new', 'old']);
    expect((await again.getJob('old'))!.job.ops).toHaveLength(2);
    await again.deleteJob('old');
    expect(await again.getJob('old')).toBeNull();
  });

  it('falls back to memory when IndexedDB is not there', async () => {
    const { store } = await openStore(null);
    expect(store.persistent).toBe(false);
    await store.putLibrary('x', DEFAULT_TOOLS);
    expect((await store.getLibrary())!.tools).toHaveLength(DEFAULT_TOOLS.length);
  });
});
