# Onefinity CAM

Browser-only CAD/CAM for an **Onefinity** CNC router running a **MASSO G3 / MASSO Touch** controller.
Vite + TypeScript + three.js + vitest, deployed to GitHub Pages by `.github/workflows/deploy.yml`
(tests must pass before deploy). Work on `main`.

## Commands
- `npm run dev`: dev server
- `npm test`: vitest. `npm run test:update-golden` rewrites the golden G-code files. Only run it when a
  post change is intended, and review the `test/golden/*.nc` diff line by line.
- `npm run build`: typecheck + production build

## Layout
- `src/core/`: machine-agnostic code ported from Relief-Generator (keep it free of UI and of
  controller-specific output)
  - `cutter.ts`: tool shapes (ball, tapered ball, V-bit, flat), `simulateCut`, `tipHeight`, `toolProfile`
  - `heightfieldCam.ts`: heightfield raster roughing/finishing/detail, cutout, feeds & speeds
    (`chipLoad`, `recommend`, `chipRatio`, `stepoverFor`, `scallopHeight`), generic `writeGcode`,
    `previewSegments`. Used for the 3D-from-STL operation.
  - `heightfield.ts` (`MachGrid`), `grid.ts`, `mesh.ts`/`stl.ts` (STL write), `setup.ts` (setup sheet)
- `src/cam/toolpath.ts`: the `Move` list every operation produces and every post reads
  (absolute mm in the work coordinate system, XY arcs with I/J from the start point)
- `src/cam/ops/`: one module per operation, pure functions from drawing items + params to `Move[]`
  and warnings. Depths are positive mm below the stock top; `Ctx.z(depth)` gives work Z.
  - `contour.ts`: chaining items into contours, depth `levels`, `LoopWalker`/`walkLoop` (ramps and
    tab jumps along a loop), approach/retract, link checks (`crossesLoops`, `inRegion`)
  - `profile.ts` (outside/inside/on, climb/conventional, ramp, tabs, allowance), `pocket.ts`
    (offset rings inner→outer or raster + wall pass, islands, links kept at depth when short and
    inside), `drill.ts` (pecks as plain G0/G1, no canned cycles)
  - `vcarve.ts`: V-carving by largest inscribed circles: walk each boundary loop (material on the
    left), at each point find the biggest circle touching there that fits; its centre is the tip
    position, its radius the depth. Reflex corners are swept with a fan of normals; samples are
    bisected where the tip jumps. Depth cap → `flat` loops for a clearing tool.
  - `inlay.ts`: V-carve op, and inlay pocket / plug (mirrored, walls start at pocket depth − glue
    gap, cut down by `proud` more, inside a margin frame). With a clearing tool `buildJob` makes a
    second toolpath (`<id>:clear`, the end mill's own recommended feeds) before the V-bit's.
  - raster3d: still to write
- `src/cam/build.ts`: `buildJob` (job + drawing + library → moves, warnings, `moveStats` times)
  and `jobGcode` (→ `postMasso`). `opParams` merges saved params over `OP_DEFAULTS`.
- `src/cam/preview.ts`: moves → line segments for the 3D view
- `src/workers/cam.worker.ts` + `src/ui/camClient.ts`: toolpaths are computed off the main thread;
  only the newest request's reply is used
- `src/cam/tools/library.ts`: tool library; `number` = MASSO tool-table slot (used by `T# M6` and `G43 H#`)
- `src/cam/machines.ts`: Onefinity models and travel envelopes (nominal, verify on the machine)
- `src/post/masso.ts`: MASSO post (`postMasso`, `massoFileName`)
- `src/io/`: storing tool libraries and jobs
  - `formats.ts`: on-disk JSON formats `*.ofc-tools.json` and `*.ofc-job.json`. Each has a
    `format` tag and a `version`. To change a format, bump the version and add a `MIGRATE_*` step;
    newer-version files are refused. Job files embed copies of the tools their ops use, and
    `toolMismatches` reports differences from the current library when a job is opened.
  - `files.ts`: Open/Save through the File System Access API in Chrome/Edge (remembers the folder
    per file kind, Save overwrites in place); download/upload fallback in other browsers
  - `store.ts`: IndexedDB working copy holding the library, job autosaves, recent jobs and dirty
    flags, with an in-memory fallback. **Files on disk are the master copy; the browser store is a cache.**
- `src/cad/`: the drawing (pure data and functions, no DOM, so they run in tests and workers)
  - `geom.ts`: shapes in mm, Y up: `line`, `arc` (always CCW a0→a1), `circle`, `poly`
    (vertices with DXF-style bulge, open or closed), `dim` (aligned dimension). Also primitives,
    flattening, boxes, distances, intersections, 3-point arcs.
  - `doc.ts`: `CadDoc` (layers + entities, stored as `JobFile.cad`), snapshot `History`
    (undo/redo), `joinShapes` (chains loose lines/arcs into polylines)
  - `snap.ts`: end/mid/centre/quadrant/intersection/nearest/grid snapping
  - `ops.ts`: similarity transforms (arcs stay arcs), and Clipper2 (`clipper2-ts`, pinned) offsets
    and booleans. Booleans/offsets flatten arcs, so their results are straight segments.
  - `dxf.ts`: DXF import (blocks, splines/ellipses flattened, OCS mirror, $INSUNITS) and R12 export
  - `svg.ts`: SVG import (own XML tokenizer, transforms, units/viewBox, Y flipped) and export;
    `pathDataShapes` (path `d` → polylines, used for font glyphs)
  - `text.ts`: text → closed outlines with opentype.js (`height` = cap height; kerning, spacing,
    alignment, rotation, lines), glyphs merged by the non-zero rule (`unionNonZero`)
  - Items made together share `Entity.group` (selected together); text outlines keep their
    `Entity.text` settings so they can be edited; transforms update those settings, a mirror
    turns them into plain outlines
- `src/ui/`: `main.ts` (tabs), `jobBar.ts` (job New/Open/Save/Recent, machine, stock, units;
  autosaves to the store), `toolPanel.ts`, `units.ts` (display units, `parseLen` accepts fractions
  and unit suffixes), `fonts.ts` (bundled OFL fonts + user fonts stored in the browser; see
  LICENSES.md), `cad/` (canvas `editor.ts`, `render.ts`, `viewport.ts`), `opsPanel.ts`
  (Toolpaths tab: operations from the drawing selection, settings, recommended feeds, warnings,
  Save G-code), `preview3d.ts` (three.js stock + drawing + toolpaths, Z up)

Not in the CAD yet: constraints, fillets/trim/extend, and keeping splines as curves
(they come in as polylines).

## MASSO post conventions
`%`, header comments, `G90 G94 G17 G21|G20 G40 G49 G80`, `G54`–`G59`; per tool: `G53 G0 Z0`, `M5`,
`T# M6`, `G43 H#`, `M3 S…`; after a change it moves across at the top, then down to safe Z; modal
G/X/Y/Z/F; arcs always restate G2/G3 with X Y I J; end `G53 G0 Z0`, `M5`, `M30`, `%`. File names
`[A-Za-z0-9_-]`, max 30 chars, `.nc`.

Items still to confirm against the MASSO docs or the real machine:
- the `G4 P` dwell unit (the post writes seconds)
- whether `G53 G0 Z0` is the top of Z on this setup
- whether `G43 H#` is needed, or MASSO applies the tool length on `M6` by itself
- the USB file-name limits
- the Elite model travels

Every new machine-facing behaviour needs a golden-file test. The user air-cuts the first file from any
post change before cutting stock.

## Milestones
1. Scaffold, port, MASSO post + golden tests (done)
2. 2D CAD core: draw/edit/snap/dimension, DXF/SVG import/export, undo (done, first pass)
3. Profile / pocket / drill + 3D toolpath preview + time estimate (done, first pass). Not yet:
   lead-in/out, arc fitting (toolpaths are short G1 segments), helical entry, rest machining.
   Run times ignore acceleration and use a 10 m/min rapid (`machines.ts`, to verify).
4. V-carve and inlay (done, first pass), text tool (done). Not yet: single-line engraving fonts, text on an arc.
5. 3D from STL (needs an STL reader + mesh→heightfield rasteriser; then reuse heightfieldCam)
6. Machine simulator: a 3D (three.js) Onefinity sized from `machines.ts` (bed, rails, X gantry,
   Z carriage, router/spindle, the job's tool from the library), with the stock placed at the work
   offset. It plays back **the posted G-code file itself** (G0/G1/G2/G3, G53, G54–G59, T# M6,
   G43, M3/M5, dwell), so it checks what the MASSO will actually run, not the CAM's internal moves.
   - play / pause / step / scrub, speed control, line-by-line G-code highlight, run-time clock
   - material removal on the stock (heightfield, reusing `simulateCut` / `tipHeight`), and a
     finished-part view
   - warnings: travel and soft-limit overruns, rapids into the stock, cuts deeper than the tool's
     flute length, plunges with a non-plunging tool, the spindle off while cutting
   - a schematic machine model, not Onefinity's own CAD files or branding
7. Setup sheet wiring, OpenCascade solids (stretch)
