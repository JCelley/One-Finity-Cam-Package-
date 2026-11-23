import { DEFAULT_TOOLS, validateLibrary, type LibraryTool } from '../cam/tools/library';
import type { ToolType } from '../core/cutter';
import { FormatError, parseToolLibrary, safeFileName, toolLibraryToText, TOOLS_EXT } from '../io/formats';
import { canSaveInPlace, openTextFile, saveTextFile, type FileHandle } from '../io/files';
import type { Store } from '../io/store';
import { fmtLen, getUnits, onUnits, parseLen } from './units';

const TYPES: { v: ToolType; label: string }[] = [
  { v: 'flat', label: 'Flat end mill' },
  { v: 'ball', label: 'Ball end mill' },
  { v: 'vbit', label: 'V-bit' },
  { v: 'taperedBall', label: 'Tapered ball nose' },
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Tool library editor. Every change is kept in the browser store at once; Save / Save as write
 * the library to a file on disk (the master copy), Open replaces it with one from disk.
 */
export async function mountToolPanel(root: HTMLElement, store: Store) {
  const saved = await store.getLibrary();
  let name = saved?.name ?? 'Shop tools';
  let tools: LibraryTool[] = structuredClone(saved?.tools ?? DEFAULT_TOOLS);
  let handle: FileHandle | undefined;
  let dirty = saved?.dirty ?? false;
  const show = (mm: number) => fmtLen(mm);

  let msg = '';
  const keep = async () => {
    dirty = true;
    await store.putLibrary(name, tools, true);
  };

  const render = () => {
    const errs = validateLibrary(tools);
    root.innerHTML = `
<div class="bar">
  <label>Library <input data-f="libname" value="${esc(name)}"></label>
  <button data-a="open">Open…</button>
  <button data-a="save">${handle ? 'Save' : 'Save…'}</button>
  <button data-a="saveas">Save as…</button>
  <button data-a="add">Add tool</button>
  <span class="status">${dirty ? 'Unsaved changes (kept in this browser)' : handle ? `Saved to ${esc(handle.name)}` : ''}</span>
</div>
${msg ? `<p class="msg">${esc(msg)}</p>` : ''}
${errs.length ? `<p class="err">${errs.map(esc).join('<br>')}</p>` : ''}
<table>
<tr><th>T#</th><th>Name</th><th>Type</th><th>Ø (${getUnits()})</th><th>Angle °</th><th>Flutes</th><th>Flute length (${getUnits()})</th><th>Shank (${getUnits()})</th><th></th></tr>
${tools
  .map(
    (t, i) => `<tr data-i="${i}">
  <td><input data-f="number" type="number" min="1" max="100" step="1" value="${t.number}" class="n"></td>
  <td><input data-f="name" value="${esc(t.name)}"></td>
  <td><select data-f="type">${TYPES.map((o) => `<option value="${o.v}"${o.v === t.cutter.type ? ' selected' : ''}>${o.label}</option>`).join('')}</select></td>
  <td><input data-f="diameter" value="${show(t.cutter.diameter)}" class="n"></td>
  <td><input data-f="angle" type="number" step="any" min="0" max="179" value="${t.cutter.angle}" class="n"${t.cutter.type === 'vbit' || t.cutter.type === 'taperedBall' ? '' : ' disabled'}></td>
  <td><input data-f="flutes" type="number" step="1" min="1" value="${t.flutes}" class="n"></td>
  <td><input data-f="fluteLength" value="${show(t.fluteLength)}" class="n"></td>
  <td><input data-f="shank" value="${show(t.shank)}" class="n"></td>
  <td><button data-a="del" title="Remove tool">✕</button></td>
</tr>`,
  )
  .join('')}
</table>
<p class="hint">Keep the T# numbers the same as the MASSO tool table: the G-code calls tools by number (T# M6, G43 H#).
${canSaveInPlace() ? '' : ' This browser can’t save over files, so Save downloads a copy. Chrome or Edge can save in place.'}
${store.persistent ? '' : ' <b>Browser storage is unavailable here, so changes last only until you close the tab. Save to a file.</b>'}</p>`;
  };

  root.addEventListener('change', async (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const f = el.dataset.f;
    if (!f) return;
    if (f === 'libname') {
      name = el.value.trim() || 'Tools';
      await keep();
      render();
      return;
    }
    const i = Number(el.closest('tr')?.dataset.i);
    const t = tools[i];
    if (!t) return;
    const isLen = f === 'diameter' || f === 'fluteLength' || f === 'shank';
    const v = isLen ? (parseLen(el.value) ?? NaN) : Number(el.value);
    if (f === 'name') t.name = el.value;
    else if (f === 'type') {
      t.cutter.type = el.value as ToolType;
      if ((t.cutter.type === 'vbit' || t.cutter.type === 'taperedBall') && !(t.cutter.angle > 0)) t.cutter.angle = 60;
    } else if (!Number.isFinite(v)) {
      render();
      return;
    } else if (f === 'number') t.number = v;
    else if (f === 'angle') t.cutter.angle = v;
    else if (f === 'flutes') t.flutes = v;
    else if (f === 'diameter') t.cutter.diameter = v;
    else if (f === 'fluteLength') t.fluteLength = v;
    else if (f === 'shank') t.shank = v;
    msg = '';
    await keep();
    render();
  });

  root.addEventListener('click', async (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (!a) return;
    msg = '';
    try {
      if (a === 'add') {
        const n = Math.max(0, ...tools.map((t) => t.number)) + 1;
        tools.push({ number: n, name: 'New tool', cutter: { type: 'flat', diameter: 6.35, angle: 0 }, flutes: 2, fluteLength: 19, shank: 6.35 });
        await keep();
      } else if (a === 'del') {
        const i = Number((e.target as HTMLElement).closest('tr')?.dataset.i);
        if (confirm(`Remove T${tools[i].number} ${tools[i].name}?`)) {
          tools.splice(i, 1);
          await keep();
        }
      } else if (a === 'open') {
        if (dirty && !confirm('Replace the current library? Unsaved changes will be lost.')) return;
        const f = await openTextFile('tools');
        if (!f) return;
        const lib = parseToolLibrary(f.text);
        name = lib.name;
        tools = lib.tools;
        handle = f.handle;
        await store.putLibrary(name, tools);
        dirty = false;
        msg = `Opened ${f.name} (${tools.length} tools).`;
      } else if (a === 'save' || a === 'saveas') {
        const text = toolLibraryToText(name, tools);
        const h = await saveTextFile('tools', safeFileName(name, TOOLS_EXT), text, a === 'save' ? handle : undefined);
        if (h === null) return;
        if (h) handle = h;
        dirty = false;
        await store.putLibrary(name, tools, false);
        msg = h ? `Saved to ${h.name}.` : 'Downloaded a copy of the library.';
      }
    } catch (err) {
      msg = err instanceof FormatError ? `Can’t use that file: ${err.message}` : `Something went wrong: ${(err as Error).message}`;
    }
    render();
  });

  addEventListener('beforeunload', (e) => {
    if (dirty && !store.persistent) e.preventDefault();
  });

  onUnits(() => render());
  render();
}
