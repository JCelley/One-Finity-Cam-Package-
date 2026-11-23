import { arc3, boxValid, dist, flatten, intersect, near, prims, shapeBox, shapeDistance, sub, type Box, type Prim, type Pt, type Shape } from '../../cad/geom';
import { DEFAULT_LAYER, entity, History, joinShapes, newId, type CadDoc, type Entity, type Layer, type TextMeta } from '../../cad/doc';
import { textOutlines, TEXT_DEFAULTS } from '../../cad/text';
import { DEFAULT_FONT, type FontCatalog, type FontEntry } from '../fonts';
import { findSnap, type Snap } from '../../cad/snap';
import { booleanShapes, mirrorAcross, offsetShapes, rotateAbout, scaleAbout, transformShape, translate, type BoolOp, type Xform } from '../../cad/ops';
import { parseDxf, writeDxf } from '../../cad/dxf';
import { parseSvg, writeSvg } from '../../cad/svg';
import { openBinaryFile, openTextFile, saveTextFile } from '../../io/files';
import { fmtLen, getUnits, onUnits, parseAngle, parseLen } from '../units';
import { Viewport } from './viewport';
import { readTheme, render, type Overlay, type Theme } from './render';


type Tool = 'select' | 'line' | 'poly' | 'rect' | 'circle' | 'arc' | 'dim' | 'text';

const TOOLS: { id: Tool; label: string; key: string; tip: string }[] = [
  { id: 'select', label: 'Select', key: 'S', tip: 'Select (S): click, Shift+click to add, drag a box (left→right: inside only, right→left: touching). Drag selected items to move them.' },
  { id: 'line', label: 'Line', key: 'L', tip: 'Line (L): click points; Enter, Esc or right-click ends.' },
  { id: 'poly', label: 'Polyline', key: 'P', tip: 'Polyline (P): click points; click the first point to close, Enter to leave it open.' },
  { id: 'rect', label: 'Rectangle', key: 'R', tip: 'Rectangle (R): two corners. Type @width,height for an exact size.' },
  { id: 'circle', label: 'Circle', key: 'C', tip: 'Circle (C): centre, then a point on it. Type a number for the radius.' },
  { id: 'arc', label: 'Arc', key: 'A', tip: 'Arc (A): start, a point on the arc, end.' },
  { id: 'dim', label: 'Dimension', key: 'D', tip: 'Dimension (D): two points, then where the dimension line goes.' },
  { id: 'text', label: 'Text', key: 'T', tip: 'Text (T): click where the text starts, then type it in the panel on the right.' },
];

const PROMPTS: Record<Tool, string[]> = {
  select: ['Click or drag to select'],
  line: ['Line: first point', 'Line: next point (Enter to finish)'],
  poly: ['Polyline: first point', 'Polyline: next point (click the start to close, Enter to finish open)'],
  rect: ['Rectangle: first corner', 'Rectangle: opposite corner (or @width,height)'],
  circle: ['Circle: centre', 'Circle: radius (point or number)'],
  arc: ['Arc: start point', 'Arc: a point on the arc', 'Arc: end point'],
  dim: ['Dimension: first point', 'Dimension: second point', 'Dimension: place the dimension line'],
  text: ['Text: click where the text starts', 'Text: type it in the panel on the right, then Add'],
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const LAYER_COLORS = ['#2f80ed', '#27ae60', '#eb5757', '#9b51e0', '#f2994a', '#56ccf2', '#bb6bd9', '#219653'];

/**
 * The 2D drawing editor. Owns the canvas, the tools and the side panels; the document is plain
 * data (`CadDoc`) and every change goes through `commit`, which records undo and calls `onChange`.
 */
export class CadEditor {
  doc: CadDoc;
  private history: History;
  private sel = new Set<string>();
  /** selection in the order it was picked (the first is the subject of Subtract) */
  private selOrder: string[] = [];
  private tool: Tool = 'select';
  private pts: Pt[] = [];
  private cursor: Pt = { x: 0, y: 0 };
  private snap: Snap | null = null;
  private snapOn = true;
  private gridSnap = true;
  private layerId: string;
  private vp = new Viewport();
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private theme!: Theme;
  private w = 800;
  private h = 600;
  private queued = false;
  private drag: { kind: 'pan'; x: number; y: number } | { kind: 'box'; x0: number; y0: number; x1: number; y1: number } | { kind: 'move'; from: Pt; orig: Entity[]; moved: boolean } | null = null;
  private spaceDown = false;
  private clipboard: Entity[] = [];
  private els: Record<string, HTMLElement> = {};
  stock: { x: number; y: number } | null = null;
  private fonts: FontCatalog | null = null;
  private fontList: FontEntry[] = [];
  /** text being placed (new) or edited (an existing group) */
  private textDraft: { meta: TextMeta; group: string | null } | null = null;
  private textPreview: Shape[] = [];
  private textTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFont = DEFAULT_FONT;
  onChange: (doc: CadDoc) => void = () => {};

  constructor(private root: HTMLElement, doc: CadDoc) {
    this.doc = doc;
    this.history = new History(doc);
    this.layerId = doc.layers[0]?.id ?? DEFAULT_LAYER.id;
    root.classList.add('cad');
    root.innerHTML = `
<div class="cad-tools">
  ${TOOLS.map((t) => `<button data-tool="${t.id}" title="${esc(t.tip)}">${t.label}<kbd>${t.key}</kbd></button>`).join('')}
  <hr>
  <button data-act="undo" title="Undo (Ctrl+Z)">Undo</button>
  <button data-act="redo" title="Redo (Ctrl+Y)">Redo</button>
  <button data-act="fit" title="Zoom to fit (F)">Fit</button>
  <hr>
  <button data-act="import" title="Import a DXF or SVG file">Import…</button>
  <button data-act="dxf" title="Export the selection (or everything) as DXF">Export DXF</button>
  <button data-act="svg" title="Export the selection (or everything) as SVG">Export SVG</button>
  <hr>
  <label title="Snap to ends, midpoints, centres, intersections"><input type="checkbox" data-opt="snap" checked> Snap</label>
  <label title="Snap to the grid when no object point is near"><input type="checkbox" data-opt="grid" checked> Grid</label>
</div>
<div class="cad-main">
  <canvas tabindex="0"></canvas>
  <div class="cad-status">
    <span data-el="coords" class="coords"></span>
    <span data-el="prompt" class="prompt"></span>
    <input data-el="cmd" placeholder="x,y   @dx,dy   @length<angle   or a length" spellcheck="false" autocomplete="off">
    <span data-el="msg" class="msg"></span>
  </div>
</div>
<div class="cad-side">
  <section><h3>Layers <button data-act="addlayer" title="Add a layer">+</button></h3><div data-el="layers"></div></section>
  <section><h3>Selection</h3><div data-el="props"></div></section>
</div>`;
    root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.els[e.dataset.el!] = e));
    this.canvas = root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.theme = readTheme(root);
    this.bind();
    new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement!);
    onUnits(() => this.refreshPanels());
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      this.theme = readTheme(root);
      this.requestRender();
    });
    this.setTool('select');
    this.refreshPanels();
    requestAnimationFrame(() => {
      this.resize();
      this.fit();
    });
  }

  /** replaces the whole drawing (opening a job); resets undo */
  load(doc: CadDoc) {
    this.doc = doc;
    this.history = new History(doc);
    this.sel.clear();
    this.selOrder = [];
    this.pts = [];
    this.layerId = doc.layers[0].id;
    this.refreshPanels();
    this.fit();
  }

  // ---- document changes ---------------------------------------------------------------------------

  private commit(msg?: string) {
    if (this.history.commit(this.doc)) this.onChange(this.doc);
    // drop selected ids that no longer exist
    const ids = new Set(this.doc.entities.map((e) => e.id));
    for (const id of [...this.sel]) if (!ids.has(id)) this.sel.delete(id);
    this.selOrder = this.selOrder.filter((id) => this.sel.has(id));
    if (msg !== undefined) this.say(msg);
    this.refreshPanels();
  }

  private add(shapes: Shape[], layer = this.layerId): Entity[] {
    const es = shapes.map((s) => entity(s, layer));
    this.doc.entities.push(...es);
    return es;
  }

  private undo() {
    const d = this.history.undo();
    if (!d) return this.say('Nothing to undo');
    this.doc = d;
    this.onChange(d);
    this.commit('Undone');
  }
  private redo() {
    const d = this.history.redo();
    if (!d) return this.say('Nothing to redo');
    this.doc = d;
    this.onChange(d);
    this.commit('Redone');
  }

  private layer(id: string): Layer | undefined {
    return this.doc.layers.find((l) => l.id === id);
  }
  private usable(e: Entity) {
    const l = this.layer(e.layer);
    return !!l && l.visible && !l.locked;
  }
  private visibleShapes(exclude?: Set<string>): Shape[] {
    return this.doc.entities.filter((e) => this.layer(e.layer)?.visible && !exclude?.has(e.id));
  }
  private selected(): Entity[] {
    const by = new Map(this.doc.entities.map((e) => [e.id, e]));
    return this.selOrder.map((id) => by.get(id)).filter((e): e is Entity => !!e);
  }

  /** ids of the selected drawing items, in the order they were picked */
  selectedIds(): string[] {
    return [...this.selOrder];
  }

  /** fonts for the text tool */
  async setFonts(f: FontCatalog) {
    this.fonts = f;
    this.fontList = await f.list();
    this.refreshPanels();
  }

  /** selects these items (e.g. an operation's geometry) */
  selectIds(ids: string[]) {
    const have = new Set(this.doc.entities.map((e) => e.id));
    this.select(ids.filter((id) => have.has(id)));
  }

  private select(ids: string[], addTo = false, toggle = false) {
    const groups = new Set(this.doc.entities.filter((e) => e.group && ids.includes(e.id)).map((e) => e.group));
    if (groups.size) ids = [...new Set([...ids, ...this.doc.entities.filter((e) => e.group && groups.has(e.group)).map((e) => e.id)])];
    if (this.textDraft?.group && !ids.some((id) => this.doc.entities.find((e) => e.id === id)?.group === this.textDraft!.group)) this.endText();
    if (!addTo && !toggle) {
      this.sel.clear();
      this.selOrder = [];
    }
    for (const id of ids) {
      if (toggle && this.sel.has(id)) {
        this.sel.delete(id);
        this.selOrder = this.selOrder.filter((x) => x !== id);
      } else if (!this.sel.has(id)) {
        this.sel.add(id);
        this.selOrder.push(id);
      }
    }
    this.refreshPanels();
  }

  // ---- view ---------------------------------------------------------------------------------------

  private resize() {
    const host = this.canvas.parentElement!;
    const r = this.canvas.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    this.w = Math.max(100, Math.floor(r.width || host.clientWidth));
    this.h = Math.max(100, Math.floor(r.height || host.clientHeight - 40));
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.requestRender();
  }

  fit() {
    let b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const e of this.visibleShapes()) b = shapeBox(e, b);
    if (this.stock) {
      b.x0 = Math.min(b.x0, 0); b.y0 = Math.min(b.y0, 0);
      b.x1 = Math.max(b.x1, this.stock.x); b.y1 = Math.max(b.y1, this.stock.y);
    }
    if (!boxValid(b)) b = { x0: 0, y0: 0, x1: 200, y1: 150 };
    this.vp.fit(b, this.w, this.h);
    this.requestRender();
  }

  requestRender() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.draw();
    });
  }

  private draw() {
    const ov: Overlay = { preview: this.previewShapes(), snap: this.tool !== 'select' || this.drag?.kind === 'move' ? this.snap : null, box: null, stock: this.stock };
    if (this.drag?.kind === 'box') {
      const d = this.drag;
      ov.box = { x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, crossing: d.x1 < d.x0 };
    }
    render(this.ctx, this.w, this.h, this.vp, this.doc, this.sel, ov, this.theme, getUnits());
    const u = getUnits();
    this.els.coords.textContent = `X ${fmtLen(this.cursor.x, u, u === 'in' ? 3 : 2)}  Y ${fmtLen(this.cursor.y, u, u === 'in' ? 3 : 2)} ${u}`;
    this.els.prompt.textContent = PROMPTS[this.tool][Math.min(this.pts.length, PROMPTS[this.tool].length - 1)];
  }

  private say(msg: string) {
    this.els.msg.textContent = msg;
  }

  // ---- drawing tools ------------------------------------------------------------------------------

  private setTool(t: Tool) {
    if (this.textDraft && !this.textDraft.group) {
      this.endText();
      this.refreshPanels();
    }
    this.tool = t;
    this.pts = [];
    this.root.querySelectorAll<HTMLElement>('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    this.canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
    this.requestRender();
  }

  /** the shapes the current tool would make with the cursor as its next point */
  private previewShapes(): Shape[] {
    const c = this.cursor, p = this.pts;
    if (this.textDraft) return this.textPreview;
    if (this.drag?.kind === 'move' && this.drag.moved) {
      const d = sub(c, this.drag.from);
      return this.drag.orig.map((e) => transformShape(e, translate(d.x, d.y)));
    }
    if (!p.length) return [];
    switch (this.tool) {
      case 'line':
        return [{ kind: 'line', a: p[0], b: c }];
      case 'poly':
        return [{ kind: 'poly', pts: [...p, c].map((q) => ({ ...q })), closed: false }];
      case 'rect':
        return [rectShape(p[0], c)];
      case 'circle':
        return [{ kind: 'circle', c: p[0], r: dist(p[0], c) }];
      case 'arc': {
        if (p.length === 1) return [{ kind: 'line', a: p[0], b: c }];
        const a = arc3(p[0], p[1], c);
        return a ? [a] : [{ kind: 'line', a: p[0], b: c }];
      }
      case 'dim':
        if (p.length === 1) return [{ kind: 'line', a: p[0], b: c }];
        return [{ kind: 'dim', a: p[0], b: p[1], off: dimOffset(p[0], p[1], c) }];
      default:
        return [];
    }
  }

  /** a point for the current tool (clicked or typed) */
  private addPoint(q: Pt) {
    const p = this.pts;
    switch (this.tool) {
      case 'line':
        if (p.length && !near(p[0], q, 1e-9)) {
          this.add([{ kind: 'line', a: p[0], b: q }]);
          this.commit('');
        }
        this.pts = [q];
        break;
      case 'poly':
        if (p.length >= 3 && near(p[0], q, 6 / this.vp.scale)) {
          this.add([{ kind: 'poly', pts: p.map((v) => ({ ...v })), closed: true }]);
          this.commit('Closed polyline');
          this.pts = [];
        } else if (!p.length || !near(p[p.length - 1], q, 1e-9)) p.push(q);
        break;
      case 'rect':
        if (p.length) {
          if (Math.abs(q.x - p[0].x) > 1e-9 && Math.abs(q.y - p[0].y) > 1e-9) {
            this.add([rectShape(p[0], q)]);
            this.commit('');
          }
          this.pts = [];
        } else this.pts = [q];
        break;
      case 'circle':
        if (p.length) {
          const r = dist(p[0], q);
          if (r > 1e-9) {
            this.add([{ kind: 'circle', c: p[0], r }]);
            this.commit('');
          }
          this.pts = [];
        } else this.pts = [q];
        break;
      case 'arc':
        if (p.length === 2) {
          const a = arc3(p[0], p[1], q);
          if (a) {
            this.add([a]);
            this.commit('');
          } else this.say('Those points are in a line: no arc');
          this.pts = [];
        } else p.push(q);
        break;
      case 'text':
        this.pts = [q];
        this.textDraft = { meta: { ...TEXT_DEFAULTS, text: this.textDraft?.meta.text ?? 'Text', font: this.lastFont, at: q, height: getUnits() === 'in' ? 25.4 : 25 }, group: null };
        this.refreshPanels();
        this.updateTextPreview();
        setTimeout(() => this.root.querySelector<HTMLTextAreaElement>('[data-text="text"]')?.select());
        break;
      case 'dim':
        if (p.length === 2) {
          this.add([{ kind: 'dim', a: p[0], b: p[1], off: dimOffset(p[0], p[1], q) }]);
          this.commit('');
          this.pts = [];
        } else if (!p.length || !near(p[0], q, 1e-9)) p.push(q);
        break;
    }
    this.requestRender();
  }

  /** Enter / right-click: finish what is being drawn */
  private finish() {
    if (this.tool === 'poly' && this.pts.length >= 2) {
      this.add([{ kind: 'poly', pts: this.pts.map((v) => ({ ...v })), closed: false }]);
      this.commit('');
    }
    this.pts = [];
    this.requestRender();
  }

  /** typed coordinates: "x,y", "@dx,dy", "@len<angle", or a length toward the cursor */
  private command(text: string) {
    const t = text.trim();
    if (!t) return this.finish();
    const last = this.pts[this.pts.length - 1] ?? null;
    let q: Pt | null = null;
    const polar = /^@\s*([^<]+)<\s*(.+)$/.exec(t);
    const pair = /^(@)?\s*([^,]+),\s*(.+)$/.exec(t);
    if (polar) {
      const l = parseLen(polar[1]), a = parseAngle(polar[2]);
      if (l !== null && a !== null) {
        const o = last ?? { x: 0, y: 0 };
        q = { x: o.x + l * Math.cos(a), y: o.y + l * Math.sin(a) };
      }
    } else if (pair) {
      const x = parseLen(pair[2]), y = parseLen(pair[3]);
      if (x !== null && y !== null) {
        const o = pair[1] ? (last ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
        q = { x: o.x + x, y: o.y + y };
      }
    } else {
      const l = parseLen(t);
      if (l !== null && last) {
        const d = sub(this.cursor, last), dl = Math.hypot(d.x, d.y);
        const u = dl > 1e-9 ? { x: d.x / dl, y: d.y / dl } : { x: 1, y: 0 };
        q = { x: last.x + u.x * l, y: last.y + u.y * l };
      } else if (l !== null) return this.say('Click a first point, then type a length');
    }
    if (!q) return this.say(`Didn't understand "${t}". Try 10,20  or  @25,0  or  @50<30`);
    if (this.tool === 'select') return this.say('Pick a drawing tool first');
    this.cursor = q;
    this.addPoint(q);
  }

  // ---- input --------------------------------------------------------------------------------------

  private updateCursor(sx: number, sy: number, shift: boolean) {
    const w = this.vp.toWorld(sx, sy);
    const exclude = this.drag?.kind === 'move' ? new Set(this.drag.orig.map((e) => e.id)) : undefined;
    const shapes = this.snapOn ? this.visibleShapes(exclude) : [];
    // while drawing, the points already placed are snap targets too
    if (this.snapOn && this.pts.length > 1) shapes.push({ kind: 'poly', pts: this.pts.slice(0, -1), closed: false });
    const snap = findSnap(shapes, w, { radius: 8 / this.vp.scale, grid: this.gridSnap ? this.gridSize() : 0, kinds: { nearest: this.tool !== 'select' } });
    this.snap = snap;
    let p = snap ? snap.p : w;
    // Shift: lock to 15° steps from the last point
    const base = this.drag?.kind === 'move' ? this.drag.from : this.pts[this.pts.length - 1];
    if (shift && base && (!snap || snap.kind === 'grid' || snap.kind === 'nearest')) {
      const d = sub(w, base), l = Math.hypot(d.x, d.y);
      const a = Math.round(Math.atan2(d.y, d.x) / (Math.PI / 12)) * (Math.PI / 12);
      p = { x: base.x + l * Math.cos(a), y: base.y + l * Math.sin(a) };
      this.snap = null;
    }
    this.cursor = p;
  }

  private gridSize() {
    // snap to a tenth of an inch / 1 mm, finer when zoomed in a lot
    const unit = getUnits() === 'in' ? 25.4 / 16 : 1;
    let g = unit;
    while (g * this.vp.scale > 40) g /= 2;
    while (g * this.vp.scale < 4) g *= 2;
    return g;
  }

  private hit(sx: number, sy: number): Entity | null {
    const w = this.vp.toWorld(sx, sy), tol = 6 / this.vp.scale;
    let best: Entity | null = null, bd = tol;
    for (const e of this.doc.entities) {
      if (!this.usable(e)) continue;
      const b = shapeBox(e);
      if (w.x < b.x0 - tol || w.x > b.x1 + tol || w.y < b.y0 - tol || w.y > b.y1 + tol) continue;
      const d = shapeDistance(e, w);
      if (d <= bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, crossing: boolean, addTo: boolean) {
    const a = this.vp.toWorld(Math.min(x0, x1), Math.max(y0, y1)), b = this.vp.toWorld(Math.max(x0, x1), Math.min(y0, y1));
    const box = { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
    const inside = (p: Pt) => p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1;
    const edges: Prim[] = [
      { t: 'seg', a: { x: box.x0, y: box.y0 }, b: { x: box.x1, y: box.y0 } },
      { t: 'seg', a: { x: box.x1, y: box.y0 }, b: { x: box.x1, y: box.y1 } },
      { t: 'seg', a: { x: box.x1, y: box.y1 }, b: { x: box.x0, y: box.y1 } },
      { t: 'seg', a: { x: box.x0, y: box.y1 }, b: { x: box.x0, y: box.y0 } },
    ];
    const ids: string[] = [];
    for (const e of this.doc.entities) {
      if (!this.usable(e)) continue;
      const eb = shapeBox(e);
      const fully = eb.x0 >= box.x0 && eb.x1 <= box.x1 && eb.y0 >= box.y0 && eb.y1 <= box.y1;
      if (fully) ids.push(e.id);
      else if (crossing && !(eb.x1 < box.x0 || eb.x0 > box.x1 || eb.y1 < box.y0 || eb.y0 > box.y1)) {
        const touches = flatten(e, 1 / this.vp.scale).pts.some(inside) || prims(e).some((p) => edges.some((q) => intersect(p, q).length > 0));
        if (touches) ids.push(e.id);
      }
    }
    this.select(ids, addTo);
  }

  private bind() {
    const cv = this.canvas;
    const local = (e: MouseEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      cv.focus();
      const s = local(e);
      cv.setPointerCapture(e.pointerId);
      if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
        this.drag = { kind: 'pan', x: s.x, y: s.y };
        cv.style.cursor = 'grabbing';
        return;
      }
      if (e.button === 2) {
        if (this.pts.length) this.finish();
        else this.drag = { kind: 'pan', x: s.x, y: s.y };
        return;
      }
      if (e.button !== 0) return;
      this.updateCursor(s.x, s.y, e.shiftKey);
      if (this.tool !== 'select') {
        this.addPoint(this.cursor);
        return;
      }
      const h = this.hit(s.x, s.y);
      if (h) {
        if (e.shiftKey || e.ctrlKey) this.select([h.id], true, true);
        else if (!this.sel.has(h.id)) this.select([h.id]);
        if (this.sel.has(h.id)) {
          // drag from a snapped point on the item so moves land on exact positions
          this.drag = { kind: 'move', from: this.snap && this.snap.kind !== 'grid' ? this.snap.p : this.cursor, orig: this.selected().filter((x) => this.usable(x)).map((x) => structuredClone(x)), moved: false };
        }
      } else this.drag = { kind: 'box', x0: s.x, y0: s.y, x1: s.x, y1: s.y };
      this.requestRender();
    });
    cv.addEventListener('pointermove', (e) => {
      const s = local(e);
      const d = this.drag;
      if (d?.kind === 'pan') {
        this.vp.pan(s.x - d.x, s.y - d.y);
        d.x = s.x;
        d.y = s.y;
      } else if (d?.kind === 'box') {
        d.x1 = s.x;
        d.y1 = s.y;
      } else {
        this.updateCursor(s.x, s.y, e.shiftKey);
        if (d?.kind === 'move' && !d.moved && dist(this.vp.toScreen(d.from), s) > 3) d.moved = true;
      }
      this.requestRender();
    });
    cv.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      cv.style.cursor = this.tool === 'select' ? 'default' : 'crosshair';
      if (d?.kind === 'box') {
        if (Math.abs(d.x1 - d.x0) < 3 && Math.abs(d.y1 - d.y0) < 3) {
          if (!e.shiftKey) this.select([]);
        } else this.boxSelect(d.x0, d.y0, d.x1, d.y1, d.x1 < d.x0, e.shiftKey);
      } else if (d?.kind === 'move' && d.moved) {
        const v = sub(this.cursor, d.from);
        this.transformSelection(translate(v.x, v.y), `Moved ${fmtLen(Math.hypot(v.x, v.y))} ${getUnits()}`);
      }
      this.requestRender();
    });
    cv.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const s = local(e);
        this.vp.zoomAt(s.x, s.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
        this.updateCursor(s.x, s.y, e.shiftKey);
        this.requestRender();
      },
      { passive: false },
    );
    cv.addEventListener('pointerleave', () => {
      this.snap = null;
      this.requestRender();
    });

    cv.addEventListener('keydown', (e) => this.key(e));
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') this.spaceDown = false;
    });

    const cmd = this.els.cmd as HTMLInputElement;
    cmd.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.command(cmd.value);
        cmd.value = '';
        e.preventDefault();
      } else if (e.key === 'Escape') {
        cmd.value = '';
        cv.focus();
      }
    });

    this.root.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tool],[data-act]');
      if (!b) return;
      if (b.dataset.tool) {
        this.setTool(b.dataset.tool as Tool);
        cv.focus();
      } else this.act(b.dataset.act!, b);
    });
    this.root.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.dataset.text) this.textField(el);
    });
    this.root.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.dataset.text) return this.textField(el);
      if (el.dataset.opt === 'snap') this.snapOn = el.checked;
      else if (el.dataset.opt === 'grid') this.gridSnap = el.checked;
      else if (el.dataset.layer !== undefined) this.layerChange(el);
      else if (el.dataset.prop) this.propChange(el);
    });
  }

  private key(e: KeyboardEvent) {
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    if (k === ' ') {
      this.spaceDown = true;
      e.preventDefault();
      return;
    }
    if (ctrl && k.toLowerCase() === 'z') e.shiftKey ? this.redo() : this.undo();
    else if (ctrl && k.toLowerCase() === 'y') this.redo();
    else if (ctrl && k.toLowerCase() === 'a') this.select(this.doc.entities.filter((x) => this.usable(x)).map((x) => x.id));
    else if (ctrl && k.toLowerCase() === 'c') this.copy();
    else if (ctrl && k.toLowerCase() === 'v') this.paste();
    else if (ctrl && k.toLowerCase() === 'd') {
      this.copy();
      this.paste(0);
    } else if (ctrl) return;
    else if (k === 'Escape') {
      if (this.textDraft) {
        this.endText();
        this.pts = [];
        this.refreshPanels();
      } else if (this.pts.length) this.pts = [];
      else this.select([]);
    } else if (k === 'Enter') this.finish();
    else if (k === 'Delete' || k === 'Backspace') this.deleteSelection();
    else if (k.toLowerCase() === 'f') this.fit();
    else if (/^[0-9@.\-]$/.test(k) && this.tool !== 'select') {
      // start typing coordinates: hand over to the command box
      const cmd = this.els.cmd as HTMLInputElement;
      cmd.value = k;
      cmd.focus();
      cmd.setSelectionRange(1, 1);
    } else {
      const t = TOOLS.find((x) => x.key === k.toUpperCase());
      if (!t) return;
      this.setTool(t.id);
    }
    e.preventDefault();
    this.requestRender();
  }

  // ---- actions ------------------------------------------------------------------------------------

  private act(a: string, el: HTMLElement) {
    switch (a) {
      case 'textok':
        return void this.commitText();
      case 'textcancel':
        this.endText();
        this.pts = [];
        return this.refreshPanels();
      case 'loadfont':
        return void this.loadFont();
      case 'textedit': {
        const st = this.selectedText();
        if (!st) return;
        this.textDraft = { meta: structuredClone(st.meta), group: st.group };
        this.textPreview = [];
        this.refreshPanels();
        return this.updateTextPreview();
      }
      case 'textplain': {
        const st = this.selectedText();
        if (!st) return;
        for (const e of this.doc.entities) if (e.group === st.group) {
          delete e.text;
          delete e.group;
        }
        return this.commit('Text is now plain outlines');
      }
      case 'undo':
        return this.undo();
      case 'redo':
        return this.redo();
      case 'fit':
        return this.fit();
      case 'import':
        return void this.importFile();
      case 'dxf':
      case 'svg':
        return void this.exportFile(a);
      case 'addlayer': {
        const id = newId();
        const n = this.doc.layers.length;
        this.doc.layers.push({ id, name: `Layer ${n + 1}`, color: LAYER_COLORS[n % LAYER_COLORS.length], visible: true, locked: false });
        this.layerId = id;
        return this.commit('');
      }
      case 'dellayer': {
        const id = el.closest<HTMLElement>('[data-lid]')!.dataset.lid!;
        if (this.doc.entities.some((x) => x.layer === id)) return this.say('That layer still has items on it');
        if (this.doc.layers.length < 2) return;
        this.doc.layers = this.doc.layers.filter((l) => l.id !== id);
        if (this.layerId === id) this.layerId = this.doc.layers[0].id;
        return this.commit('');
      }
      case 'tolayer':
        for (const x of this.selected()) x.layer = this.layerId;
        return this.commit('Moved to the current layer');
      case 'delete':
        return this.deleteSelection();
      case 'join': {
        const { joined, used } = joinShapes(this.selected(), 0.01);
        if (!joined.length) return this.say('Nothing to join: the ends must meet');
        this.doc.entities = this.doc.entities.filter((x) => !used.has(x.id)).concat(joined);
        this.select(joined.map((j) => j.id));
        return this.commit(`Joined ${used.size} items into ${joined.length}`);
      }
      case 'offset': {
        const d = parseLen(this.val('offset'));
        if (d === null || d === 0) return this.say('Type an offset distance');
        const outward = el.dataset.dir !== 'in';
        const closed = this.selected().filter((x) => x.kind === 'circle' || (x.kind === 'poly' && x.closed));
        if (!closed.length) return this.say('Offset needs closed shapes (circles, closed polylines)');
        const res = offsetShapes(closed, outward ? Math.abs(d) : -Math.abs(d), 0.005, (this.val('corners') as 'round') || 'round');
        if (!res.length) return this.say('Nothing left after that offset');
        const es = this.add(res, closed[0].layer);
        this.select(es.map((x) => x.id));
        return this.commit(`Offset ${outward ? 'out' : 'in'} ${fmtLen(Math.abs(d))} ${getUnits()}`);
      }
      case 'bool': {
        const op = el.dataset.op as BoolOp;
        const s = this.selected().filter((x) => x.kind === 'circle' || (x.kind === 'poly' && x.closed));
        if (s.length < 2) return this.say('Select two or more closed shapes (the first one picked is kept for Subtract)');
        const [first, ...rest] = s;
        const res = op === 'union' ? booleanShapes('union', s, []) : booleanShapes(op, [first], rest);
        const used = new Set(s.map((x) => x.id));
        this.doc.entities = this.doc.entities.filter((x) => !used.has(x.id));
        const es = this.add(res, first.layer);
        this.select(es.map((x) => x.id));
        return this.commit(`${op[0].toUpperCase() + op.slice(1)}: ${es.length} shape${es.length === 1 ? '' : 's'}`);
      }
      case 'move':
      case 'copy': {
        const dx = parseLen(this.val('dx')), dy = parseLen(this.val('dy'));
        if (dx === null || dy === null) return this.say('Type the distances to move');
        if (a === 'copy') {
          const es = this.add(this.selected().map((x) => transformShape(x, translate(dx, dy))), undefined);
          this.select(es.map((x) => x.id));
          return this.commit('Copied');
        }
        return this.transformSelection(translate(dx, dy), 'Moved');
      }
      case 'rotate': {
        const ang = parseAngle(this.val('angle'));
        if (ang === null) return this.say('Type an angle in degrees');
        return this.transformSelection(rotateAbout(this.selCenter(), ang), `Rotated ${this.val('angle')}°`);
      }
      case 'scale': {
        const k = parseFloat(this.val('scale')) / 100;
        if (!(k > 0)) return this.say('Type a scale in %');
        return this.transformSelection(scaleAbout(this.selCenter(), k), `Scaled ${this.val('scale')}%`);
      }
      case 'mirror':
        return this.transformSelection(mirrorAcross(this.selCenter(), el.dataset.axis === 'h' ? Math.PI / 2 : 0), 'Mirrored');
    }
  }

  private val(name: string) {
    return (this.root.querySelector<HTMLInputElement>(`[data-in="${name}"]`)?.value ?? '').trim();
  }

  private selCenter(): Pt {
    let b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const x of this.selected()) b = shapeBox(x, b);
    return boxValid(b) ? { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 } : { x: 0, y: 0 };
  }

  private transformSelection(m: Xform, msg: string) {
    const ids = new Set(this.selected().filter((x) => this.usable(x)).map((x) => x.id));
    if (!ids.size) return this.say('Select something first');
    const det = m.a * m.d - m.b * m.c, k = Math.sqrt(Math.abs(det)), rot = (Math.atan2(m.b, m.a) * 180) / Math.PI;
    let unlinked = false;
    this.doc.entities = this.doc.entities.map((x) => {
      if (!ids.has(x.id)) return x;
      const t = transformShape(x, m);
      if (t.text) {
        if (det < 0) {
          // mirrored lettering can't be made from the font again: it becomes plain outlines
          delete t.text;
          unlinked = true;
        } else t.text = { ...t.text, at: { x: m.a * t.text.at.x + m.c * t.text.at.y + m.e, y: m.b * t.text.at.x + m.d * t.text.at.y + m.f }, angle: t.text.angle + rot, height: t.text.height * k, spacing: t.text.spacing * k, arc: (t.text.arc ?? 0) * k };
      }
      return t;
    });
    this.commit(unlinked ? `${msg}; mirrored text is now plain outlines` : msg);
  }

  // ---- text ---------------------------------------------------------------------------------------

  private endText() {
    this.textDraft = null;
    this.textPreview = [];
    clearTimeout(this.textTimer);
  }

  private async makeText(meta: TextMeta): Promise<Shape[]> {
    if (!this.fonts) throw new Error('fonts are not loaded yet');
    return textOutlines(await this.fonts.get(meta.font), meta);
  }

  private updateTextPreview() {
    clearTimeout(this.textTimer);
    const d = this.textDraft;
    if (!d) return;
    this.textTimer = setTimeout(async () => {
      try {
        const shapes = await this.makeText(d.meta);
        if (this.textDraft === d) {
          this.textPreview = shapes;
          this.requestRender();
        }
      } catch (err) {
        this.say(`Text: ${(err as Error).message}`);
      }
    }, 120);
  }

  /** the text group the selection is exactly made of, if any */
  private selectedText(): { group: string; meta: TextMeta } | null {
    const s = this.selected();
    const g = s[0]?.group;
    if (!g || !s[0].text || !s.every((e) => e.group === g)) return null;
    return { group: g, meta: s[0].text };
  }

  private async commitText() {
    const d = this.textDraft;
    if (!d) return;
    if (!d.meta.text.trim()) return this.say('Type some text first');
    try {
      const shapes = await this.makeText(d.meta);
      if (!shapes.length) return this.say('That text has no outlines in this font');
      const group = d.group ?? newId();
      const old = d.group ? this.doc.entities.filter((e) => e.group === d.group) : [];
      const layer = old[0]?.layer ?? this.layerId;
      this.doc.entities = this.doc.entities.filter((e) => e.group !== group || !d.group);
      const es = shapes.map((sh) => ({ ...entity(sh, layer), group, text: structuredClone(d.meta) }) as Entity);
      this.doc.entities.push(...es);
      this.lastFont = d.meta.font;
      this.endText();
      this.pts = [];
      if (this.tool === 'text') this.setTool('select');
      this.select(es.map((e) => e.id));
      this.commit(`${old.length ? 'Updated' : 'Added'} text: ${es.length} outline${es.length === 1 ? '' : 's'}`);
    } catch (err) {
      this.say(`Text: ${(err as Error).message}`);
    }
  }

  private async loadFont() {
    if (!this.fonts) return;
    try {
      const f = await openBinaryFile('font');
      if (!f) return;
      const id = await this.fonts.add(f.name, f.data);
      this.fontList = await this.fonts.list();
      if (this.textDraft) {
        this.textDraft.meta.font = id;
        this.updateTextPreview();
      }
      this.refreshPanels();
      this.say(`Loaded ${f.name}; it stays in this browser`);
    } catch (err) {
      this.say(`Couldn't load the font: ${(err as Error).message}`);
    }
  }

  private textField(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
    const d = this.textDraft;
    if (!d) return;
    const f = el.dataset.text!;
    const m = d.meta;
    if (f === 'text') m.text = el.value;
    else if (f === 'font') {
      m.font = el.value;
      el.closest('.textform')?.querySelector<HTMLElement>('.strokehint')?.toggleAttribute('hidden', !m.font.startsWith('line:'));
    } else if (f === 'align') m.align = el.value as TextMeta['align'];
    else if (f === 'angle') m.angle = parseFloat(el.value) || 0;
    else if (f === 'lineSpacing') m.lineSpacing = Math.max(0.5, parseFloat(el.value) || 1.6);
    else if (f === 'arcSide') m.arcSide = el.value as 'top' | 'bottom';
    else {
      const v = parseLen(el.value);
      if (v === null) return;
      if (f === 'height' && v > 0) m.height = v;
      else if (f === 'spacing') m.spacing = v;
      else if (f === 'arc' && v >= 0) m.arc = v;
      else if (f === 'x') m.at = { ...m.at, x: v };
      else if (f === 'y') m.at = { ...m.at, y: v };
    }
    this.updateTextPreview();
  }

  private textForm(): string {
    const d = this.textDraft!;
    const m = d.meta, L = (mm: number) => fmtLen(mm);
    const fonts: FontEntry[] = this.fontList.length ? this.fontList : [{ id: m.font, name: m.font, single: m.font.startsWith('line:') }];
    const opts = (single: boolean) => fonts.filter((f) => f.single === single).map((f) => `<option value="${esc(f.id)}"${f.id === m.font ? ' selected' : ''}>${esc(f.name)}</option>`).join('');
    const single = m.font.startsWith('line:');
    return `<div class="textform">
  <h3>${d.group ? 'Edit text' : 'New text'}</h3>
  <textarea data-text="text" rows="2" spellcheck="false">${esc(m.text)}</textarea>
  <label>Font <select data-text="font"><optgroup label="Outline fonts (V-carve, pocket, profile)">${opts(false)}</optgroup><optgroup label="Single-line fonts (Engrave)">${opts(true)}</optgroup></select></label>
  <p class="hint strokehint"${single ? '' : ' hidden'}>Single-line font: the letters are centre lines, for an Engrave toolpath.</p>
  <button data-act="loadfont" title="Use a TTF, OTF or WOFF font file from your computer">Load font…</button>
  <div class="grid2">
    <label title="Height of the capital letters">Height <input data-text="height" value="${L(m.height)}"></label>
    <label title="Extra space between letters">Spacing <input data-text="spacing" value="${L(m.spacing)}"></label>
    <label>Align <select data-text="align">${(['left', 'center', 'right'] as const).map((a) => `<option value="${a}"${a === m.align ? ' selected' : ''}>${a}</option>`).join('')}</select></label>
    <label title="Degrees, counter-clockwise">Angle° <input data-text="angle" value="${+m.angle.toFixed(2)}"></label>
    <label title="Baseline start (left), middle (center) or end (right)">X <input data-text="x" value="${L(m.at.x)}"></label>
    <label>Y <input data-text="y" value="${L(m.at.y)}"></label>
    <label title="Distance between lines, × the letter height">Lines <input data-text="lineSpacing" value="${m.lineSpacing}"></label>
    <label title="Bend the text round a circle of this radius; 0 = straight">Arc radius <input data-text="arc" value="${L(m.arc ?? 0)}"></label>
    <label title="Over the top of the circle (an arch) or under it (a smile)">Arc <select data-text="arcSide"><option value="top"${m.arcSide !== 'bottom' ? ' selected' : ''}>over the top</option><option value="bottom"${m.arcSide === 'bottom' ? ' selected' : ''}>under the bottom</option></select></label>
  </div>
  <p class="hint">On an arc, X, Y is the point on the curve the alignment refers to (its middle when centred).</p>
  <div class="row"><button data-act="textok" class="primary">${d.group ? 'Update text' : 'Add text'}</button><button data-act="textcancel">Cancel</button></div>
</div>`;
  }

  private deleteSelection() {
    const ids = new Set(this.selected().filter((x) => this.usable(x)).map((x) => x.id));
    if (!ids.size) return;
    this.doc.entities = this.doc.entities.filter((x) => !ids.has(x.id));
    this.commit(`Deleted ${ids.size}`);
  }

  private copy() {
    this.clipboard = structuredClone(this.selected());
    if (this.clipboard.length) this.say(`Copied ${this.clipboard.length}`);
  }

  /** pastes the clipboard, shifted right/up by `shift` mm (default 10) */
  private paste(shift = 10) {
    if (!this.clipboard.length) return;
    const es = this.clipboard.map((x) => ({ ...transformShape(x, translate(shift, shift)), id: newId(), layer: this.layer(x.layer) ? x.layer : this.layerId }) as Entity);
    this.doc.entities.push(...es);
    this.select(es.map((x) => x.id));
    this.commit(`Pasted ${es.length}`);
  }

  private async importFile() {
    try {
      const f = await openTextFile('drawing');
      if (!f) return;
      const isSvg = /\.svg$/i.test(f.name) || /^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg/i.test(f.text);
      let shapes: { shape: Shape; layer: string }[];
      let note = '';
      if (isSvg) {
        const r = parseSvg(f.text);
        shapes = r.shapes;
        note = skippedNote(r.skipped);
      } else {
        const r = parseDxf(f.text);
        let k = r.toMm;
        if (!r.units) {
          const ans = prompt(`${f.name} doesn't say what units it is in. Type mm or in:`, getUnits());
          if (ans === null) return;
          k = /^\s*in/i.test(ans) ? 25.4 : 1;
        }
        shapes = k === 1 ? r.shapes : r.shapes.map((s) => ({ ...s, shape: transformShape(s.shape, scaleAbout({ x: 0, y: 0 }, k)) }));
        note = skippedNote(r.skipped);
      }
      if (!shapes.length) return this.say(`No drawing found in ${f.name}${note}`);
      // file layers → drawing layers (by name, created when missing)
      const byName = new Map(this.doc.layers.map((l) => [l.name, l.id]));
      const es: Entity[] = [];
      for (const s of shapes) {
        let id = byName.get(s.layer);
        if (!id) {
          id = newId();
          const n = this.doc.layers.length;
          this.doc.layers.push({ id, name: s.layer, color: LAYER_COLORS[n % LAYER_COLORS.length], visible: true, locked: false });
          byName.set(s.layer, id);
        }
        es.push(...this.add([s.shape], id));
      }
      this.select(es.map((x) => x.id));
      this.commit(`Imported ${es.length} items from ${f.name}${note}`);
      this.fit();
    } catch (err) {
      this.say(`Couldn't import: ${(err as Error).message}`);
    }
  }

  private async exportFile(kind: 'dxf' | 'svg') {
    const items = (this.sel.size ? this.selected() : this.doc.entities.filter((x) => this.layer(x.layer)?.visible)).map((x) => ({ shape: x as Shape, layer: this.layer(x.layer)?.name ?? '0', color: this.layer(x.layer)?.color }));
    if (!items.length) return this.say('Nothing to export');
    const text = kind === 'dxf' ? writeDxf(items, getUnits()) : writeSvg(items);
    try {
      const h = await saveTextFile(kind, `drawing.${kind}`, text);
      if (h !== null) this.say(`Exported ${items.length} items${h ? ` to ${h.name}` : ''}`);
    } catch (err) {
      this.say(`Couldn't export: ${(err as Error).message}`);
    }
  }

  // ---- side panels --------------------------------------------------------------------------------

  private layerChange(el: HTMLInputElement) {
    const id = el.closest<HTMLElement>('[data-lid]')!.dataset.lid!;
    const l = this.layer(id);
    if (!l) return;
    const f = el.dataset.layer;
    if (f === 'current') this.layerId = id;
    else if (f === 'color') l.color = el.value;
    else if (f === 'visible') l.visible = el.checked;
    else if (f === 'locked') l.locked = el.checked;
    else if (f === 'name') l.name = el.value.trim() || l.name;
    if (f !== 'current') this.commit();
    else this.refreshPanels();
    this.requestRender();
  }

  private propChange(el: HTMLInputElement) {
    const f = el.dataset.prop!;
    const v = f.endsWith('deg') ? parseAngle(el.value) : parseLen(el.value);
    if (v === null) return this.refreshPanels();
    const s = this.selected();
    if (f === 'bx' || f === 'by' || f === 'bw' || f === 'bh') {
      let b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const x of s) b = shapeBox(x, b);
      if (!boxValid(b)) return;
      if (f === 'bx') return this.transformSelection(translate(v - b.x0, 0), 'Moved');
      if (f === 'by') return this.transformSelection(translate(0, v - b.y0), 'Moved');
      const cur = f === 'bw' ? b.x1 - b.x0 : b.y1 - b.y0;
      if (!(v > 0) || cur < 1e-9) return this.refreshPanels();
      return this.transformSelection(scaleAbout({ x: b.x0, y: b.y0 }, v / cur), 'Resized (keeping proportions)');
    }
    if (s.length !== 1) return;
    const e = s[0];
    if (e.kind === 'line') {
      if (f === 'x1') e.a.x = v; else if (f === 'y1') e.a.y = v; else if (f === 'x2') e.b.x = v; else if (f === 'y2') e.b.y = v;
      else if (f === 'len') {
        const d = sub(e.b, e.a), l = Math.hypot(d.x, d.y) || 1;
        e.b = { x: e.a.x + (d.x / l) * v, y: e.a.y + (d.y / l) * v };
      }
    } else if (e.kind === 'circle') {
      if (f === 'cx') e.c.x = v; else if (f === 'cy') e.c.y = v; else if (f === 'dia' && v > 0) e.r = v / 2;
    } else if (e.kind === 'arc') {
      if (f === 'cx') e.c.x = v; else if (f === 'cy') e.c.y = v; else if (f === 'r' && v > 0) e.r = v;
      else if (f === 'a0deg') e.a0 = v; else if (f === 'a1deg') e.a1 = v;
    }
    this.commit('');
    this.requestRender();
  }

  private refreshPanels() {
    const u = getUnits();
    const L = (mm: number) => fmtLen(mm, u);
    // layers
    this.els.layers.innerHTML = this.doc.layers
      .map(
        (l) => `<div class="layer" data-lid="${l.id}">
  <input type="radio" name="curlayer" data-layer="current" ${l.id === this.layerId ? 'checked' : ''} title="Draw on this layer">
  <input type="color" data-layer="color" value="${l.color}" title="Colour">
  <input data-layer="name" value="${esc(l.name)}" title="Name">
  <label title="Show"><input type="checkbox" data-layer="visible" ${l.visible ? 'checked' : ''}>👁</label>
  <label title="Lock (can't be selected or changed)"><input type="checkbox" data-layer="locked" ${l.locked ? 'checked' : ''}>🔒</label>
  <button data-act="dellayer" title="Delete the layer (must be empty)">✕</button>
</div>`,
      )
      .join('');
    // selection
    const s = this.selected();
    let html = '';
    if (this.textDraft && !this.textDraft.group) {
      this.els.props.innerHTML = this.textForm();
      this.requestRender();
      return;
    }
    const st = this.selectedText();
    if (st) html += this.textDraft?.group === st.group ? this.textForm() : `<div class="row"><button data-act="textedit" title="Change the wording, font or size">Edit text</button><button data-act="textplain" title="Keep the outlines, forget the text (needed before editing points)">To plain outlines</button></div>`;
    if (!s.length) html = `<p class="hint">Nothing selected. ${this.doc.entities.length} item${this.doc.entities.length === 1 ? '' : 's'} in the drawing.</p>`;
    else {
      let b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const x of s) b = shapeBox(x, b);
      const num = (prop: string, label: string, v: string, title = '') => `<label title="${title}">${label} <input data-prop="${prop}" value="${v}"></label>`;
      html += `<p>${s.length} selected${s.length === 1 ? `: ${kindName(s[0])}` : ''}</p>`;
      html += `<div class="grid2">${num('bx', 'X', L(b.x0), 'left edge')}${num('by', 'Y', L(b.y0), 'bottom edge')}${num('bw', 'W', L(b.x1 - b.x0), 'width (resizes, keeping proportions)')}${num('bh', 'H', L(b.y1 - b.y0), 'height (resizes, keeping proportions)')}</div>`;
      if (s.length === 1) {
        const e = s[0];
        if (e.kind === 'line') html += `<div class="grid2">${num('x1', 'X1', L(e.a.x))}${num('y1', 'Y1', L(e.a.y))}${num('x2', 'X2', L(e.b.x))}${num('y2', 'Y2', L(e.b.y))}${num('len', 'Length', L(dist(e.a, e.b)))}</div>`;
        else if (e.kind === 'circle') html += `<div class="grid2">${num('cx', 'CX', L(e.c.x))}${num('cy', 'CY', L(e.c.y))}${num('dia', 'Ø', L(2 * e.r))}</div>`;
        else if (e.kind === 'arc') html += `<div class="grid2">${num('cx', 'CX', L(e.c.x))}${num('cy', 'CY', L(e.c.y))}${num('r', 'R', L(e.r))}${num('a0deg', 'Start°', fmtDeg(e.a0))}${num('a1deg', 'End°', fmtDeg(e.a1))}</div>`;
        else if (e.kind === 'poly') html += `<p class="hint">${e.pts.length} points, ${e.closed ? 'closed' : 'open'}</p>`;
        else if (e.kind === 'dim') html += `<p class="hint">Length ${L(dist(e.a, e.b))} ${u}</p>`;
      }
      html += `
<div class="ops">
  <div class="row"><button data-act="join" title="Join lines/arcs whose ends meet into polylines">Join</button><button data-act="tolayer">To current layer</button><button data-act="delete">Delete</button></div>
  <div class="row">Offset <input data-in="offset" value="${u === 'in' ? '1/8' : '3'}" size="5"><select data-in="corners"><option value="round">round</option><option value="miter">sharp</option></select><button data-act="offset" data-dir="out">Out</button><button data-act="offset" data-dir="in">In</button></div>
  <div class="row"><button data-act="bool" data-op="union">Union</button><button data-act="bool" data-op="difference" title="First selected minus the others">Subtract</button><button data-act="bool" data-op="intersection">Intersect</button></div>
  <div class="row">Move <input data-in="dx" value="0" size="5"> , <input data-in="dy" value="0" size="5"><button data-act="move">Move</button><button data-act="copy">Copy</button></div>
  <div class="row">Rotate <input data-in="angle" value="90" size="4">°<button data-act="rotate">Rotate</button> Scale <input data-in="scale" value="100" size="4">%<button data-act="scale">Scale</button></div>
  <div class="row">Mirror <button data-act="mirror" data-axis="h" title="Flip left–right">↔</button><button data-act="mirror" data-axis="v" title="Flip top–bottom">↕</button></div>
</div>`;
    }
    this.els.props.innerHTML = html;
    this.requestRender();
  }
}

function rectShape(a: Pt, b: Pt): Shape {
  return { kind: 'poly', closed: true, pts: [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }] };
}

/** signed distance of c from the line a→b (+ = left) */
function dimOffset(a: Pt, b: Pt, c: Pt): number {
  const d = sub(b, a), l = Math.hypot(d.x, d.y) || 1;
  return (d.x * (c.y - a.y) - d.y * (c.x - a.x)) / l;
}

const fmtDeg = (r: number) => String(+((((r * 180) / Math.PI) % 360 + 360) % 360).toFixed(3));

const kindName = (e: Shape) => ({ line: 'line', arc: 'arc', circle: 'circle', poly: e.kind === 'poly' && e.closed ? 'closed polyline' : 'polyline', dim: 'dimension' })[e.kind];

function skippedNote(skipped: Record<string, number>): string {
  const k = Object.entries(skipped);
  return k.length ? ` (skipped ${k.map(([t, n]) => `${n} ${t}`).join(', ')})` : '';
}
