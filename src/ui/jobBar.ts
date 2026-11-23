import { MACHINES } from '../cam/machines';
import { DEFAULT_TOOLS } from '../cam/tools/library';
import { readDoc, type CadDoc } from '../cad/doc';
import { FormatError, JOB_EXT, jobToText, newJob, parseJob, safeFileName, toolMismatches } from '../io/formats';
import { openTextFile, saveTextFile, type FileHandle } from '../io/files';
import { newJobId, type JobRecord, type Store } from '../io/store';
import { fmtLen, getUnits, onUnits, parseLen, setUnits } from './units';
import type { CadEditor } from './cad/editor';

const CURRENT = 'ofc-current-job';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * The job bar: name, machine, stock, units, and New / Open / Save / Save as / Recent. The open
 * job is autosaved to the browser store on every change (half a second after the last one); the
 * job file on disk is written only by Save.
 */
export async function mountJobBar(root: HTMLElement, store: Store, editor: CadEditor) {
  let rec: JobRecord = await restore();
  let handle: FileHandle | undefined;
  let msg = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function restore(): Promise<JobRecord> {
    let id: string | null = null;
    try {
      id = localStorage.getItem(CURRENT);
    } catch {
      /* storage blocked */
    }
    const r = id ? await store.getJob(id) : null;
    return r ?? fresh();
  }

  function fresh(): JobRecord {
    return { id: newJobId(), job: newJob('Untitled job', 'woodworker'), dirty: false, updated: Date.now() };
  }

  const library = async () => (await store.getLibrary())?.tools ?? DEFAULT_TOOLS;

  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      rec.updated = Date.now();
      await store.putJob(structuredClone(rec));
      try {
        localStorage.setItem(CURRENT, rec.id);
      } catch {
        /* storage blocked */
      }
    }, 500);
  };

  const changed = () => {
    rec.dirty = true;
    persist();
    render();
  };

  const show = (r: JobRecord) => {
    rec = r;
    editor.stock = { x: r.job.stock.x, y: r.job.stock.y };
    try {
      editor.load(readDoc(r.job.cad));
    } catch (err) {
      msg = `The drawing in this job couldn't be read: ${(err as Error).message}`;
      editor.load(readDoc(null));
    }
    try {
      localStorage.setItem(CURRENT, r.id);
    } catch {
      /* storage blocked */
    }
    render();
  };

  editor.onChange = (doc: CadDoc) => {
    rec.job.cad = doc;
    changed();
  };

  const confirmDiscard = () => !rec.dirty || confirm(`"${rec.job.name}" has changes that aren't saved to a file. They stay in this browser's recent jobs. Continue?`);

  async function save(as: boolean) {
    try {
      rec.job.cad = editor.doc;
      const text = jobToText(rec.job, await library());
      const h = await saveTextFile('job', rec.fileName ?? safeFileName(rec.job.name, JOB_EXT), text, as ? undefined : handle);
      if (h === null) return;
      if (h) {
        handle = h;
        rec.fileName = h.name;
      }
      rec.job = parseJob(text);
      rec.dirty = false;
      persist();
      msg = h ? `Saved to ${h.name}` : 'Downloaded the job file';
    } catch (err) {
      msg = err instanceof FormatError ? `Can't save: ${err.message}` : `Couldn't save: ${(err as Error).message}`;
    }
    render();
  }

  async function open() {
    if (!confirmDiscard()) return;
    try {
      const f = await openTextFile('job');
      if (!f) return;
      const job = parseJob(f.text);
      const r: JobRecord = { id: newJobId(), job, fileName: f.name, dirty: false, updated: Date.now() };
      handle = f.handle;
      await store.putJob(r);
      const diff = toolMismatches(job, await library());
      msg = diff.length ? `Opened ${f.name}. Tool differences: ${diff.join('; ')}` : `Opened ${f.name}`;
      show(r);
    } catch (err) {
      msg = err instanceof FormatError ? `Can't open that file: ${err.message}` : `Couldn't open: ${(err as Error).message}`;
      render();
    }
  }

  async function render() {
    const j = rec.job, u = getUnits();
    const recent = (await store.recentJobs(15)).filter((r) => r.id !== rec.id);
    root.innerHTML = `
<input data-j="name" value="${esc(j.name)}" title="Job name" class="jobname">
<select data-j="machine" title="Machine">${MACHINES.map((m) => `<option value="${m.id}"${m.id === j.machineId ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
<span class="stock" title="Stock size: X × Y × thickness">Stock
  <input data-j="sx" value="${fmtLen(j.stock.x, u)}" size="6"> ×
  <input data-j="sy" value="${fmtLen(j.stock.y, u)}" size="6"> ×
  <input data-j="sz" value="${fmtLen(j.stock.z, u)}" size="5"></span>
<select data-j="units" title="Units for everything you type and see"><option value="in"${u === 'in' ? ' selected' : ''}>inch</option><option value="mm"${u === 'mm' ? ' selected' : ''}>mm</option></select>
<span class="sep"></span>
<button data-a="new">New</button>
<button data-a="open">Open…</button>
<button data-a="save" title="${handle ? `Save to ${esc(handle.name)}` : 'Choose where to save'}">${handle ? 'Save' : 'Save…'}</button>
<button data-a="saveas">Save as…</button>
<select data-j="recent" title="Jobs kept in this browser"><option value="">Recent…</option>${recent.map((r) => `<option value="${r.id}">${esc(r.job.name)}${r.dirty ? ' •' : ''} (${new Date(r.updated).toLocaleDateString()})</option>`).join('')}</select>
<span class="status">${rec.dirty ? 'Unsaved changes (kept in this browser)' : rec.fileName ? `Saved: ${esc(rec.fileName)}` : ''}</span>
${msg ? `<div class="msg">${esc(msg)}</div>` : ''}
${!store.persistent ? '<div class="err">Browser storage is unavailable: save the job to a file before closing the tab.</div>' : ''}
`;
  }

  root.addEventListener('change', async (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const f = el.dataset.j;
    const j = rec.job;
    if (f === 'units') {
      setUnits(el.value as 'mm' | 'in');
      return;
    }
    if (f === 'recent') {
      const r = el.value ? await store.getJob(el.value) : null;
      if (r && confirmDiscard()) {
        handle = undefined;
        msg = `Opened "${r.job.name}" from this browser${r.fileName ? ` (last saved as ${r.fileName}: use Open… to save over that file again)` : ''}`;
        show(r);
      } else render();
      return;
    }
    if (f === 'name') j.name = el.value.trim() || 'Untitled job';
    else if (f === 'machine') j.machineId = el.value;
    else if (f === 'sx' || f === 'sy' || f === 'sz') {
      const v = parseLen(el.value);
      if (v !== null && v > 0) j.stock[f === 'sx' ? 'x' : f === 'sy' ? 'y' : 'z'] = v;
      editor.stock = { x: j.stock.x, y: j.stock.y };
      editor.requestRender();
    }
    msg = '';
    changed();
  });

  root.addEventListener('click', async (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (!a) return;
    msg = '';
    if (a === 'new') {
      if (!confirmDiscard()) return;
      handle = undefined;
      // stored on its first change, so empty jobs don't pile up in Recent
      show(fresh());
    } else if (a === 'open') await open();
    else if (a === 'save' || a === 'saveas') await save(a === 'saveas');
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save(e.shiftKey);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      void open();
    }
  });

  onUnits(() => render());
  show(rec);
}
