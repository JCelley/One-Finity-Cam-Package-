import { dimLine, dist, flatten, len, lerp, sub, type Pt, type Shape } from '../../cad/geom';
import type { CadDoc } from '../../cad/doc';
import type { Snap } from '../../cad/snap';
import { fmtLen, type Units } from '../units';
import { gridStep, type Viewport } from './viewport';

export interface Theme {
  bg: string;
  grid: string;
  gridMajor: string;
  axisX: string;
  axisY: string;
  stock: string;
  sel: string;
  preview: string;
  snap: string;
  text: string;
}

export function readTheme(el: Element): Theme {
  const cs = getComputedStyle(el);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return {
    bg: v('--canvas-bg', '#fff'),
    grid: v('--canvas-grid', '#eee'),
    gridMajor: v('--canvas-grid-major', '#ddd'),
    axisX: v('--canvas-axis-x', '#d33'),
    axisY: v('--canvas-axis-y', '#3a3'),
    stock: v('--canvas-stock', '#b88a4a'),
    sel: v('--canvas-sel', '#f2994a'),
    preview: v('--canvas-preview', '#9b51e0'),
    snap: v('--canvas-snap', '#eb5757'),
    text: v('--fg', '#222'),
  };
}

export interface Overlay {
  /** shapes being drawn (rubber band) */
  preview: Shape[];
  snap: Snap | null;
  /** selection box in screen px; dashed = crossing (right to left) */
  box: { x0: number; y0: number; x1: number; y1: number; crossing: boolean } | null;
  stock: { x: number; y: number } | null;
}

/** draws the whole view */
export function render(ctx: CanvasRenderingContext2D, w: number, h: number, vp: Viewport, doc: CadDoc, sel: Set<string>, ov: Overlay, th: Theme, units: Units) {
  ctx.save();
  ctx.fillStyle = th.bg;
  ctx.fillRect(0, 0, w, h);
  drawGrid(ctx, w, h, vp, th, units);
  if (ov.stock) {
    const a = vp.toScreen({ x: 0, y: 0 }), b = vp.toScreen({ x: ov.stock.x, y: ov.stock.y });
    ctx.fillStyle = th.stock + '22';
    ctx.strokeStyle = th.stock;
    ctx.lineWidth = 1.5;
    ctx.fillRect(a.x, b.y, b.x - a.x, a.y - b.y);
    ctx.strokeRect(a.x, b.y, b.x - a.x, a.y - b.y);
  }
  const tol = 0.5 / vp.scale;
  const layers = new Map(doc.layers.map((l) => [l.id, l]));
  // unselected first, selected on top
  for (const pass of [false, true])
    for (const e of doc.entities) {
      const l = layers.get(e.layer);
      if (!l?.visible || sel.has(e.id) !== pass) continue;
      drawShape(ctx, vp, e, pass ? th.sel : l.color, pass ? 2.5 : 1.5, tol, th, units, false);
    }
  for (const s of ov.preview) drawShape(ctx, vp, s, th.preview, 1.5, tol, th, units, true);
  if (ov.box) {
    const b = ov.box;
    ctx.setLineDash(b.crossing ? [5, 4] : []);
    ctx.strokeStyle = th.sel;
    ctx.fillStyle = th.sel + (b.crossing ? '18' : '28');
    ctx.lineWidth = 1;
    ctx.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    ctx.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    ctx.setLineDash([]);
  }
  if (ov.snap && ov.snap.kind !== 'grid') drawSnap(ctx, vp.toScreen(ov.snap.p), ov.snap.kind, th);
  ctx.restore();
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, vp: Viewport, th: Theme, units: Units) {
  const step = gridStep(vp.scale, units === 'in' ? 25.4 : 1);
  const major = step * 10;
  const a = vp.toWorld(0, h), b = vp.toWorld(w, 0);
  ctx.lineWidth = 1;
  for (const [s, color] of [[step, th.grid], [major, th.gridMajor]] as [number, string][]) {
    if (s * vp.scale < 6) continue;
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (let x = Math.ceil(a.x / s) * s; x <= b.x; x += s) {
      const X = Math.round(vp.toScreen({ x, y: 0 }).x) + 0.5;
      ctx.moveTo(X, 0);
      ctx.lineTo(X, h);
    }
    for (let y = Math.ceil(a.y / s) * s; y <= b.y; y += s) {
      const Y = Math.round(vp.toScreen({ x: 0, y }).y) + 0.5;
      ctx.moveTo(0, Y);
      ctx.lineTo(w, Y);
    }
    ctx.stroke();
  }
  const o = vp.toScreen({ x: 0, y: 0 });
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = th.axisX;
  ctx.beginPath();
  ctx.moveTo(o.x, o.y);
  ctx.lineTo(o.x + 40, o.y);
  ctx.stroke();
  ctx.strokeStyle = th.axisY;
  ctx.beginPath();
  ctx.moveTo(o.x, o.y);
  ctx.lineTo(o.x, o.y - 40);
  ctx.stroke();
}

function drawShape(ctx: CanvasRenderingContext2D, vp: Viewport, s: Shape, color: string, width: number, tol: number, th: Theme, units: Units, dashed: boolean) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dashed ? [6, 4] : []);
  if (s.kind === 'dim') {
    drawDim(ctx, vp, s, color, th, units);
    ctx.setLineDash([]);
    return;
  }
  const f = flatten(s, tol);
  if (f.pts.length) {
    ctx.beginPath();
    const p0 = vp.toScreen(f.pts[0]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < f.pts.length; i++) {
      const p = vp.toScreen(f.pts[i]);
      ctx.lineTo(p.x, p.y);
    }
    if (f.closed) ctx.closePath();
    ctx.stroke();
    // a single-point polyline (just started) shows as a dot
    if (f.pts.length === 1 || (f.pts.length === 2 && dist(f.pts[0], f.pts[1]) < 1e-9)) {
      ctx.fillStyle = color;
      ctx.fillRect(p0.x - 2, p0.y - 2, 4, 4);
    }
  }
  ctx.setLineDash([]);
}

function drawDim(ctx: CanvasRenderingContext2D, vp: Viewport, s: Extract<Shape, { kind: 'dim' }>, color: string, th: Theme, units: Units) {
  const [p, q] = dimLine(s);
  const A = vp.toScreen(s.a), B = vp.toScreen(s.b), P = vp.toScreen(p), Q = vp.toScreen(q);
  ctx.lineWidth = 1;
  ctx.beginPath();
  // extension lines with a small gap at the part, the dimension line with arrows
  const ext = (from: Pt, to: Pt) => {
    const d = sub(to, from), l = len(d);
    if (l < 1) return;
    const g = Math.min(3, l / 3);
    ctx.moveTo(from.x + (d.x / l) * g, from.y + (d.y / l) * g);
    ctx.lineTo(to.x + (d.x / l) * 4, to.y + (d.y / l) * 4);
  };
  ext(A, P);
  ext(B, Q);
  ctx.moveTo(P.x, P.y);
  ctx.lineTo(Q.x, Q.y);
  ctx.stroke();
  const arrow = (tip: Pt, from: Pt) => {
    const d = sub(from, tip), l = len(d) || 1, ux = d.x / l, uy = d.y / l;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x + ux * 8 - uy * 3, tip.y + uy * 8 + ux * 3);
    ctx.lineTo(tip.x + ux * 8 + uy * 3, tip.y + uy * 8 - ux * 3);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  arrow(P, Q);
  arrow(Q, P);
  const m = lerp(P, Q, 0.5);
  let ang = Math.atan2(Q.y - P.y, Q.x - P.x);
  if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
  ctx.save();
  ctx.translate(m.x, m.y);
  ctx.rotate(ang);
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const text = `${fmtLen(dist(s.a, s.b), units, units === 'in' ? 3 : 2)}${units === 'in' ? '"' : ''}`;
  ctx.fillStyle = th.bg;
  const tw = ctx.measureText(text).width;
  ctx.fillRect(-tw / 2 - 2, -16, tw + 4, 14);
  ctx.fillStyle = color === th.sel ? color : th.text;
  ctx.fillText(text, 0, -3);
  ctx.restore();
}

function drawSnap(ctx: CanvasRenderingContext2D, p: Pt, kind: string, th: Theme) {
  ctx.strokeStyle = th.snap;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const r = 6;
  if (kind === 'end') ctx.rect(p.x - r, p.y - r, 2 * r, 2 * r);
  else if (kind === 'mid') {
    ctx.moveTo(p.x, p.y - r);
    ctx.lineTo(p.x + r, p.y + r);
    ctx.lineTo(p.x - r, p.y + r);
    ctx.closePath();
  } else if (kind === 'center') ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  else if (kind === 'quadrant') {
    ctx.moveTo(p.x, p.y - r);
    ctx.lineTo(p.x + r, p.y);
    ctx.lineTo(p.x, p.y + r);
    ctx.lineTo(p.x - r, p.y);
    ctx.closePath();
  } else {
    ctx.moveTo(p.x - r, p.y - r);
    ctx.lineTo(p.x + r, p.y + r);
    ctx.moveTo(p.x + r, p.y - r);
    ctx.lineTo(p.x - r, p.y + r);
  }
  ctx.stroke();
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = th.snap;
  ctx.fillText(kind, p.x + 9, p.y - 8);
}
