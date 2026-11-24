/**
 * G-code interpreter for the machine simulator: reads the posted file itself (what the MASSO will
 * run), not the CAM's own moves, and turns it into timed segments in machine coordinates.
 *
 * Machine coordinates (as in this simulator; a model of the MASSO setup, see CLAUDE.md for what is
 * still to confirm on the real machine):
 *  - X 0 at the left end of travel → `travel.x` at the right; Y 0 at the front → `travel.y` at the
 *    back; Z 0 at the top of Z travel → −`travel.z` at the bottom.
 *  - Z machine coordinates are those of the spindle nose. A tool sticks out `len` below it.
 *  - `G53` moves are in machine coordinates (Z of the nose, no tool length).
 *  - With a tool length offset active (`G43 H#`, or applied on `M6` when `tloOnM6`), a commanded
 *    work Z is where the tip of tool #H goes: nose = Z + offset.z + len(H).
 *    Without one, a commanded work Z is where the nose goes (the tip is `len` lower).
 *  - Work offsets give the machine X/Y of work X0 Y0 and the machine Z the tip of a measured tool
 *    is at when it is at work Z0.
 * Supported: G0 G1 G2 G3 (XY plane, I J incremental), G4 P (seconds), G17, G20/G21, G40, G49,
 * G43 H, G53, G54–G59, G80, G90, G94, M0/M1 (noted), M2/M30, M3/M4/M5 with S, T# M6, M7–M9 (ignored).
 */

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export type SegKind = 'rapid' | 'feed' | 'arc' | 'dwell' | 'change';

/** one timed piece of motion (or a pause); positions are of the tool tip, machine coordinates */
export interface Seg {
  /** 0-based line index in the file */
  line: number;
  kind: SegKind;
  from: V3;
  to: V3;
  /** arcs: centre (machine X/Y), clockwise, signed sweep (rad) and radius */
  arc?: { cx: number; cy: number; cw: boolean; sweep: number; r: number };
  /** path length (mm) */
  length: number;
  /** start and end times (s) */
  t0: number;
  t1: number;
  /** feed rate (mm/min) for feeds and arcs */
  feed: number;
  /** tool in the spindle (0 = none) and how far its tip sits below the nose (mm) */
  tool: number;
  len: number;
  /** spindle speed, 0 = stopped */
  rpm: number;
}

export interface GcodeIssue {
  line: number;
  text: string;
}

export interface Program {
  lines: string[];
  segs: Seg[];
  /** problems reading the file (unknown codes, missing feed, arcs that don't close…) */
  issues: GcodeIssue[];
  /** total time (s), no acceleration */
  duration: number;
  /** tools the file loads with M6, in order */
  tools: number[];
  /** where the tip starts (and the nose is at the top) */
  start: V3;
}

export interface WorkOffset {
  x: number;
  y: number;
  z: number;
}

export interface InterpOpts {
  /** G54…G59 → machine position of work zero (index 0 = G54); missing ones are all zeros */
  offsets: WorkOffset[];
  /** how far each tool's tip sits below the nose (mm), by tool number */
  toolLen: (tool: number) => number;
  /** rapid speed (mm/min) */
  rapid: number;
  /** the tool length is applied on M6 without G43 */
  tloOnM6?: boolean;
  /** starting machine X/Y of the nose (Z starts at the top) */
  home?: { x: number; y: number };
}

const RX_WORD = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;

/** the words of a line, comments removed; comments come back separately */
export function splitLine(raw: string): { words: [string, number][]; comment: string } {
  let comment = '';
  let s = raw.replace(/\(([^)]*)\)/g, (_, c: string) => {
    comment += (comment ? ' ' : '') + c.trim();
    return ' ';
  });
  const semi = s.indexOf(';');
  if (semi >= 0) {
    comment += (comment ? ' ' : '') + s.slice(semi + 1).trim();
    s = s.slice(0, semi);
  }
  s = s.toUpperCase();
  const words: [string, number][] = [];
  for (const m of s.matchAll(RX_WORD)) words.push([m[1], parseFloat(m[2])]);
  return { words, comment };
}

export function interpret(text: string, o: InterpOpts): Program {
  const lines = text.split(/\r?\n/);
  const segs: Seg[] = [];
  const issues: GcodeIssue[] = [];
  const tools: number[] = [];
  const issue = (line: number, t: string) => issues.push({ line, text: t });

  let mm = true; // G21
  let abs = true; // G90
  let motion = -1; // 0 1 2 3
  let wcs = 0;
  let feed = 0; // mm/min
  let rpm = 0, rpmSet = 0;
  let tool = 0, next = 0;
  let tlo: number | null = null; // tool number whose length is applied
  let t = 0;
  let ended = false;
  const off = (i: number) => o.offsets[i] ?? { x: 0, y: 0, z: 0 };
  const len = (n: number) => (n > 0 ? o.toolLen(n) : 0);
  // the nose, machine coordinates
  const nose: V3 = { x: o.home?.x ?? 0, y: o.home?.y ?? 0, z: 0 };
  const tip = (): V3 => ({ x: nose.x, y: nose.y, z: nose.z - len(tool) });
  const start = tip();

  /** a work position → nose machine position (with the current offset and tool length) */
  const toNose = (w: Partial<V3>): V3 => {
    const of = off(wcs);
    const n = { ...nose };
    if (w.x !== undefined) n.x = w.x + of.x;
    if (w.y !== undefined) n.y = w.y + of.y;
    if (w.z !== undefined) n.z = w.z + of.z + (tlo !== null ? len(tlo) : 0);
    return n;
  };
  /** current position in work coordinates (for G91 and arc centres) */
  const work = (): V3 => {
    const of = off(wcs);
    return { x: nose.x - of.x, y: nose.y - of.y, z: nose.z - of.z - (tlo !== null ? len(tlo) : 0) };
  };

  const push = (line: number, kind: SegKind, to: V3, length: number, dt: number, arc?: Seg['arc']) => {
    const from = tip();
    Object.assign(nose, to);
    segs.push({ line, kind, from, to: tip(), arc, length, t0: t, t1: t + dt, feed, tool, len: len(tool), rpm });
    t += dt;
  };

  for (let li = 0; li < lines.length && !ended; li++) {
    const { words } = splitLine(lines[li]);
    if (!words.length) continue;
    const gs: number[] = [];
    const ms: number[] = [];
    const val: Record<string, number> = {};
    for (const [l, v] of words) {
      if (l === 'G') gs.push(v);
      else if (l === 'M') ms.push(v);
      else if (l === 'N') continue;
      else {
        if (l in val) issue(li, `${l} appears twice on one line`);
        val[l] = v;
      }
    }
    let g53 = false;
    let dwell = false;
    for (const g of gs) {
      const r = Math.round(g * 10) / 10;
      if (r === 0 || r === 1 || r === 2 || r === 3) motion = r;
      else if (r === 4) dwell = true;
      else if (r === 17 || r === 40 || r === 80 || r === 94) continue;
      else if (r === 18 || r === 19) issue(li, `G${r}: only the XY plane (G17) is simulated`);
      else if (r === 20) mm = false;
      else if (r === 21) mm = true;
      else if (r === 43) tlo = val.H !== undefined ? Math.round(val.H) : tool;
      else if (r === 49) tlo = null;
      else if (r === 53) g53 = true;
      else if (r >= 54 && r <= 59 && Number.isInteger(r)) wcs = r - 54;
      else if (r === 90) abs = true;
      else if (r === 91) abs = false;
      else if (r === 93) issue(li, 'G93 inverse-time feed is not simulated');
      else issue(li, `G${r} is not simulated`);
    }
    const kk = mm ? 1 : 25.4; // a G20/G21 on this line applies to its own words
    if (val.F !== undefined) feed = val.F * kk;
    if (val.S !== undefined) {
      rpmSet = val.S;
      if (rpm > 0) rpm = rpmSet;
    }
    if (val.T !== undefined) next = Math.round(val.T);
    for (const m of ms) {
      if (m === 3 || m === 4) {
        rpm = rpmSet;
        if (!(rpm > 0)) issue(li, `M${m} with no spindle speed (S)`);
      } else if (m === 5) rpm = 0;
      else if (m === 6) {
        if (!next) issue(li, 'M6 with no tool number (T)');
        tool = next;
        tools.push(tool);
        if (o.tloOnM6) tlo = tool;
        else if (tlo !== null && tlo !== tool) tlo = null;
        // the change itself: shown as an instant step (the controller's routine isn't simulated)
        segs.push({ line: li, kind: 'change', from: tip(), to: tip(), length: 0, t0: t, t1: t, feed, tool, len: len(tool), rpm });
      } else if (m === 2 || m === 30) ended = true;
      else if (m === 0 || m === 1) issue(li, `M${m}: the program pauses here for you`);
      else if (m === 7 || m === 8 || m === 9) continue;
      else issue(li, `M${m} is not simulated`);
    }
    if (dwell) {
      const p = val.P ?? 0;
      push(li, 'dwell', { ...nose }, 0, Math.max(0, p));
      continue;
    }
    const has = (a: string) => val[a] !== undefined;
    if (!has('X') && !has('Y') && !has('Z')) continue;
    if (motion < 0) {
      issue(li, 'A move with no G0/G1/G2/G3 in effect');
      continue;
    }
    let to: V3;
    if (g53) {
      if (motion > 1) issue(li, 'G53 with an arc');
      to = { x: has('X') ? val.X * kk : nose.x, y: has('Y') ? val.Y * kk : nose.y, z: has('Z') ? val.Z * kk : nose.z };
    } else {
      const w = work();
      const tgt: Partial<V3> = {};
      for (const a of ['x', 'y', 'z'] as const) {
        const A = a.toUpperCase();
        if (has(A)) tgt[a] = abs ? val[A] * kk : w[a] + val[A] * kk;
      }
      to = toNose(tgt);
    }
    const d = Math.hypot(to.x - nose.x, to.y - nose.y, to.z - nose.z);
    if (motion === 0 || g53) {
      push(li, 'rapid', to, d, (d / o.rapid) * 60);
      continue;
    }
    if (!(feed > 0)) issue(li, 'A cutting move with no feed rate (F)');
    const fr = feed > 0 ? feed : 1;
    if (motion === 1) {
      push(li, 'feed', to, d, (d / fr) * 60);
      continue;
    }
    // arcs: centre from I J (incremental), sweep in the direction of the move
    const cx = nose.x + (val.I ?? 0) * kk, cy = nose.y + (val.J ?? 0) * kk;
    if (!has('I') && !has('J')) issue(li, 'An arc with no I/J centre (R arcs are not simulated)');
    const r0 = Math.hypot(nose.x - cx, nose.y - cy), r1 = Math.hypot(to.x - cx, to.y - cy);
    if (Math.abs(r0 - r1) > 0.01) issue(li, `The arc's start and end are ${Math.abs(r0 - r1).toFixed(3)} mm different from its centre`);
    const cw = motion === 2;
    const a0 = Math.atan2(nose.y - cy, nose.x - cx), a1 = Math.atan2(to.y - cy, to.x - cx);
    let sw = cw ? a0 - a1 : a1 - a0;
    while (sw <= 1e-9) sw += 2 * Math.PI;
    const r = (r0 + r1) / 2;
    const L = Math.hypot(r * sw, to.z - nose.z);
    push(li, 'arc', to, L, (L / fr) * 60, { cx, cy, cw, sweep: cw ? -sw : sw, r });
  }
  if (!ended) issue(Math.max(0, lines.length - 1), 'The file has no M30 / M2 at the end');
  return { lines, segs, issues, duration: t, tools, start };
}

/** where the tip is a fraction f (0–1) along a segment */
export function segPoint(s: Seg, f: number): V3 {
  if (s.arc) {
    const a0 = Math.atan2(s.from.y - s.arc.cy, s.from.x - s.arc.cx) + s.arc.sweep * f;
    const r = Math.hypot(s.from.x - s.arc.cx, s.from.y - s.arc.cy) * (1 - f) + Math.hypot(s.to.x - s.arc.cx, s.to.y - s.arc.cy) * f;
    return { x: s.arc.cx + r * Math.cos(a0), y: s.arc.cy + r * Math.sin(a0), z: s.from.z + (s.to.z - s.from.z) * f };
  }
  return { x: s.from.x + (s.to.x - s.from.x) * f, y: s.from.y + (s.to.y - s.from.y) * f, z: s.from.z + (s.to.z - s.from.z) * f };
}

/** index of the segment running at time t (the last one that has started) */
export function segAt(segs: Seg[], t: number): number {
  let lo = 0, hi = segs.length - 1;
  if (hi < 0) return -1;
  if (t <= segs[0].t0) return 0;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (segs[m].t0 <= t) lo = m;
    else hi = m - 1;
  }
  return lo;
}
