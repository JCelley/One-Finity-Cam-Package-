import { readDoc } from '../cad/doc';
import { buildJob, jobGcode, OP_DEFAULTS, OP_LABEL, opParams, type OpKind } from '../cam/build';
import { machineById } from '../cam/machines';
import { grooveWidth } from '../cam/ops/engrave';
import { DEFAULT_TOOLS, describeTool, feedsFor, type LibraryTool } from '../cam/tools/library';
import type { Material } from '../core/heightfieldCam';
import type { JobOp } from '../io/formats';
import { openBinaryFile, saveTextFile } from '../io/files';
import { encodeTris, decodeTris, MODEL_DEFAULTS, modelSize, placeModel, type Model3D, type UpAxis } from '../cam/model3d';
import type { Raster3dParams } from '../cam/ops/raster3d';
import { parseStl } from '../core/stlRead';
import { scallopHeight } from '../core/heightfieldCam';
import type { Store } from '../io/store';
import { newId } from '../cad/doc';
import type { CamOpResult } from '../workers/cam.worker';
import { CamClient } from './camClient';
import type { CadEditor } from './cad/editor';
import type { JobApi } from './jobBar';
import { Preview3D } from './preview3d';
import { fmtLen, getUnits, onUnits, parseLen } from './units';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const MATERIALS: { v: Material; label: string }[] = [
  { v: 'softwood', label: 'Softwood' },
  { v: 'hardwood', label: 'Hardwood' },
  { v: 'mdf', label: 'MDF / plywood' },
  { v: 'plastic', label: 'Plastic' },
  { v: 'aluminum', label: 'Aluminium' },
];

const fmtTime = (s: number) => {
  if (!Number.isFinite(s) || s <= 0) return '–';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return h ? `${h} h ${m} min` : m ? `${m} min ${sec} s` : `${sec} s`;
};

/**
 * The Toolpaths tab: operations (made from the drawing selection), their settings, the 3D preview
 * with run times and warnings, and saving the MASSO G-code file.
 */
export function mountOpsPanel(root: HTMLElement, api: JobApi, editor: CadEditor, store: Store, onShowDrawing: () => void) {
  root.innerHTML = `
<div class="ops-tab">
  <aside class="ops-side">
    <div class="row"><label>Material <select data-g="material">${MATERIALS.map((m) => `<option value="${m.v}">${m.label}</option>`).join('')}</select></label></div>
    <div class="row add">Add from the drawing selection:
      <button data-a="add" data-kind="profile" title="Cut along or around the selected outlines">Profile</button>
      <button data-a="add" data-kind="pocket" title="Clear the area inside the selected closed outlines">Pocket</button>
      <button data-a="add" data-kind="drill" title="Drill at the centre of the selected circles">Drill</button>
      <button data-a="add" data-kind="engrave" title="Follow the selected lines with the tool tip: single-line text, layout lines">Engrave</button>
      <button data-a="add" data-kind="vcarve" title="V-carve inside the selected closed outlines (letters, shapes)">V-carve</button>
      <button data-a="add" data-kind="inlay" title="V-carved inlay: a pocket in one board and a mirrored plug for another">Inlay</button>
    </div>
    <div class="row add">3D from an STL model:
      <button data-a="stl" title="Load a 3D model (binary or ASCII STL) and add a roughing pass for it">Import STL…</button>
      <button data-a="add3d" data-pass="rough" title="Another roughing pass for the selected 3D operation's model">3D rough</button>
      <button data-a="add3d" data-pass="finish" title="A finishing pass for the selected 3D operation's model">3D finish</button>
      <button data-a="add3d" data-pass="rest" title="Rest machining: a smaller tool, only where the finishing tool couldn't reach (goes after a 3D finish)">3D rest</button>
    </div>
    <ol data-el="list" class="oplist"></ol>
    <div data-el="edit" class="opedit"></div>
  </aside>
  <section class="ops-main">
    <div class="ops-viewbar">
      <button data-a="view" data-dir="iso">3D</button><button data-a="view" data-dir="top">Top</button><button data-a="view" data-dir="front">Front</button>
      <label><input type="checkbox" data-g="rapids" checked> Rapids</label>
      <span class="legend"><i class="cut"></i>cut <i class="plunge"></i>plunge <i class="rapid"></i>rapid</span>
    </div>
    <div data-el="view" class="view3d"></div>
    <div class="ops-foot">
      <div data-el="stats" class="stats"></div>
      <button data-a="gcode" class="primary">Save G-code…</button>
    </div>
    <div data-el="warn" class="warnings"></div>
  </section>
</div>`;
  const el = (n: string) => root.querySelector<HTMLElement>(`[data-el="${n}"]`)!;
  const view = new Preview3D(el('view'));
  const cam = new CamClient();
  let selected: string | null = null;
  let results: CamOpResult[] = [];
  let totalSeconds = 0;
  let showRapids = true;
  let library: LibraryTool[] = DEFAULT_TOOLS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let msg = '';

  const job = () => api.job;
  const loadLibrary = async () => (library = (await store.getLibrary())?.tools ?? DEFAULT_TOOLS);
  const toolOf = (n: number) => library.find((t) => t.number === n) ?? job().tools.find((t) => t.number === n);
  const u = () => getUnits();
  const L = (mm: number) => fmtLen(mm);
  const F = (mmMin: number) => (u() === 'in' ? (mmMin / 25.4).toFixed(1) : String(Math.round(mmMin)));
  const parseFeed = (s: string) => {
    const v = parseFloat(s);
    return Number.isFinite(v) && v > 0 ? (u() === 'in' ? v * 25.4 : v) : null;
  };

  // ---- computing ----------------------------------------------------------------------------------

  const recompute = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const j = job();
      let doc;
      try {
        doc = readDoc(structuredClone(editor.doc));
      } catch {
        return;
      }
      const r = await cam.compute(j, doc, library, u());
      if (!r) return; // a newer request is on its way
      if (!r.ok) {
        msg = `Couldn't work out the toolpaths: ${r.error}`;
        results = [];
      } else {
        results = r.ops;
        totalSeconds = r.seconds;
        // other messages (an import, a save) stay until the next action
        if (msg.startsWith("Couldn't work out")) msg = '';
      }
      drawScene();
      renderStats();
    }, 250);
  };

  /** everything the toolpaths of one job operation add up to */
  const resOf = (opId: string) => {
    const rs = results.filter((r) => r.opId === opId);
    if (!rs.length) return null;
    return {
      seconds: rs.reduce((t, r) => t + r.stats.seconds, 0),
      cutLength: rs.reduce((t, r) => t + r.stats.cutLength, 0),
      moveCount: rs.reduce((t, r) => t + r.moveCount, 0),
      warnings: rs.flatMap((r) => r.warnings),
      parts: rs,
    };
  };

  const drawScene = () => {
    const j = job();
    const op = j.ops.find((o) => o.id === selected);
    const hl = new Set(op ? opParams(op as JobOp & { kind: OpKind }).geometry : []);
    view.setScene(j.stock, j.zZero === 'top' ? 0 : j.stock.z, editor.doc, hl);
    view.setPaths(results.map((r) => r.preview), selected ? results.map((r) => r.opId === selected) : null, showRapids);
    const zTop = j.zZero === 'top' ? 0 : j.stock.z;
    const sel = op?.kind === 'raster3d' ? (op.params as Partial<Raster3dParams>).model : undefined;
    view.setModels(
      j.models.map((m) => {
        const p = placedOf(m);
        return { tris: p.tris, zBottom: zTop - m.top - p.height, highlight: m.id === sel };
      }),
    );
  };

  // ---- 3D models ----------------------------------------------------------------------------------

  // decoded triangles per model, and the last placement of each (decoding and placing a big model
  // on every redraw would be slow)
  const raw = new Map<string, { src: string; tris: Float32Array }>();
  const rawOf = (m: Model3D) => {
    let r = raw.get(m.id);
    if (!r || r.src !== m.tris) raw.set(m.id, (r = { src: m.tris, tris: decodeTris(m.tris) }));
    return r.tris;
  };
  const placed = new Map<string, { key: string; p: ReturnType<typeof placeModel> }>();
  const placedOf = (m: Model3D) => {
    const key = JSON.stringify([m.up, m.turn, m.scale, m.at, m.tris.length]);
    let c = placed.get(m.id);
    if (!c || c.key !== key) placed.set(m.id, (c = { key, p: placeModel(m, rawOf(m)) }));
    return c.p;
  };
  const modelOfOp = (o: JobOp | undefined) => (o?.kind === 'raster3d' ? job().models.find((m) => m.id === (o.params as Partial<Raster3dParams>).model) : undefined);
  /** models no operation uses any more go with their last operation */
  const pruneModels = () => {
    const j = job();
    const used = new Set(j.ops.filter((o) => o.kind === 'raster3d').map((o) => (o.params as Partial<Raster3dParams>).model));
    j.models = j.models.filter((m) => used.has(m.id));
  };
  const UPS: [UpAxis, string][] = [['+z', 'Z up (as drawn)'], ['+y', 'Y up'], ['-z', 'Upside down'], ['-y', 'Y down'], ['+x', 'X up'], ['-x', 'X down']];

  // ---- rendering ----------------------------------------------------------------------------------

  const renderStats = () => {
    const j = job();
    const enabled = j.ops.filter((o) => o.enabled);
    el('stats').innerHTML = enabled.length
      ? `<b>About ${fmtTime(totalSeconds)}</b> <span class="hint">plus tool changes; no acceleration, so real runs take longer</span>`
      : '<span class="hint">No operations yet: select outlines in the Drawing tab, then add an operation here.</span>';
    const warn: string[] = [];
    if (msg) warn.push(esc(msg));
    for (const r of results) for (const w of r.warnings) warn.push(`<b>${esc(r.name)}:</b> ${esc(w)}`);
    el('warn').innerHTML = warn.map((w) => `<div>⚠ ${w}</div>`).join('');
    // times next to each op in the list
    for (const o of j.ops) {
      const t = root.querySelector(`[data-time="${o.id}"]`), r = resOf(o.id);
      if (t) t.textContent = r ? fmtTime(r.seconds) : '';
    }
  };

  const renderList = () => {
    const j = job();
    (root.querySelector('[data-g="material"]') as HTMLSelectElement).value = j.material;
    el('list').innerHTML = j.ops
      .map((o, i) => {
        const t = toolOf(o.toolNumber);
        const r = resOf(o.id);
        return `<li data-id="${o.id}" class="${o.id === selected ? 'sel' : ''}${o.enabled ? '' : ' off'}">
  <input type="checkbox" data-a="enable" ${o.enabled ? 'checked' : ''} title="Include in the G-code">
  <span class="name">${esc(o.name)}</span>
  <span class="tool">${t ? `T${t.number}` : `T${o.toolNumber}?`}</span>
  <span class="time" data-time="${o.id}">${r ? fmtTime(r.seconds) : ''}</span>
  ${r?.warnings.length ? '<span class="w" title="Has warnings">⚠</span>' : ''}
  <span class="btns"><button data-a="up" ${i === 0 ? 'disabled' : ''} title="Earlier">↑</button><button data-a="down" ${i === j.ops.length - 1 ? 'disabled' : ''} title="Later">↓</button><button data-a="del" title="Delete">✕</button></span>
</li>`;
      })
      .join('');
  };

  const field = (key: string, label: string, value: string, title = '', size = 6) => `<label title="${esc(title)}">${label}<input data-p="${key}" value="${esc(value)}" size="${size}"></label>`;
  const select = (key: string, label: string, value: string, opts: [string, string][]) => `<label>${label}<select data-p="${key}">${opts.map(([v, t]) => `<option value="${v}"${v === value ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`;

  const renderEdit = () => {
    const j = job();
    const op = j.ops.find((o) => o.id === selected);
    if (!op) {
      el('edit').innerHTML = j.ops.length ? '<p class="hint">Click an operation to edit it.</p>' : '';
      return;
    }
    const kind = op.kind as OpKind;
    const p = opParams(op as JobOp & { kind: OpKind }) as unknown as Record<string, unknown> & { geometry: string[] };
    const tools = library.map((t) => [String(t.number), describeTool(t) + ' – ' + t.name] as [string, string]);
    let h = `<h3>${OP_LABEL[kind]}</h3>
<div class="form">
  ${field('name', 'Name', op.name, '', 18)}
  ${select('tool', 'Tool', String(op.toolNumber), tools)}
  <div class="row3">${field('rpm', 'Speed (rpm)', String(op.rpm), '', 6)}${field('feed', `Feed (${u()}/min)`, F(op.feed))}${field('plunge', `Plunge (${u()}/min)`, F(op.plunge))}</div>
  <div class="row"><button data-a="recommend" title="Speeds and feeds for this tool and material, plus stepdown/stepover">Recommended feeds</button></div>
  ${kind === 'raster3d' ? '' : `<div class="row geo">${p.geometry.length} drawing item${p.geometry.length === 1 ? '' : 's'}
    <button data-a="usesel" title="Use what is selected in the Drawing tab">Use drawing selection</button>
    <button data-a="showsel" title="Select these items in the Drawing tab">Show in drawing</button></div>`}`;
    const len = (k: string, label: string, title = '') => field(k, label, L(p[k] as number), title);
    if (kind === 'profile') {
      const t = p.tabs as { count: number; width: number; height: number };
      h += `
  ${select('side', 'Cut', p.side as string, [['outside', 'Outside the line'], ['inside', 'Inside the line'], ['on', 'On the line']])}
  <div class="row3">${len('depth', 'Depth', 'Final depth below the top of the stock')}${len('stepdown', 'Stepdown', 'Deepest cut per pass')}${len('allowance', 'Leave', 'Material left on the wall')}</div>
  <div class="row3">${select('climb', 'Direction', String(p.climb), [['true', 'Climb'], ['false', 'Conventional']])}${field('ramp', 'Ramp °', String(p.ramp), '0 = plunge straight down', 4)}${len('top', 'Start depth', 'Usually 0 (the top of the stock)')}</div>
  <div class="row3">${field('tabs.count', 'Tabs', String(t.count), 'Holding tabs per closed outline (0 = none)', 3)}${field('tabs.width', 'Tab length', L(t.width))}${field('tabs.height', 'Tab height', L(t.height))}</div>`;
    } else if (kind === 'pocket') {
      h += `
  <div class="row3">${select('strategy', 'Pattern', p.strategy as string, [['offset', 'Offset (rings)'], ['raster', 'Raster (zig-zag)']])}${field('angle', 'Angle °', String(p.angle), 'Raster line direction', 4)}${field('stepover', 'Stepover %', String(Math.round((p.stepover as number) * 100)), '% of the tool diameter', 4)}</div>
  <div class="row3">${len('depth', 'Depth')}${len('stepdown', 'Stepdown')}${len('allowance', 'Leave', 'Material left on walls and floor')}</div>
  <div class="row3">${select('climb', 'Direction', String(p.climb), [['true', 'Climb'], ['false', 'Conventional']])}${field('ramp', 'Ramp °', String(p.ramp), '', 4)}${len('top', 'Start depth')}</div>`;
    } else if (kind === 'raster3d') {
      const m = modelOfOp(op);
      const t = toolOf(op.toolNumber);
      const models: [string, string][] = j.models.map((q) => [q.id, q.name]);
      h += `
  <div class="row3">${select('model', 'Model', (p.model as string) || '', models.length ? models : [['', '(none: import an STL)']])}${select('pass', 'Pass', p.pass as string, [['rough', 'Roughing (Z levels)'], ['finish', 'Finishing (raster)'], ['rest', 'Rest (smaller tool)']])}</div>`;
      if (p.pass === 'rough')
        h += `
  <div class="row3">${len('stepdown', 'Stepdown', 'Deepest cut per Z level')}${field('step3d', 'Stepover', L(p.stepover as number), 'Distance between the lines')}${len('allowance', 'Leave', 'Material left on the surface for finishing')}</div>
  <div class="row3">${field('ramp', 'Ramp °', String(p.ramp), '0 = plunge straight down', 4)}</div>`;
      else {
        const sc = t ? scallopHeight(t.cutter, p.stepover as number) : 0;
        h += `
  <div class="row3">${field('step3d', 'Stepover', L(p.stepover as number), 'Distance between the lines')}${select('dir', 'Lines', p.dir as string, [['x', 'Along X'], ['y', 'Along Y'], ['xy', 'X then Y']])}${field('ramp', 'Ramp °', String(p.ramp), '0 = plunge straight down', 4)}</div>${p.pass === 'rest' ? `
  <div class="row3">${len('stepdown', 'Stepdown', 'Deepest cut per level, below what the finishing left; 0 = one pass')}</div>` : ''}
  ${t ? `<p class="hint">Ridges between the lines about ${L(sc)} high on flat areas.${t.cutter.type === 'flat' ? ' A flat end mill leaves steps on curves: a ball end mill finishes them smoothly.' : ''}</p>` : ''}${
          p.pass === 'rest' ? `<p class="hint">Cuts only where the finishing passes above it on this model leave material this tool can reach: corners, narrow grooves, fine detail. Use a smaller tool than theirs.</p>` : ''
        }`;
      }
      if (m) {
        const sz = modelSize(m, rawOf(m));
        const ml = (k: string, label: string, v: number, title = '') => `<label title="${esc(title)}">${label}<input data-m="${k}" value="${esc(L(v))}" size="6"></label>`;
        h += `
  <fieldset class="model"><legend>Model: ${esc(m.name)} <span class="hint">(shared by its 3D operations)</span></legend>
  <div class="row3"><label>Up <select data-m="up">${UPS.map(([v, tx]) => `<option value="${v}"${v === m.up ? ' selected' : ''}>${tx}</option>`).join('')}</select></label><label title="Degrees, counter-clockwise">Turn °<input data-m="turn" value="${+m.turn.toFixed(2)}" size="4"></label></div>
  <div class="row3">${ml('sx', 'Width', sz.x, 'Size in X; the other sizes keep in proportion')}${ml('sy', 'Depth', sz.y, 'Size in Y')}${ml('sz', 'Height', sz.z, 'Size in Z')}</div>
  <div class="row3">${ml('x', 'X', m.at.x, 'Left edge on the stock')}${ml('y', 'Y', m.at.y, 'Front edge on the stock')}<button data-a="center" title="Centre the model on the stock">Centre</button></div>
  <div class="row3">${ml('top', 'Top below stock', m.top, 'How far the highest point of the model sits below the top of the stock (0 = flush)')}${ml('margin', 'Margin', m.margin, 'Border round the model cleared down to its bottom')}${ml('res', 'Resolution', m.res, 'Grid spacing: finer is more exact but slower')}</div>
  </fieldset>`;
      }
    } else if (kind === 'engrave') {
      const t = toolOf(op.toolNumber);
      const w = t ? grooveWidth(t.cutter, (p.depth as number) - (p.top as number)) : 0;
      h += `
  <div class="row3">${len('depth', 'Depth', 'Groove depth below the top of the stock')}${len('stepdown', 'Stepdown', 'Deepest cut per pass; 0 = one pass')}${len('lift', 'Lift', 'Between strokes the tool lifts this far above the stock, not all the way to the safe height')}</div>
  ${len('top', 'Start depth', 'Usually 0 (the top of the stock)')}
  ${t ? `<p class="hint">With ${esc(describeTool(t))} the groove is about ${L(w)} wide at this depth${t.cutter.type === 'vbit' ? ' (deeper = wider)' : ''}.</p>` : ''}`;
    } else if (kind === 'vcarve' || kind === 'inlay') {
      const clearOpts: [string, string][] = [['0', 'None'], ...library.filter((t) => t.cutter.type === 'flat').map((t) => [String(t.number), `T${t.number} ${t.name}`] as [string, string])];
      if (kind === 'inlay') {
        h += `
  ${select('side', 'Part', p.side as string, [['pocket', 'Pocket (in the base board)'], ['plug', 'Plug (mirrored, in the inlay board)']])}
  <div class="row3">${len('pocketDepth', 'Pocket depth', 'Depth of the flat bottom of the pocket')}${len('gap', 'Glue gap', 'Space left under the plug for glue')}${len('proud', 'Plug stands', 'How far the plug stands above the base board after gluing (plane it off)')}</div>
  <div class="row3">${len('margin', 'Plug margin', 'Waste cleared round the plug')}${len('stepdown', 'Stepdown', 'Deepest V-bit cut per pass; 0 = one pass')}</div>`;
      } else {
        h += `
  <div class="row3">${len('maxDepth', 'Max depth', 'Wider areas are left flat at this depth')}${len('stepdown', 'Stepdown', 'Deepest V-bit cut per pass; 0 = one pass')}</div>`;
      }
      h += `
  <div class="row3">${select('clearTool', 'Clear flats with', String(p.clearTool), clearOpts)}${field('clearStepover', 'Stepover %', String(Math.round((p.clearStepover as number) * 100)), 'Clearing stepover, % of that tool', 4)}</div>`;
    } else {
      h += `
  <div class="row3">${len('depth', 'Depth')}${len('peck', 'Peck', '0 = all the way in one go')}${field('dwell', 'Dwell s', String(p.dwell), 'Pause at the bottom', 4)}</div>
  ${len('top', 'Start depth')}`;
    }
    h += '</div>';
    const r = resOf(op.id);
    if (r) h += `<p class="hint">${r.moveCount.toLocaleString()} moves · ${(r.cutLength / (u() === 'in' ? 25.4 : 1000)).toFixed(u() === 'in' ? 0 : 1)} ${u() === 'in' ? 'in' : 'm'} of cutting · about ${fmtTime(r.seconds)}${r.parts.length > 1 ? ` (${r.parts.map((x) => `${x.tool ? `T${x.tool.number}` : ''} ${fmtTime(x.stats.seconds)}`).join(' + ')})` : ''}</p>`;
    h += `<div class="row"><button data-a="gcode1" title="A G-code file with only this operation (e.g. an inlay plug for its own board)">Save this operation…</button></div>`;
    el('edit').innerHTML = h;
  };

  const renderAll = () => {
    renderList();
    renderEdit();
    renderStats();
  };

  // ---- changes ------------------------------------------------------------------------------------

  const update = (rerender = true) => {
    api.changed(); // also triggers recompute via onChange
    if (rerender) renderAll();
  };

  const defaults = (kind: OpKind): JobOp => {
    const j = job();
    const carve = kind === 'vcarve' || kind === 'inlay';
    const tool = (carve || kind === 'engrave' ? library.find((t) => t.cutter.type === 'vbit') : null) ?? library.find((t) => t.cutter.type === 'flat') ?? library[0];
    const rec = feedsFor(tool, j.material as Material, 'rough', machineById(j.machineId).spindle);
    const params: Record<string, unknown> = { ...structuredClone(OP_DEFAULTS[kind]), geometry: editor.selectedIds() };
    if (kind === 'profile' || kind === 'drill') params.depth = Math.round((j.stock.z + 0.5) * 100) / 100;
    if (kind === 'pocket') params.depth = Math.min(6, Math.round((j.stock.z / 3) * 100) / 100);
    if (kind === 'engrave') {
      // a shallow line; V-bits cut it in one pass
    } else if (carve) {
      params.clearTool = library.find((t) => t.cutter.type === 'flat')?.number ?? 0;
      if (kind === 'inlay') params.pocketDepth = Math.min(5, Math.round((j.stock.z / 3) * 100) / 100);
    } else if (kind !== 'drill') {
      params.stepdown = rec.stepdown;
      if (kind === 'pocket') params.stepover = Math.round((rec.stepover / tool.cutter.diameter) * 100) / 100;
    } else params.peck = Math.max(1, Math.round(tool.cutter.diameter * 100) / 100);
    const n = j.ops.filter((o) => o.kind === kind).length + 1;
    return { id: newId(), kind, name: `${OP_LABEL[kind]} ${n}`, toolNumber: tool.number, rpm: rec.rpm, feed: rec.feed, plunge: rec.plunge, enabled: true, params };
  };

  const defaults3d = (pass: Raster3dParams['pass'], model: string): JobOp => {
    const j = job();
    const want = pass === 'rough' ? ['flat'] : ['ball', 'taperedBall'];
    let tool = library.find((t) => want.includes(t.cutter.type)) ?? library.find((t) => t.cutter.type === 'flat') ?? library[0];
    if (pass === 'rest') {
      // the biggest ball smaller than the smallest finishing tool on this model, else the smallest ball
      const fin = j.ops.filter((o) => o.kind === 'raster3d' && o.enabled && (o.params as Partial<Raster3dParams>).model === model && (o.params as Partial<Raster3dParams>).pass !== 'rough');
      const lim = Math.min(...fin.map((o) => toolOf(o.toolNumber)?.cutter.diameter ?? Infinity));
      const balls = library.filter((t) => want.includes(t.cutter.type)).sort((a, b) => a.cutter.diameter - b.cutter.diameter);
      tool = balls.filter((t) => t.cutter.diameter < lim - 1e-6).pop() ?? balls[0] ?? tool;
    }
    const rec = feedsFor(tool, j.material as Material, pass === 'rough' ? 'rough' : 'finish', machineById(j.machineId).spindle);
    const params: Raster3dParams = { ...structuredClone(OP_DEFAULTS.raster3d), model, pass, stepdown: rec.stepdown, stepover: rec.stepover };
    const n = j.ops.filter((o) => o.kind === 'raster3d' && (o.params as Partial<Raster3dParams>).pass === pass).length + 1;
    return { id: newId(), kind: 'raster3d', name: `3D ${pass} ${n}`, toolNumber: tool.number, rpm: rec.rpm, feed: rec.feed, plunge: rec.plunge, enabled: true, params: params as unknown as Record<string, unknown> };
  };

  const importStl = async () => {
    const f = await openBinaryFile('stl');
    if (!f) return;
    const j = job();
    let tris: Float32Array;
    try {
      tris = parseStl(f.data);
    } catch (err) {
      msg = `Couldn't read ${f.name}: ${(err as Error).message}`;
      return renderStats();
    }
    if (!tris.length) {
      msg = `${f.name} has no triangles`;
      return renderStats();
    }
    await loadLibrary();
    const m: Model3D = { id: newId(), name: f.name.replace(/[.]stl$/i, ''), tris: encodeTris(tris), ...structuredClone(MODEL_DEFAULTS) };
    const sz = modelSize(m, tris);
    m.at = { x: Math.max(0, (j.stock.x - sz.x) / 2), y: Math.max(0, (j.stock.y - sz.y) / 2) };
    j.models.push(m);
    const o = defaults3d('rough', m.id);
    j.ops.push(o);
    selected = o.id;
    msg = `Imported ${m.name}: ${(tris.length / 9).toLocaleString()} triangles, ${L(sz.x)} × ${L(sz.y)} × ${L(sz.z)} (read as mm). Check its size and place below.`;
    update();
  };

  root.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-id]');
    const j = job();
    if (!b) {
      if (li) {
        selected = li.dataset.id!;
        renderAll();
        drawScene();
      }
      return;
    }
    const a = b.dataset.a!;
    const i = li ? j.ops.findIndex((o) => o.id === li.dataset.id) : -1;
    const op = j.ops.find((o) => o.id === selected);
    if (a === 'add') {
      await loadLibrary();
      const o = defaults(b.dataset.kind as OpKind);
      if (!(o.params as { geometry: string[] }).geometry.length) msg = 'Nothing was selected in the drawing: pick items there, then press "Use drawing selection".';
      j.ops.push(o);
      selected = o.id;
      update();
    } else if (a === 'stl') {
      await importStl();
    } else if (a === 'add3d') {
      const m = modelOfOp(op) ?? j.models[j.models.length - 1];
      if (!m) {
        msg = 'Import an STL model first.';
        return renderStats();
      }
      await loadLibrary();
      const o = defaults3d(b.dataset.pass as Raster3dParams['pass'], m.id);
      j.ops.push(o);
      selected = o.id;
      msg = '';
      update();
    } else if (a === 'center' && op) {
      const m = modelOfOp(op);
      if (!m) return;
      const p = placedOf(m);
      m.at = { x: (j.stock.x - (p.x1 - p.x0)) / 2, y: (j.stock.y - (p.y1 - p.y0)) / 2 };
      update();
    } else if (a === 'enable' && i >= 0) {
      j.ops[i].enabled = (b as HTMLInputElement).checked;
      update();
    } else if ((a === 'up' || a === 'down') && i >= 0) {
      const k = a === 'up' ? i - 1 : i + 1;
      if (k < 0 || k >= j.ops.length) return;
      [j.ops[i], j.ops[k]] = [j.ops[k], j.ops[i]];
      update();
    } else if (a === 'del' && i >= 0) {
      if (!confirm(`Delete "${j.ops[i].name}"?`)) return;
      if (j.ops[i].id === selected) selected = null;
      j.ops.splice(i, 1);
      pruneModels();
      update();
    } else if (a === 'usesel' && op) {
      const ids = editor.selectedIds();
      if (!ids.length) {
        msg = 'Nothing is selected in the drawing.';
        renderStats();
        return;
      }
      op.params.geometry = ids;
      msg = '';
      update();
    } else if (a === 'showsel' && op) {
      editor.selectIds(opParams(op as JobOp & { kind: OpKind }).geometry);
      onShowDrawing();
    } else if (a === 'recommend' && op) {
      await loadLibrary();
      const t = toolOf(op.toolNumber);
      if (!t) return;
      const pass = op.kind === 'raster3d' && (op.params as Partial<Raster3dParams>).pass !== 'rough' ? 'finish' : 'rough';
      const rec = feedsFor(t, j.material as Material, pass, machineById(j.machineId).spindle);
      if (op.kind === 'raster3d') {
        op.params.stepdown = rec.stepdown;
        op.params.stepover = rec.stepover;
      }
      op.rpm = rec.rpm;
      op.feed = rec.feed;
      op.plunge = rec.plunge;
      if (op.kind === 'profile' || op.kind === 'pocket') op.params.stepdown = rec.stepdown;
      if (op.kind === 'pocket') op.params.stepover = Math.round((rec.stepover / t.cutter.diameter) * 100) / 100;
      if (op.kind === 'drill') op.params.peck = Math.max(1, Math.round(t.cutter.diameter * 100) / 100);
      update();
    } else if (a === 'view') view.view(b.dataset.dir as 'top');
    else if (a === 'gcode') await saveGcode();
    else if (a === 'gcode1' && op) await saveGcode([op.id]);
  });

  root.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const j = job();
    if (t.dataset.g === 'material') {
      j.material = t.value;
      return update();
    }
    if (t.dataset.g === 'rapids') {
      showRapids = (t as HTMLInputElement).checked;
      return drawScene();
    }
    const op = j.ops.find((o) => o.id === selected);
    const mk = t.dataset.m;
    if (mk && op) {
      const m = modelOfOp(op);
      if (!m) return;
      let ok = true;
      if (mk === 'up') m.up = t.value as UpAxis;
      else if (mk === 'turn') {
        const v = parseFloat(t.value);
        if (Number.isFinite(v)) m.turn = v;
        else ok = false;
      } else {
        const v = parseLen(t.value);
        if (v === null) ok = false;
        else if (mk === 'sx' || mk === 'sy' || mk === 'sz') {
          const sz = modelSize(m, rawOf(m));
          const cur = mk === 'sx' ? sz.x : mk === 'sy' ? sz.y : sz.z;
          if (v > 0 && cur > 0) m.scale *= v / cur;
          else ok = false;
        } else if (mk === 'x') m.at = { ...m.at, x: v };
        else if (mk === 'y') m.at = { ...m.at, y: v };
        else if (mk === 'top' && v >= 0) m.top = v;
        else if (mk === 'margin' && v >= 0) m.margin = v;
        else if (mk === 'res' && v >= 0.05 && v <= 5) m.res = v;
        else ok = false;
      }
      if (!ok) {
        msg = `"${t.value}" isn't a usable value there`;
        renderEdit();
        return renderStats();
      }
      msg = '';
      return update();
    }
    const k = t.dataset.p;
    if (!k || !op) return;
    const P = op.params as Record<string, unknown>;
    const lenKeys = ['depth', 'stepdown', 'allowance', 'top', 'peck', 'tabs.width', 'tabs.height', 'maxDepth', 'pocketDepth', 'gap', 'proud', 'margin', 'lift'];
    let ok = true;
    if (k === 'name') op.name = t.value.trim() || op.name;
    else if (k === 'tool') op.toolNumber = Number(t.value);
    else if (k === 'rpm') {
      const v = parseFloat(t.value);
      if (v > 0) op.rpm = Math.round(v);
      else ok = false;
    } else if (k === 'feed' || k === 'plunge') {
      const v = parseFeed(t.value);
      if (v) op[k] = v;
      else ok = false;
    } else if (lenKeys.includes(k)) {
      const v = parseLen(t.value);
      if (v === null || v < 0) ok = false;
      else if (k.startsWith('tabs.')) P.tabs = { ...opParams(op as JobOp & { kind: 'profile' }).tabs, [k.slice(5)]: v };
      else P[k] = v;
    } else if (k === 'tabs.count') {
      const v = parseInt(t.value, 10);
      if (v >= 0) P.tabs = { ...opParams(op as JobOp & { kind: 'profile' }).tabs, count: v };
      else ok = false;
    } else if (k === 'clearTool') P.clearTool = Number(t.value);
    else if (k === 'clearStepover') {
      const v = parseFloat(t.value);
      if (v >= 5 && v <= 95) P.clearStepover = v / 100;
      else ok = false;
    } else if (k === 'step3d') {
      const v = parseLen(t.value);
      if (v !== null && v >= 0.02) P.stepover = v;
      else ok = false;
    } else if (k === 'stepover') {
      const v = parseFloat(t.value);
      if (v >= 5 && v <= 95) P.stepover = v / 100;
      else ok = false;
    } else if (k === 'pass') {
      // roughing and finishing want different stepovers and stepdowns
      P.pass = t.value;
      const tl = toolOf(op.toolNumber);
      if (tl) {
        const rec = feedsFor(tl, j.material as Material, t.value === 'rough' ? 'rough' : 'finish', machineById(j.machineId).spindle);
        P.stepover = rec.stepover;
        P.stepdown = rec.stepdown;
      }
    } else if (k === 'climb') P.climb = t.value === 'true';
    else if (k === 'ramp' || k === 'angle' || k === 'dwell') {
      const v = parseFloat(t.value);
      if (Number.isFinite(v) && v >= 0) P[k] = v;
      else ok = false;
    } else P[k] = t.value;
    if (!ok) {
      msg = `"${t.value}" isn't a usable value there`;
      renderEdit();
      renderStats();
      return;
    }
    msg = '';
    update();
  });

  async function saveGcode(only?: string[]) {
    const j = job();
    try {
      await loadLibrary();
      const g = jobGcode(j, buildJob(j, readDoc(structuredClone(editor.doc)), library), undefined, only);
      const h = await saveTextFile('gcode', g.fileName, g.text);
      if (h !== null) msg = `Saved ${g.lines.toLocaleString()} lines${h ? ` to ${h.name}` : ''}${g.warnings.length ? `. Warnings: ${g.warnings.join('; ')}` : ''}. Air-cut a new setup before cutting stock.`;
    } catch (err) {
      msg = `Couldn't write the G-code: ${(err as Error).message}`;
    }
    renderStats();
  }

  api.onChange(() => {
    if (selected && !job().ops.some((o) => o.id === selected)) selected = null;
    renderList();
    recompute();
  });
  onUnits(() => {
    renderAll();
    recompute();
  });

  void loadLibrary().then(() => {
    renderAll();
    recompute();
  });

  return {
    /** call when the tab becomes visible (library may have changed in the other tab) */
    shown() {
      void loadLibrary().then(() => {
        renderAll();
        recompute();
        drawScene();
      });
    },
  };
}
