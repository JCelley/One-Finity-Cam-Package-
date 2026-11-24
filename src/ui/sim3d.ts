import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { toolRadiusAt } from '../core/heightfieldCam';
import type { MachineModel } from '../cam/machines';
import { segPoint, type Program, type V3 } from '../sim/gcode';
import type { Cutting, SimTool } from '../sim/simulate';

const C = {
  frame: 0x3b3f46,
  rail: 0x9aa0a8,
  board: 0xcdbb95,
  gantry: 0x2c2f35,
  plate: 0x80868f,
  router: 0x23262b,
  collet: 0xb8bcc2,
  flutes: 0xd7dadf,
  shank: 0x9fa4ab,
  stock: 0xd9b07a,
  cut: 0x2f80ed,
  rapid: 0xf2994a,
};

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number, opacity = 1) => {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, transparent: opacity < 1, opacity }));
};
const cyl = (r0: number, r1: number, h: number, color: number) => {
  const g = new THREE.CylinderGeometry(r1, r0, h, 32);
  g.rotateX(Math.PI / 2); // along Z
  g.translate(0, 0, h / 2);
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color }));
};

/**
 * The machine simulator's 3D view, in machine coordinates (mm, Z up): a schematic Onefinity sized
 * from its travel (bed, rails, X gantry, Z carriage, router, the tool), the stock as a heightfield
 * that gets cut, and the program's path. Renders on demand.
 */
export class Sim3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 1, 50000);
  private controls: OrbitControls;
  private fixed = new THREE.Group();
  private gantry = new THREE.Group();
  private carriage = new THREE.Group();
  private slide = new THREE.Group();
  private toolGroup = new THREE.Group();
  private stockGroup = new THREE.Group();
  private pathGroup = new THREE.Group();
  private stockMesh: THREE.Mesh | null = null;
  private skirt: THREE.Mesh | null = null;
  private cutting: Cutting | null = null;
  private queued = false;
  private stockBox = new THREE.Box3();
  private machineBox = new THREE.Box3();
  private fitted = false;
  private bedZ = 0;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    host.appendChild(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.request());
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 1);
    sun.position.set(0.3, -0.7, 1);
    this.scene.add(sun);
    this.gantry.add(this.carriage);
    this.carriage.add(this.slide);
    this.slide.add(this.toolGroup);
    this.scene.add(this.fixed, this.gantry, this.stockGroup, this.pathGroup);
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
    if (!this.fitted && w > 10 && h > 10 && !this.stockBox.isEmpty()) this.view('iso');
    this.request();
  }

  request() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.renderer.render(this.scene, this.camera);
    });
  }

  private static clear(g: THREE.Object3D, keep: THREE.Object3D[] = []) {
    for (const o of [...g.children]) {
      if (keep.includes(o)) continue;
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

  /** builds the machine: fixed frame and bed, and the moving gantry (Y), carriage (X) and slide (Z) */
  setMachine(m: MachineModel, bedZ: number) {
    this.bedZ = bedZ;
    Sim3D.clear(this.fixed);
    Sim3D.clear(this.gantry, [this.carriage]);
    Sim3D.clear(this.carriage, [this.slide]);
    Sim3D.clear(this.slide, [this.toolGroup]);
    const { x: tx, y: ty, z: tz } = m.travel;
    const H = tz + 10; // bed to the nose at the top
    const b = bedZ;
    // spoilboard and the frame under it
    this.fixed.add(box(-25, -25, b - 18, tx + 25, ty + 25, b, C.board));
    this.fixed.add(box(-70, -80, b - 70, tx + 70, -40, b - 18, C.frame), box(-70, ty + 40, b - 70, tx + 70, ty + 80, b - 18, C.frame));
    // the two Y rails, on the sides
    for (const x of [-55, tx + 55]) {
      this.fixed.add(box(x - 22, -80, b - 70, x + 22, ty + 80, b - 18, C.frame));
      const r = cyl(16, 16, ty + 160, C.rail);
      r.rotation.x = -Math.PI / 2;
      r.position.set(x, -80, b + 6);
      this.fixed.add(r);
    }
    // gantry (moves in Y): uprights on the rails and the X beam behind the tool
    const top = b + H; // nose height at the top of Z
    for (const x of [-55, tx + 55]) this.gantry.add(box(x - 18, 20, b - 8, x + 18, 150, top + 120, C.gantry));
    this.gantry.add(box(-73, 60, top + 10, tx + 73, 140, top + 120, C.gantry));
    const xr = cyl(12, 12, tx + 140, C.rail);
    xr.rotation.y = Math.PI / 2;
    xr.rotation.x = 0;
    xr.position.set(-70, 55, top + 95);
    this.gantry.add(xr);
    // X carriage (moves in X): the plate the Z axis rides on
    this.carriage.add(box(-55, 40, top - 40, 55, 58, top + 140, C.plate));
    // Z slide (moves in Z): router mount, router, collet nut
    this.slide.add(box(-45, 30, 30, 45, 40, 175, C.plate));
    const router = cyl(36, 36, 200, C.router);
    router.position.z = 25;
    const nut = cyl(11, 17, 25, C.collet);
    this.slide.add(router, nut);
    this.machineBox.set(new THREE.Vector3(-80, -90, b - 70), new THREE.Vector3(tx + 80, ty + 160, top + 240));
    this.request();
  }

  /** the tool in the spindle (its tip `len` below the nose); null = none */
  setTool(t: SimTool | null) {
    Sim3D.clear(this.toolGroup);
    if (!t) return this.request();
    const pts: THREE.Vector2[] = [new THREE.Vector2(0, 0)];
    const fl = Math.min(t.fluteLength, t.len - 2);
    const shank = Math.max(0.5, t.shank / 2);
    for (let k = 1; k <= 24; k++) {
      const h = (fl * k) / 24;
      pts.push(new THREE.Vector2(Math.max(0.05, Math.min(toolRadiusAt(t.cutter, h), Math.max(shank, t.cutter.diameter / 2))), h));
    }
    pts.push(new THREE.Vector2(0.01, fl));
    const flutes = new THREE.LatheGeometry(pts, 32);
    flutes.rotateX(Math.PI / 2);
    this.toolGroup.add(new THREE.Mesh(flutes, new THREE.MeshLambertMaterial({ color: C.flutes, side: THREE.DoubleSide })));
    const s = cyl(shank, shank, t.len - fl, C.shank);
    s.position.z = fl;
    this.toolGroup.add(s);
    this.toolGroup.position.z = -t.len;
    this.request();
  }

  /** puts the machine where the tip is (machine coordinates; the nose `len` above it) */
  setPosition(tip: V3, len: number) {
    this.gantry.position.y = tip.y;
    this.carriage.position.x = tip.x;
    this.slide.position.z = tip.z + len;
    this.toolGroup.position.z = -len;
    this.request();
  }

  /** the stock to draw (from the cutting state; call `updateStock` after it changes) */
  setStock(c: Cutting) {
    this.cutting = c;
    Sim3D.clear(this.stockGroup);
    const g = c.stock;
    const { nx, ny } = g;
    const { x0, y0 } = c.setup.stock;
    const pos = new Float32Array(nx * ny * 3);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        pos[k * 3] = x0 + i * g.dx;
        pos[k * 3 + 1] = y0 + j * g.dy;
      }
    const idx: number[] = [];
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        idx.push(a, a + 1, a + nx + 1, a, a + nx + 1, a + nx);
      }
    const top = new THREE.BufferGeometry();
    top.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    top.setIndex(idx);
    this.stockMesh = new THREE.Mesh(top, new THREE.MeshLambertMaterial({ color: C.stock }));
    // the sides: the edge of the top surface down to the bottom
    const ring: number[] = [];
    for (let i = 0; i < nx; i++) ring.push(i);
    for (let j = 1; j < ny; j++) ring.push(j * nx + nx - 1);
    for (let i = nx - 2; i >= 0; i--) ring.push((ny - 1) * nx + i);
    for (let j = ny - 2; j >= 0; j--) ring.push(j * nx);
    const sp = new Float32Array(ring.length * 6);
    const si: number[] = [];
    for (let q = 0; q < ring.length; q++) {
      const k = ring[q];
      sp.set([pos[k * 3], pos[k * 3 + 1], 0, pos[k * 3], pos[k * 3 + 1], g.bottom], q * 6);
      if (q < ring.length - 1) si.push(q * 2, q * 2 + 1, q * 2 + 3, q * 2, q * 2 + 3, q * 2 + 2);
    }
    const side = new THREE.BufferGeometry();
    side.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    side.setIndex(si);
    side.userData.ring = ring;
    this.skirt = new THREE.Mesh(side, new THREE.MeshLambertMaterial({ color: 0xc49a62, side: THREE.DoubleSide }));
    this.stockGroup.add(this.stockMesh, this.skirt);
    this.stockBox.set(new THREE.Vector3(x0, y0, g.bottom), new THREE.Vector3(x0 + c.setup.stock.x, y0 + c.setup.stock.y, g.top));
    this.updateStock();
    if (!this.fitted) this.view('iso');
  }

  /** copies the stock heights into the meshes */
  updateStock() {
    if (!this.cutting || !this.stockMesh || !this.skirt) return;
    const z = this.cutting.stock.z;
    const bottom = this.cutting.stock.bottom;
    const p = this.stockMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = p.array as Float32Array;
    // below the bottom (cut into the spoilboard) the stock is simply gone
    for (let k = 0; k < z.length; k++) a[k * 3 + 2] = Math.max(bottom, z[k]);
    p.needsUpdate = true;
    this.stockMesh.geometry.computeVertexNormals();
    const sp = this.skirt.geometry.getAttribute('position') as THREE.BufferAttribute;
    const ring = this.skirt.geometry.userData.ring as number[];
    const s = sp.array as Float32Array;
    for (let q = 0; q < ring.length; q++) s[q * 6 + 2] = Math.max(bottom, z[ring[q]]);
    sp.needsUpdate = true;
    this.skirt.geometry.computeVertexNormals();
    this.request();
  }

  /** the program's moves as lines: cuts blue, rapids orange */
  setPath(p: Program | null, rapids: boolean) {
    Sim3D.clear(this.pathGroup);
    if (!p) return this.request();
    for (const kind of ['cut', 'rapid'] as const) {
      if (kind === 'rapid' && !rapids) continue;
      const v: number[] = [];
      for (const s of p.segs) {
        if (s.kind === 'dwell' || s.kind === 'change' || (kind === 'rapid') !== (s.kind === 'rapid')) continue;
        const n = s.arc ? Math.max(2, Math.ceil(Math.abs(s.arc.sweep) * 12)) : 1;
        let a = s.from;
        for (let q = 1; q <= n; q++) {
          const b = s.arc ? segPoint(s, q / n) : s.to;
          v.push(a.x, a.y, a.z, b.x, b.y, b.z);
          a = b;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
      this.pathGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: kind === 'cut' ? C.cut : C.rapid, transparent: true, opacity: kind === 'cut' ? 0.55 : 0.45 })));
    }
    this.request();
  }

  showMachine(on: boolean) {
    this.fixed.visible = on;
    for (const o of [this.gantry, this.carriage, this.slide]) for (const c of o.children) if (c !== this.carriage && c !== this.slide && c !== this.toolGroup) c.visible = on;
    this.request();
  }

  private fitDistance(w: number, h: number) {
    const t = Math.tan((this.camera.fov * Math.PI) / 360);
    return Math.max(h / 2 / t, w / 2 / (t * this.camera.aspect)) * 1.12;
  }

  /** iso / top / front of the stock, or the whole machine */
  view(dir: 'iso' | 'top' | 'front' | 'machine') {
    const b = dir === 'machine' || this.stockBox.isEmpty() ? this.machineBox : this.stockBox;
    if (b.isEmpty() || this.host.clientWidth < 10) return;
    const c = b.getCenter(new THREE.Vector3());
    const s = b.getSize(new THREE.Vector3());
    if (dir === 'top') this.camera.position.set(c.x, c.y - 0.001, c.z + this.fitDistance(s.x, s.y) + s.z);
    else if (dir === 'front') this.camera.position.set(c.x, c.y - this.fitDistance(s.x, Math.max(s.z * 3, 30)) - s.y / 2, c.z + 1);
    else {
      const d = this.fitDistance(Math.hypot(s.x, s.y), Math.max(s.y, s.z)) * (dir === 'machine' ? 1.1 : 1.2);
      this.camera.position.copy(c).addScaledVector(new THREE.Vector3(-0.35, -0.8, 0.55).normalize(), d);
    }
    this.controls.target.copy(c);
    this.controls.update();
    this.fitted = true;
    this.request();
  }

  get bed() {
    return this.bedZ;
  }
}
