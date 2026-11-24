import { readDoc } from '../cad/doc';
import { buildJob, jobGcode } from '../cam/build';
import { machineById } from '../cam/machines';
import { DEFAULT_TOOLS, type LibraryTool } from '../cam/tools/library';
import { openTextFile } from '../io/files';
import type { Store } from '../io/store';
import { interpret, segAt, segPoint, splitLine, type Program, type Seg } from '../sim/gcode';
import { analyse, cellFor, Cutting, FALLBACK, type SimTool, type SimWarning } from '../sim/simulate';
import { defaultAt, placeJob, simTool } from '../sim/setup';
import type { CadEditor } from './cad/editor';
import type { JobApi } from './jobBar';
import { Sim3D } from './sim3d';
import { fmtLen, getUnits, onUnits, parseLen } from './units';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const LINE_H = 18;
const SPEEDS = [1, 2, 5, 10, 25, 100, 500];
const clock = (s: number) => {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), q = t % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(q).padStart(2, '0')}`;
};

/**
 * Simulator tab: plays back the posted G-code (this job's, or any .nc file) on a schematic
 * Onefinity, cutting the stock as it goes, with the file's lines alongside and its warnings.
 */
export function mountSimPanel(root: HTMLElement, api: JobApi, editor: CadEditor, store: Store) {
  root.innerHTML = `
<div class="sim">
  <aside class="sim-side">
    <div class="bar">
      <button data-a="job" title="Post this job's toolpaths and simulate that file">This job</button>
      <button data-a="open" title="Simulate a G-code file (on this job's stock)">Open .nc…</button>
    </div>
    <div data-el="src" class="hint"></div>
    <fieldset class="simset"><legend>On the machine</legend>
      <div class="row3"><label title="Machine X of the stock's front-left corner (work X0)">Stock X <input data-s="x" size="6"></label><label title="Machine Y of the stock's front-left corner (work Y0)">Stock Y <input data-s="y" size="6"></label></div>
      <label title="Whether MASSO applies the tool length on G43 H# (what the post writes) or by itself on M6">Tool length on <select data-s="tlo"><option value="g43">G43 H#</option><option value="m6">M6 (no G43 needed)</option></select></label>
    </fieldset>
    <div data-el="warn" class="simwarn"></div>
    <div data-el="code" class="simcode"><div data-el="codein"></div></div>
  </aside>
  <section class="sim-main">
    <div class="ops-viewbar">
      <button data-a="view" data-dir="iso">3D</button><button data-a="view" data-dir="top">Top</button><button data-a="view" data-dir="front">Front</button><button data-a="view" data-dir="machine">Machine</button>
      <label><input type="checkbox" data-g="path" checked> Path</label>
      <label><input type="checkbox" data-g="rapids"> Rapids</label>
      <label><input type="checkbox" data-g="machine" checked> Machine</label>
    </div>
    <div data-el="view" class="view3d"></div>
    <div class="simbar">
      <button data-a="start" title="Back to the start (full stock)">⏮</button>
      <button data-a="back" title="Back one move">◀︎</button>
      <button data-a="play" class="primary" title="Play / pause (space)">▶︎ Play</button>
      <button data-a="fwd" title="Forward one move">▶︎|</button>
      <button data-a="end" title="Jump to the end: the finished part">⏭</button>
      <input data-el="scrub" type="range" min="0" max="1000" value="0" step="1">
      <select data-el="speed" title="Playback speed">${SPEEDS.map((s) => `<option value="${s}"${s === 10 ? ' selected' : ''}>${s}×</option>`).join('')}</select>
    </div>
    <div data-el="dro" class="dro"></div>
  </section>
</div>`;
  const el = (n: string) => root.querySelector<HTMLElement>(`[data-el="${n}"]`)!;
  const view = new Sim3D(el('view'));
  const scrub = el('scrub') as HTMLInputElement;
  const speedSel = el('speed') as HTMLSelectElement;
  const code = el('code'), codeIn = el('codein');

  let library: LibraryTool[] = DEFAULT_TOOLS;
  let source: { kind: 'job' | 'file'; name: string; text: string } | null = null;
  let prog: Program | null = null;
  let cutting: Cutting | null = null;
  let warnings: SimWarning[] = [];
  let at: { x: number; y: number } | null = null;
  let tlo: 'g43' | 'm6' = 'g43';
  let time = 0;
  let playing = false;
  let last = 0;
  let curLine = -1;
  let curTool = -1;
  let msg = '';
  let showPath = true, showRapids = false;

  const job = () => api.job;
  const machine = () => machineById(job().machineId);
  const L = (mm: number) => fmtLen(mm);
  /** with the unit, for sentences */
  const LU = (mm: number) => `${fmtLen(mm)} ${getUnits()}`;
  const toolMap = () => {
    const m = new Map<number, SimTool>();
    for (const t of job().tools) m.set(t.number, simTool(t));
    for (const t of library) m.set(t.number, simTool(t));
    return m;
  };
  let tools = toolMap();
  const toolOf = (n: number) => tools.get(n);

  // ---- loading ----------------------------------------------------------------------------------

  const fromJob = async () => {
    library = (await store.getLibrary())?.tools ?? DEFAULT_TOOLS;
    const j = job();
    try {
      const g = jobGcode(j, buildJob(j, readDoc(structuredClone(editor.doc)), library), 'simulator');
      // a file that hasn't changed keeps its place in the playback
      if (source?.kind === 'job' && source.text === g.text && prog) return;
      source = { kind: 'job', name: g.fileName, text: g.text };
      msg = '';
    } catch (err) {
      source = null;
      msg = (err as Error).message;
    }
    load();
  };

  /** (re)reads the source and runs it once for the warnings */
  const load = () => {
    pause();
    tools = toolMap();
    const j = job(), m = machine();
    at ??= defaultAt(m, j.stock);
    const { setup, offset } = placeJob(m, j.stock, j.zZero, at, cellFor(j.stock.x, j.stock.y));
    view.setMachine(m, setup.bedZ);
    if (!source) {
      prog = null;
      cutting = null;
      warnings = [];
      view.setPath(null, false);
      render();
      return;
    }
    const offsets = Array.from({ length: 6 }, () => offset);
    prog = interpret(source.text, { offsets, toolLen: (n) => (toolOf(n) ?? FALLBACK).len, rapid: m.rapid, tloOnM6: tlo === 'm6', home: { x: 0, y: m.travel.y } });
    warnings = analyse(prog, setup, toolOf, LU).warnings;
    cutting = new Cutting(prog, setup, toolOf);
    view.setStock(cutting);
    view.setPath(showPath ? prog : null, showRapids);
    time = 0;
    curTool = -1;
    renderCode();
    seek(0);
    render();
  };

  // ---- playback ---------------------------------------------------------------------------------

  /** segment index and fraction at time t */
  const where = (t: number): { i: number; f: number } => {
    const segs = prog!.segs;
    if (t >= prog!.duration) return { i: segs.length, f: 0 };
    const i = segAt(segs, t), s = segs[i];
    return { i, f: s.t1 > s.t0 ? Math.min(1, Math.max(0, (t - s.t0) / (s.t1 - s.t0))) : 1 };
  };

  const seek = (t: number) => {
    if (!prog || !cutting) return;
    time = Math.max(0, Math.min(prog.duration, t));
    const { i, f } = where(time);
    if (i < cutting.seg || (i === cutting.seg && f < cutting.f)) {
      cutting.reset();
      cutting.advanceTo(i, f);
      view.updateStock();
    } else if (cutting.advanceTo(i, f)) view.updateStock();
    show(i, f);
  };

  /** puts the machine, the line highlight and the readout where the playback is */
  const show = (i: number, f: number) => {
    const segs = prog!.segs;
    const s: Seg | undefined = segs[Math.min(i, segs.length - 1)];
    const tip = s ? (i >= segs.length ? s.to : segPoint(s, f)) : prog!.start;
    const tool = s?.tool ?? 0;
    if (tool !== curTool) {
      curTool = tool;
      view.setTool(tool ? (toolOf(tool) ?? FALLBACK) : null);
    }
    view.setPosition(tip, s?.len ?? 0);
    const line = s ? s.line : -1;
    if (line !== curLine) {
      curLine = line;
      highlight();
    }
    scrub.value = String(prog!.duration > 0 ? Math.round((time / prog!.duration) * 1000) : 0);
    const o = cutting!.setup.stock;
    const wz = tip.z - (cutting!.stock.bottom + (job().zZero === 'top' ? o.z : 0));
    el('dro').innerHTML = `<b>${clock(time)}</b> / ${clock(prog!.duration)}
      <span>Line ${line + 1}</span>
      <span>${tool ? `T${tool}` : 'No tool'}</span>
      <span>${s && s.rpm > 0 ? `Spindle ${s.rpm} rpm` : 'Spindle off'}</span>
      <span>${s?.kind === 'rapid' ? 'Rapid' : s && (s.kind === 'feed' || s.kind === 'arc') ? `Feed ${getUnits() === 'in' ? `${(s.feed / 25.4).toFixed(1)} in/min` : `${Math.round(s.feed)} mm/min`}` : ''}</span>
      <span title="Tool tip in work coordinates">Work X ${L(tip.x - o.x0)} Y ${L(tip.y - o.y0)} Z ${L(wz)}</span>
      <span title="Spindle nose in machine coordinates">Machine X ${L(tip.x)} Y ${L(tip.y)} Z ${L(tip.z + (s?.len ?? 0))}</span>`;
  };

  const frame = (now: number) => {
    if (!playing || !prog) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    seek(time + dt * Number(speedSel.value));
    if (time >= prog.duration) pause();
    else requestAnimationFrame(frame);
  };
  const play = () => {
    if (!prog || playing) return;
    if (time >= prog.duration) seek(0);
    playing = true;
    last = performance.now();
    requestAnimationFrame(frame);
    renderPlay();
  };
  function pause() {
    playing = false;
    renderPlay();
  }
  const renderPlay = () => {
    const b = root.querySelector<HTMLElement>('[data-a="play"]')!;
    b.textContent = playing ? '❚❚ Pause' : '▶︎ Play';
  };

  /** start of the next / previous move */
  const step = (dir: 1 | -1) => {
    if (!prog) return;
    pause();
    const segs = prog.segs;
    const { i } = where(time);
    if (dir > 0) {
      let k = i;
      // to the end of this move (or of the next one if already there)
      while (k < segs.length && (segs[k].t1 <= time + 1e-9 || segs[k].t1 === segs[k].t0)) k++;
      seek(k < segs.length ? segs[k].t1 : prog.duration);
    } else {
      let k = Math.min(i, segs.length - 1);
      while (k > 0 && (segs[k].t0 >= time - 1e-9 || segs[k].t1 === segs[k].t0)) k--;
      seek(segs[k]?.t0 ?? 0);
    }
  };

  // ---- G-code listing (only the lines in view are in the page) ----------------------------------

  const renderCode = () => {
    codeIn.style.height = `${(prog?.lines.length ?? 0) * LINE_H}px`;
    drawLines();
  };
  const drawLines = () => {
    if (!prog) {
      codeIn.innerHTML = '';
      return;
    }
    const a = Math.max(0, Math.floor(code.scrollTop / LINE_H) - 5), b = Math.min(prog.lines.length, a + Math.ceil(code.clientHeight / LINE_H) + 10);
    const warnAt = new Set(warnings.map((w) => w.line));
    let h = '';
    for (let k = a; k < b; k++) {
      const { comment } = splitLine(prog.lines[k]);
      const cls = `${k === curLine ? 'on' : ''}${warnAt.has(k) ? ' w' : ''}${comment && !prog.lines[k].replace(/\([^)]*\)/g, '').trim() ? ' c' : ''}`;
      h += `<div data-l="${k}" class="${cls}" style="top:${k * LINE_H}px"><i>${k + 1}</i>${esc(prog.lines[k])}</div>`;
    }
    codeIn.innerHTML = h;
  };
  const highlight = () => {
    if (curLine >= 0) {
      const y = curLine * LINE_H;
      if (y < code.scrollTop || y > code.scrollTop + code.clientHeight - LINE_H * 2) code.scrollTop = Math.max(0, y - code.clientHeight / 3);
    }
    drawLines();
  };
  code.addEventListener('scroll', drawLines);
  /** the first move a line makes (or the next one after it) */
  const timeOfLine = (l: number) => {
    const s = prog?.segs.find((q) => q.line >= l);
    return s ? s.t0 : (prog?.duration ?? 0);
  };
  codeIn.addEventListener('click', (e) => {
    const d = (e.target as HTMLElement).closest<HTMLElement>('[data-l]');
    if (!d || !prog) return;
    pause();
    seek(timeOfLine(Number(d.dataset.l)) + 1e-6);
  });

  // ---- the rest of the panel --------------------------------------------------------------------

  const render = () => {
    const j = job();
    el('src').innerHTML = source
      ? `${source.kind === 'job' ? 'This job, as posted' : 'File'}: <b>${esc(source.name)}</b>${prog ? `, ${prog.lines.length.toLocaleString()} lines, ${clock(prog.duration)} without acceleration` : ''}.
         ${source.kind === 'file' ? `Placed on this job's stock (${L(j.stock.x)} × ${L(j.stock.y)} × ${L(j.stock.z)}, Z0 on the ${j.zZero === 'top' ? 'top' : 'spoilboard'}).` : ''}`
      : `<span class="err">${esc(msg || 'Nothing to simulate yet.')}</span>`;
    const set = (k: string, v: string) => {
      const i = root.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-s="${k}"]`)!;
      if (document.activeElement !== i) i.value = v;
    };
    if (at) {
      set('x', L(at.x));
      set('y', L(at.y));
    }
    set('tlo', tlo);
    el('warn').innerHTML = !prog
      ? ''
      : warnings.length
        ? `<h3>Warnings</h3><ul>${warnings.map((w) => `<li data-l="${w.line}" class="${w.kind}"><b>Line ${w.line + 1}${w.count > 1 ? ` (+${w.count - 1} more)` : ''}:</b> ${esc(w.text)}</li>`).join('')}</ul>`
        : '<p class="msg">No warnings: nothing goes past the travel, no rapids through the stock, nothing deeper than the flutes, no cutting with the spindle stopped.</p>';
  };
  el('warn').addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-l]');
    if (!li || !prog) return;
    pause();
    seek(timeOfLine(Number(li.dataset.l)) + 1e-6);
  });

  root.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'job') await fromJob();
    else if (a === 'open') {
      const f = await openTextFile('gcode');
      if (!f) return;
      library = (await store.getLibrary())?.tools ?? DEFAULT_TOOLS;
      source = { kind: 'file', name: f.name, text: f.text };
      load();
    } else if (a === 'play') (playing ? pause : play)();
    else if (a === 'start') {
      pause();
      seek(0);
    } else if (a === 'end') {
      pause();
      if (prog) seek(prog.duration);
    } else if (a === 'back') step(-1);
    else if (a === 'fwd') step(1);
    else if (a === 'view') view.view(b.dataset.dir as 'iso');
  });

  root.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.g === 'path' || t.dataset.g === 'rapids') {
      if (t.dataset.g === 'path') showPath = t.checked;
      else showRapids = t.checked;
      view.setPath(showPath ? prog : null, showRapids);
    } else if (t.dataset.g === 'machine') view.showMachine(t.checked);
    else if (t.dataset.s === 'x' || t.dataset.s === 'y') {
      const v = parseLen(t.value);
      if (v === null || !at) return render();
      at = { ...at, [t.dataset.s]: v };
      load();
    } else if (t.dataset.s === 'tlo') {
      tlo = t.value as 'g43' | 'm6';
      load();
    }
  });

  scrub.addEventListener('input', () => {
    if (!prog) return;
    pause();
    seek((Number(scrub.value) / 1000) * prog.duration);
  });

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!root.offsetParent || (e.target as HTMLElement).closest('input, select, textarea')) return;
    if (e.key === ' ') {
      e.preventDefault();
      (playing ? pause : play)();
    } else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
  });

  api.onChange(() => {
    // another job, machine or stock: place it again next time the tab is shown
    if (source?.kind === 'job') source = { ...source, text: '' };
  });
  onUnits(() => {
    if (prog) warnings = analyse(prog, cutting!.setup, toolOf, LU).warnings;
    render();
    if (prog) show(where(time).i, where(time).f);
  });

  return {
    /** call when the tab becomes visible: simulates the job as it is now */
    shown() {
      if (!source || source.kind === 'job') void fromJob();
      else render();
    },
  };
}
