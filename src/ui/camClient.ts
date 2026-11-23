import type { CadDoc } from '../cad/doc';
import type { JobFile } from '../io/formats';
import type { LibraryTool } from '../cam/tools/library';
import type { CamReply } from '../workers/cam.worker';

/**
 * Talks to the toolpath worker. Only the newest request matters: when a newer request is sent,
 * older ones resolve to null (their replies are ignored).
 */
export class CamClient {
  private worker = new Worker(new URL('../workers/cam.worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private waiting = new Map<number, (r: CamReply | null) => void>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent<CamReply>) => {
      const f = this.waiting.get(e.data.id);
      this.waiting.delete(e.data.id);
      f?.(e.data.id === this.seq ? e.data : null);
    };
  }

  compute(job: JobFile, doc: CadDoc, library: LibraryTool[], units: 'mm' | 'in'): Promise<CamReply | null> {
    const id = ++this.seq;
    for (const [k, f] of this.waiting) {
      this.waiting.delete(k);
      f(null);
    }
    return new Promise((res) => {
      this.waiting.set(id, res);
      this.worker.postMessage(structuredClone({ id, job, doc, library, units }));
    });
  }
}
