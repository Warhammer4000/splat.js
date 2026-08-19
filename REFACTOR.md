# Refactoring the prototype into a library

*Written by Claude Opus 5 on 2026-08-19, from a read of this tree as it stands
today. Line references are a snapshot of that state and will drift — treat them
as "look near here", not as coordinates.*

The goal this addresses: turn `prototype/js/` into something (a) another project
can install and integrate without reading 7,000 lines first, and (b) a UI can sit
on top of without reaching into internals. Nothing here is about the maths.

---

## What is already right — leave it alone

`sfm/geometry.js`, `sfm/ba.js`, `sfm/sift.js`, `sfm/global.js` and `gs/shaders.js`
are pure functions with explicit arguments, no environment access and no hidden
state. `ply.js:gaussiansToPly()` already returns bytes rather than triggering a
download. That is the bulk of the value and it is library-shaped already.

Everything below is about the shell around it.

---

## The blockers

### 1. Hidden global configuration

`window.__sfmOpts` is not merged once at the entry point — it is re-read *deep
inside the algorithm*:

```
sfm.js:298    opts = { ...window.__sfmOpts, ...opts }
sfm.js:595    const sfmOpts = window.__sfmOpts || {}
sfm.js:843    refineDistortion: o.refineDistortion ?? (sfmOpts.refineDistortion ?? true)
sfm.js:844    refineAspect: sfmOpts.refineAspect ?? false
sfm.js:997    if (withBA && sfmOpts.interimBA !== false && ...)
sfm.js:1017   if (withBA && sfmOpts.ba !== false && ...)
sfm.js:1018   if (sfmOpts.lkRefine !== false) ...
sfm.js:1020   if (baResult && sfmOpts.obsFilter !== false) ...
sfm.js:1030   if (baResult && sfmOpts.trackExtend !== false) ...
sfm.js:1084   window.__sfmDebug = { feats, tracks, poses, ... }      // writes a global
sfm.js:1107   ((window.__sfmOpts || {}).globalInit) ?? opts.globalInit
```

plus `imageio.js:18, 25, 82` (`__trainMaxDim`, `__featMaxDim`) and
`main.js:277` (`__trainerOpts`).

Consequences:

- two configurations cannot coexist in one page
- **none of it can run in a Worker** — there is no `window` there
- it cannot be tested headless
- the option surface is undiscoverable: you would have to read all of `sfm.js`
  to learn that `interimBA` exists, and a typo silently does nothing

This is the one to fix first. Every other item on this list gets easier once a
frozen options object is threaded through instead.

### 2. Two WebGPU devices

`GSTrainer.create()` requests its own adapter with raised limits
(`gs/trainer.js:10-22`). `sfm/gpumatch.js:68-81` requests a **second** one into a
module-level `cached` singleton. That means double VRAM for descriptors, no
buffer sharing between matching and training, and a global that can never be
disposed. A host that already owns a device — `client_git`'s PlayCanvas app does
— cannot hand it in.

### 3. DOM inside the core

`imageio.js:49, 57, 71` create canvases; `ply.js:103` creates an `<a>` and clicks
it. Blocks Workers, Node and tests.

### 4. `log(string)` is the only telemetry

Every module takes a `log` callback and formats English prose. A UI cannot drive
a progress bar from

```
focal 0.94x maxDim: 42/42 cams, 4989 pts, median reproj 0.42px
```

There is no stage, no fraction, no structure — only a sentence.

### 5. No cancellation, no progress contract

`runSfM` runs four full reconstructions in the focal search — minutes of work —
with no `AbortSignal` and no way to ask where it is. The only concession to the
event loop is `tick()`. Same for `refine()`.

### 6. Positional mega-signatures with implicit contracts

```js
runSfM(images, log, sampleColor, opts)      // sfm.js:296
```
`sampleColor` is a closure the caller has to build over the same `images` array.

```js
setup(gaussians, cams, images, maxViewW, maxViewH, sceneRadius)   // trainer.js:93
```
Six positional arguments, and `images` must be the array that `cams[].imgIdx`
indexes into — an invariant that exists only in the author's head.

The Frame object (`imageio.js:118-132`) is a nine-field structure documented
nowhere, and it carries a **DOM canvas** (`thumb`) into the trainer.

### 7. All the training policy lives in the UI

`main.js` owns, and any other integrator would have to re-derive:

| policy | where |
|---|---|
| 15 iterations per frame | `main.js:419` |
| auto-stop at 60k | `main.js:407` |
| refine every 2,500 iters after 1,500 | `main.js:423` |
| exclude frames below 45% of median sharpness | `main.js:299-306` |
| MSE → PSNR conversion | `main.js:443` |

### 8. Mutable public fields as the API

`trainer.excluded = new Set()` and `trainer.lastRefine = …` are assigned from
outside (`main.js:301, 424`). `trainer.holdout` is documented as "set this
field" (`trainer.js:373`).

### 9. No package boundary

`package.json` is `private`, with no `exports` and no entry module — a consumer
would import twenty deep paths. Worker resolution uses
`new URL('./featworker.js', import.meta.url)` (`sfm.js:316`), which is correct
for raw ESM but needs a test under a bundler.

---

## The shape to move to

Two layers, because integrators and UIs want different things.

### Layer 1 — the pieces

For someone building their own flow:

```js
const gpu     = await createGpu();            // or createGpu({ device }) you own
const frames  = await decodeFrames(files, { featMaxDim, trainMaxDim });
const recon   = await solve(frames, { signal, onEvent, ...sfmOptions });
const model   = seed(recon, { capacity });
const trainer = await createTrainer({ gpu, model, recon, frames, ...trainOptions });

trainer.step(n);
await trainer.metrics();
trainer.renderTo(target, camera);
const bytes = toPly(await trainer.read());
```

### Layer 2 — the session

All a UI should ever touch:

```js
const s = createSession({ gpu });

s.on('stage',   e => …)  // { stage:'solve'|'seed'|'train', phase, done, total, detail }
s.on('metrics', e => …)  // { iter, splats, psnrTrain, psnrHold, itersPerSec }
s.on('event',   e => …)  // { kind:'grow'|'relocate'|'growth-stop', … }

await s.load(files);
await s.solve();
await s.seed();
s.train.start();

s.view.attach(canvas);
s.view.lookThrough(frameIndex);
s.view.free();
s.export.ply();
```

This abstraction is not speculative: the UX mockup in `../mockup/v2/` was built
against exactly this vocabulary before the API existed. Its prep beats are
`stage` events, its status bar is `metrics`, its capacity flashes are `event`,
and its camera model is `lookThrough(i)` / `free()`. The mockup never needs a
trainer object, which is the test the design has to pass.

### Tree

```
src/index.js          public surface, nothing else exported
src/session.js        Session + TrainingRun  (loop policy lifted out of main.js)
src/pipeline/         frames · solve · seed · train
src/sfm/  src/gs/     unchanged maths, options threaded, no window.*
src/gpu/context.js    one device, shared by trainer and matcher
src/io/ply.js         bytes only
examples/demo/        today's main.js, importing only src/index.js
```

---

## Order of work

Each step is shippable on its own.

1. **Kill the globals.** Thread one frozen `options` object through `sfm.js` and
   `imageio.js`. Mechanical. Nothing else is testable until this lands, and it is
   the precondition for ever moving the solve into a Worker.
2. **One GPU context**, created once and injected into both the trainer and the
   matcher; accept an externally owned device.
3. **Structured events + `AbortSignal`**, alongside `log`. Keep `log` working as
   a subscriber for one release so nothing breaks while the UI migrates.
4. **Extract `TrainingRun`** from `main.js`'s `frameLoop` — batching, auto-stop,
   refine cadence, exclusion policy, PSNR conversion.
5. **DOM out of the core**: an injectable decoder (OffscreenCanvas by default);
   `downloadPly` moves to the demo.
6. **`src/index.js` + an `exports` map**; demo moves to `examples/`.
7. **Solve in a Worker** — only possible after step 1, and worth designing the
   API for from day one so it is not a breaking change later.

---

## TypeScript: type the seams, do not port

**Recommendation: JSDoc types + `checkJs` + an emitted `.d.ts`. No TS port.**

Look at what has actually gone wrong in this codebase: the WGSL `target` keyword
silently killing pipeline creation; `${num}` interpolating `16384.0` as an
abstract int; a `+skew` sign flip making LM diverge; the subpixel detector
collapsing the camping reconstruction; `asin(-fwd.y)` inverting a reconstructed
pose. **TypeScript would have caught none of them.** The bugs here are numerical
and semantic — typed arrays in, typed arrays out, compiler happy, reconstruction
bent.

Where types *would* pay, all of them documentation problems that types happen to
solve:

- the `SfmOptions` bag — ten undocumented flags where a typo silently no-ops
- the `Frame` object — nine fields, documented nowhere
- `setup()`'s six positional arguments
- the public surface, for consumers

That is reachable without a build step:

```jsonc
// tsconfig.json — declarations only, no JS emit
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "emitDeclarationOnly": true,
    "declaration": true,
    "outDir": "types",
    "target": "es2022",
    "module": "esnext",
    "strict": true
  }
}
```

```js
/**
 * @typedef {object} SfmOptions
 * @property {'brief'|'sift'} [features='sift']  feature front end
 * @property {'walk'|'orbit'} [graph='walk']     pair-selection profile
 * @property {boolean} [interimBA=true]  joint BA every 10 registrations. Off
 *   means the reconstruction can settle into a bent, self-consistent basin.
 * @property {number}  [siftFeats=1800]
 */
```

You get editor and agent completion, `tsc --noEmit` in CI, a `.d.ts` for
consumers, and the source stays runnable with no build. That last point is worth
more here than usual: *no build, open the file and read it* is a real asset for a
repository whose entire pitch is that it runs in a browser tab.

Type these: `SfmOptions`, `TrainerOptions`, `Frame`, `Reconstruction`,
`SplatModel`, `SessionEvent`, and the public function signatures.

Leave these as annotated plain JS: `geometry.js`, `ba.js`, `sift.js`,
`shaders.js`. Typing `Float64Array → Float64Array` buys nothing and costs an
afternoon of fighting `number[] | Float32Array` unions.

`client_git/react-ui` is TSX, so splat.js has to feel native there — a shipped
`types/index.d.ts` satisfies that completely; a consumer cannot tell whether the
declarations were hand-written or generated. And `allowJs` leaves the door open
to migrating file by file later if the project grows contributors.

---

## Two things to know before starting

**Memory has no owner.** A Frame holds full-resolution `Float32` RGB; the
camping-113 set is 312 MB of target buffers by this repo's own README. Nothing
frees anything today. The library needs an explicit budget and `dispose()`.

**`solve()` still blocks the main thread** apart from feature extraction. Even
after this refactor it will, until step 7. Design the API worker-first now — an
async, event-emitting, cancellable `solve()` looks identical from the outside
whether it runs inline or in a Worker, and retrofitting that later is a breaking
change.
