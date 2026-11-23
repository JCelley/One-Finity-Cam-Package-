import { arcBulge, ends, near, polar, type Pt, type Shape, type Vertex } from './geom';

/**
 * The drawing: entities on layers. Plain data (JSON-safe) so it goes straight into the job file
 * (`JobFile.cad`) and the undo history is just snapshots.
 */
export type Entity = Shape & { id: string; layer: string };

export interface Layer {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  locked: boolean;
}

export interface CadDoc {
  version: 1;
  layers: Layer[];
  entities: Entity[];
}

let seq = 0;
export const newId = () => `e${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const DEFAULT_LAYER: Layer = { id: 'L0', name: 'Layer 1', color: '#2f80ed', visible: true, locked: false };

export const emptyDoc = (): CadDoc => ({ version: 1, layers: [{ ...DEFAULT_LAYER }], entities: [] });

export const entity = (s: Shape, layer = DEFAULT_LAYER.id): Entity => ({ ...structuredClone(s), id: newId(), layer });

/** checks a value read from a job file; returns an empty drawing for null (new job) */
export function readDoc(v: unknown): CadDoc {
  if (v === null || v === undefined) return emptyDoc();
  const d = v as CadDoc;
  if (typeof d !== 'object' || d.version !== 1 || !Array.isArray(d.layers) || !Array.isArray(d.entities)) throw new Error('the drawing in this job is not readable');
  if (!d.layers.length) d.layers.push({ ...DEFAULT_LAYER });
  const ids = new Set(d.layers.map((l) => l.id));
  for (const e of d.entities) {
    if (!['line', 'arc', 'circle', 'poly', 'dim'].includes(e.kind)) throw new Error(`unknown drawing item '${e.kind}'`);
    if (!ids.has(e.layer)) e.layer = d.layers[0].id;
    if (!e.id) e.id = newId();
  }
  return d;
}

/**
 * Undo / redo by snapshots. `commit` records the document as it is now, after a change; there is
 * a cap so a long session does not grow without limit.
 */
export class History {
  private past: string[] = [];
  private future: string[] = [];
  private current: string;
  constructor(doc: CadDoc, private limit = 200) {
    this.current = JSON.stringify(doc);
  }
  commit(doc: CadDoc) {
    const s = JSON.stringify(doc);
    if (s === this.current) return false;
    this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.current = s;
    this.future = [];
    return true;
  }
  undo(): CadDoc | null {
    const s = this.past.pop();
    if (s === undefined) return null;
    this.future.push(this.current);
    this.current = s;
    return JSON.parse(s);
  }
  redo(): CadDoc | null {
    const s = this.future.pop();
    if (s === undefined) return null;
    this.past.push(this.current);
    this.current = s;
    return JSON.parse(s);
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
}

/** a line / arc / open polyline as polyline vertices from its start to its end */
function asVertices(s: Shape): Vertex[] {
  if (s.kind === 'line') return [{ ...s.a }, { ...s.b }];
  if (s.kind === 'arc') {
    const p = polar(s.c, s.r, s.a0), q = polar(s.c, s.r, s.a1);
    return [{ ...p, b: arcBulge(p, q, s.c, true) }, q];
  }
  if (s.kind === 'poly') return s.pts.map((v) => ({ ...v }));
  return [];
}

function reverseVertices(v: Vertex[]): Vertex[] {
  const out: Vertex[] = [];
  for (let i = v.length - 1; i >= 0; i--) out.push({ x: v[i].x, y: v[i].y, b: i > 0 && v[i - 1].b ? -v[i - 1].b! : 0 });
  for (const p of out) if (!p.b) delete p.b;
  return out;
}

/**
 * Joins lines, arcs and open polylines whose ends meet (within `tol` mm) into polylines, closing
 * the ones that come back to their start. Returns the new shapes and the ids that were used up.
 * Shapes that join with nothing are left alone.
 */
export function joinShapes(items: Entity[], tol = 0.01): { joined: Entity[]; used: Set<string> } {
  const open = items.filter((e) => ends(e) !== null);
  const left = new Map(open.map((e) => [e.id, e]));
  const joined: Entity[] = [];
  const used = new Set<string>();
  for (const start of open) {
    if (!left.has(start.id)) continue;
    left.delete(start.id);
    let chain = asVertices(start);
    let count = 1;
    const ids = [start.id];
    // grow at the end, then at the start
    for (const atEnd of [true, false]) {
      for (;;) {
        const tip: Pt = atEnd ? chain[chain.length - 1] : chain[0];
        let found: Entity | null = null, flip = false;
        for (const e of left.values()) {
          const [a, b] = ends(e)!;
          if (near(a, tip, tol)) { found = e; flip = !atEnd; break; }
          if (near(b, tip, tol)) { found = e; flip = atEnd; break; }
        }
        if (!found) break;
        left.delete(found.id);
        ids.push(found.id);
        count++;
        let v = asVertices(found);
        if (flip) v = reverseVertices(v);
        if (atEnd) {
          chain[chain.length - 1].b = v[0].b;
          if (!chain[chain.length - 1].b) delete chain[chain.length - 1].b;
          chain = chain.concat(v.slice(1));
        } else {
          chain = v.slice(0, -1).concat(chain);
        }
        if (near(chain[0], chain[chain.length - 1], tol)) break;
      }
      if (near(chain[0], chain[chain.length - 1], tol) && chain.length > 2) break;
    }
    if (count < 2 && !(chain.length > 2 && near(chain[0], chain[chain.length - 1], tol))) continue;
    const closed = chain.length > 2 && near(chain[0], chain[chain.length - 1], tol);
    if (closed) chain.pop();
    for (const id of ids) used.add(id);
    joined.push({ kind: 'poly', pts: chain, closed, id: newId(), layer: start.layer });
  }
  return { joined, used };
}
