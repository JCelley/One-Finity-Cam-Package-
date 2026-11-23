/// <reference lib="webworker" />
import type { CadDoc } from '../cad/doc';
import type { JobFile } from '../io/formats';
import type { LibraryTool } from '../cam/tools/library';
import { buildJob, lengthFormatter, type BuiltOp } from '../cam/build';
import { previewOf, type PreviewPath } from '../cam/preview';

/**
 * Works out the toolpaths off the main thread, so the page stays responsive on big pockets.
 * Request: { id, job, doc, library }. Reply: { id, ok, ops, seconds, zTop, safeZ } or { id, ok: false, error }.
 */
export interface CamRequest {
  id: number;
  job: JobFile;
  doc: CadDoc;
  library: LibraryTool[];
  /** units for lengths in warnings */
  units: 'mm' | 'in';
}

export interface CamOpResult extends Omit<BuiltOp, 'moves'> {
  preview: PreviewPath;
  moveCount: number;
}

export type CamReply = { id: number; ok: true; ops: CamOpResult[]; seconds: number; zTop: number; safeZ: number } | { id: number; ok: false; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<CamRequest>) => {
  const { id, job, doc, library, units } = e.data;
  try {
    const b = buildJob(job, doc, library, lengthFormatter(units));
    let at = { x: 0, y: 0, z: b.safeZ };
    const ops: CamOpResult[] = b.ops.map((o) => {
      const preview = previewOf(o.moves, at);
      at = preview.end;
      const { moves, ...rest } = o;
      return { ...rest, preview, moveCount: moves.length };
    });
    const reply: CamReply = { id, ok: true, ops, seconds: b.seconds, zTop: b.zTop, safeZ: b.safeZ };
    ctx.postMessage(reply, ops.flatMap((o) => [o.preview.pos.buffer, o.preview.kind.buffer]));
  } catch (err) {
    const reply: CamReply = { id, ok: false, error: (err as Error).message };
    ctx.postMessage(reply);
  }
};
