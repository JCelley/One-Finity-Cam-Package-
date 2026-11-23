/**
 * Opening and saving files on disk. In Chrome / Edge this uses the File System Access API: real
 * Open / Save dialogs that remember the last folder per kind of file (jobs, tools, G-code), and
 * Save writes back over the file it was opened from. Elsewhere it falls back to a file input to
 * open and a download to save.
 */

export type FileKind = 'job' | 'tools' | 'gcode' | 'drawing' | 'dxf' | 'svg';

const KINDS: Record<FileKind, { id: string; description: string; accept: Record<string, string[]> }> = {
  job: { id: 'ofc-jobs', description: 'Onefinity CAM job', accept: { 'application/json': ['.json'] } },
  tools: { id: 'ofc-tools', description: 'Onefinity CAM tool library', accept: { 'application/json': ['.json'] } },
  gcode: { id: 'ofc-gcode', description: 'G-code for MASSO', accept: { 'text/plain': ['.nc'] } },
  drawing: { id: 'ofc-drawings', description: 'Drawing (DXF or SVG)', accept: { 'image/vnd.dxf': ['.dxf'], 'image/svg+xml': ['.svg'] } },
  dxf: { id: 'ofc-drawings', description: 'DXF drawing', accept: { 'image/vnd.dxf': ['.dxf'] } },
  svg: { id: 'ofc-drawings', description: 'SVG drawing', accept: { 'image/svg+xml': ['.svg'] } },
};

// the parts of the File System Access API used here (not in every TS DOM lib)
interface Writable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
export interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<Writable>;
  queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
}
interface PickerOpts {
  id: string;
  suggestedName?: string;
  types: { description: string; accept: Record<string, string[]> }[];
}
type FsWindow = {
  showOpenFilePicker?(o: PickerOpts & { multiple?: boolean }): Promise<FileHandle[]>;
  showSaveFilePicker?(o: PickerOpts): Promise<FileHandle>;
};

const fsw = () => globalThis as unknown as FsWindow;

/** true when Save can write straight back over the opened file (Chrome, Edge) */
export const canSaveInPlace = () => typeof fsw().showSaveFilePicker === 'function';

export interface OpenedFile {
  name: string;
  text: string;
  /** for Save to the same file; absent in the fallback */
  handle?: FileHandle;
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** asks for a file and reads it; null if the user cancelled */
export async function openTextFile(kind: FileKind): Promise<OpenedFile | null> {
  const k = KINDS[kind];
  const w = fsw();
  if (w.showOpenFilePicker) {
    try {
      const [handle] = await w.showOpenFilePicker({ id: k.id, types: [{ description: k.description, accept: k.accept }] });
      const f = await handle.getFile();
      return { name: f.name, text: await f.text(), handle };
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
  }
  return new Promise((res) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = Object.values(k.accept).flat().join(',');
    input.onchange = async () => {
      const f = input.files?.[0];
      res(f ? { name: f.name, text: await f.text() } : null);
    };
    input.oncancel = () => res(null);
    input.click();
  });
}

/**
 * Saves text. With a handle (from open or an earlier save) it writes over that file; otherwise it
 * asks where (or downloads in the fallback). Returns the handle to use next time, null if the user
 * cancelled, or undefined in the fallback (download: nothing to keep).
 */
export async function saveTextFile(kind: FileKind, suggestedName: string, text: string, handle?: FileHandle): Promise<FileHandle | null | undefined> {
  const k = KINDS[kind];
  const w = fsw();
  if (w.showSaveFilePicker) {
    try {
      let h = handle;
      if (h?.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
        if ((await h.requestPermission?.({ mode: 'readwrite' })) !== 'granted') h = undefined;
      }
      h ??= await w.showSaveFilePicker({ id: k.id, suggestedName, types: [{ description: k.description, accept: k.accept }] });
      const out = await h.createWritable();
      await out.write(text);
      await out.close();
      return h;
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: Object.keys(k.accept)[0] }));
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return undefined;
}
