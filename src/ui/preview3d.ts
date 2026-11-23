import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { flatten } from '../cad/geom';
import type { CadDoc } from '../cad/doc';
import { SEG_CUT, SEG_PLUNGE, SEG_RAPID, type PreviewPath } from '../cam/preview';

/**
 * 3D view of the stock, the drawing on its top face and the toolpaths. Machine coordinates
 * (Z up). Renders on demand only (when something changes or the view is moved).
 */
export class Preview3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.5, 20000);
  private controls: OrbitControls;
  private stockGroup = new THREE.Group();
  private drawGroup = new THREE.Group();
  private pathGroup = new THREE.Group();
  private queued = false;
  private fitted = false;
  private box = new THREE.Box3();

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    host.appendChild(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.request());
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(0.4, -0.6, 1);
    this.scene.add(sun, this.stockGroup, this.drawGroup, this.pathGroup);
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  private resize() {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this.fitted && w > 10 && h > 10 && !this.box.isEmpty()) this.fit();
    this.request();
  }

  private request() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.renderer.render(this.scene, this.camera);
    });
  }

  private clear(g: THREE.Group) {
    for (const o of [...g.children]) {
      g.remove(o);
      o.traverse((x) => {
        const m = x as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((q) => q.dispose());
        else mat?.dispose();
      });
    }
  }

  /** stock from (0,0,zTop−thickness) to (x,y,zTop) and the drawing on its top */
  setScene(stock: { x: number; y: number; z: number }, zTop: number, doc: CadDoc, highlight: Set<string>) {
    this.clear(this.stockGroup);
    this.clear(this.drawGroup);
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const geo = new THREE.BoxGeometry(stock.x, stock.y, stock.z);
    geo.translate(stock.x / 2, stock.y / 2, zTop - stock.z / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xc9a06a, transparent: true, opacity: 0.28, depthWrite: false }));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xb8864a }));
    this.stockGroup.add(mesh, edges);
    // axes at the work origin
    const ax = (to: [number, number, number], c: number) => new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, zTop), new THREE.Vector3(...to)]), new THREE.LineBasicMaterial({ color: c }));
    const L = Math.max(10, Math.min(stock.x, stock.y) * 0.15);
    this.stockGroup.add(ax([L, 0, zTop], 0xdd3333), ax([0, L, zTop], 0x2a9d3a), ax([0, 0, zTop + L], 0x2f80ed));
    const layers = new Map(doc.layers.map((l) => [l.id, l]));
    for (const e of doc.entities) {
      const l = layers.get(e.layer);
      if (!l?.visible || e.kind === 'dim') continue;
      const f = flatten(e, 0.1);
      const pts = f.pts.map((p) => new THREE.Vector3(p.x, p.y, zTop + 0.02));
      if (f.closed && pts.length) pts.push(pts[0].clone());
      const hl = highlight.has(e.id);
      this.drawGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: hl ? 0xf2994a : dark ? 0x8a8a96 : 0x555560 })));
    }
    this.box.set(new THREE.Vector3(0, 0, zTop - stock.z), new THREE.Vector3(stock.x, stock.y, zTop));
    if (!this.fitted) this.fit();
    this.request();
  }

  /** toolpaths; `active[i]` = show path i bright (the rest dimmed); null = all bright */
  setPaths(paths: PreviewPath[], active: boolean[] | null, showRapids: boolean) {
    this.clear(this.pathGroup);
    const colors: Record<number, [number, number, number]> = { [SEG_CUT]: [0.18, 0.5, 0.93], [SEG_PLUNGE]: [0.61, 0.32, 0.88], [SEG_RAPID]: [0.95, 0.55, 0.2] };
    paths.forEach((p, i) => {
      const dim = active !== null && !active[i];
      const n = p.kind.length;
      let keep = 0;
      for (let k = 0; k < n; k++) if (showRapids || p.kind[k] !== SEG_RAPID) keep++;
      const pos = new Float32Array(keep * 6), col = new Float32Array(keep * 6);
      let j = 0;
      for (let k = 0; k < n; k++) {
        if (!showRapids && p.kind[k] === SEG_RAPID) continue;
        pos.set(p.pos.subarray(k * 6, k * 6 + 6), j * 6);
        const c = colors[p.kind[k]];
        const f = dim ? 0.35 : 1;
        for (let v = 0; v < 2; v++) col.set([c[0] * f + (1 - f) * 0.5, c[1] * f + (1 - f) * 0.5, c[2] * f + (1 - f) * 0.5], j * 6 + v * 3);
        j++;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: dim, opacity: dim ? 0.5 : 1 }));
      line.renderOrder = dim ? 0 : 1;
      this.pathGroup.add(line);
    });
    this.request();
  }

  /** camera distance at which a w × h area (mm) fills the view, with a margin */
  private fitDistance(w: number, h: number) {
    const t = Math.tan((this.camera.fov * Math.PI) / 360);
    return Math.max(h / 2 / t, w / 2 / (t * this.camera.aspect)) * 1.12;
  }

  /** looks at the stock from the front, a bit to the left and above */
  fit() {
    if (this.box.isEmpty() || this.host.clientWidth < 10) return;
    const c = this.box.getCenter(new THREE.Vector3());
    const s = this.box.getSize(new THREE.Vector3());
    // seen at an angle in perspective the near corner looms larger: stand back further
    const d = this.fitDistance(Math.hypot(s.x, s.y), Math.max(s.y, s.z)) * 1.35;
    const dir = new THREE.Vector3(-0.3, -0.75, 0.6).normalize();
    this.camera.position.copy(c).addScaledVector(dir, d);
    this.controls.target.copy(c);
    this.controls.update();
    this.fitted = true;
    this.request();
  }

  view(dir: 'top' | 'front' | 'iso') {
    if (dir === 'iso') {
      this.fitted = false;
      return this.fit();
    }
    const c = this.box.getCenter(new THREE.Vector3());
    const s = this.box.getSize(new THREE.Vector3());
    if (dir === 'top') this.camera.position.set(c.x, c.y - 0.001, c.z + this.fitDistance(s.x, s.y));
    else this.camera.position.set(c.x, c.y - this.fitDistance(s.x, Math.max(s.z * 4, 20)) - s.y / 2, c.z);
    this.controls.target.copy(c);
    this.controls.update();
    this.request();
  }
}
