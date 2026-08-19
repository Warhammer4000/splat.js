# Splat.js

**Gaussian-splat training that runs entirely in the browser.** Photographs in →
camera poses solved → a 3D Gaussian splat trained against your photos → a
standard `.ply` out. No server, no upload, no account, no build step — the whole
pipeline is vanilla ES modules on WebGPU, running in a tab.

- **Structure from motion in JavaScript**: scale-space SIFT (worker pool),
  GPU brute-force matching, incremental registration with interim bundle
  adjustment, sparse Schur BA with shared focal + radial distortion. On the
  Tanks & Temples *Truck* scene it lands within **0.02% of the path length** of
  COLMAP's own reconstruction — a tie.
- **A WebGPU 3DGS trainer**: anisotropic Gaussians, global sorted binning,
  spherical harmonics (degree 2 by default), MCMC-style relocation and growth,
  Mip-Splatting opacity compensation, FD-validated analytic gradients.
- **A standard `.ply` export** (INRIA layout, SH included, opacity compensation
  baked) that opens in any splat viewer.

## Try it

Live: **https://nightly.arrival.space/splatjs/index.html**

Or locally:

```
node serve.mjs 8734
# http://localhost:8734/app/
```

Needs a browser with WebGPU (current Chrome or Edge). Drop 20–200 overlapping photos of one place into the app — or a video (the
sharpest frames are picked automatically, the same policy the arrival.space
server pipeline uses), or record one with the device camera — or start from a
test set (a clone bundles the
synthetic set; the photo sets are served on the hosted demo).

## Use the library

Everything a UI needs is one object:

```js
import { createSession } from 'splat.js';

const s = createSession({ maxIters: 40000 });
s.on('stage',   e => { /* { stage, done, total, detail } */ });
s.on('metrics', e => { /* { iter, splats, itersPerSec, psnrTrain, psnrHold } */ });

await s.load(files);      // File/Blob[] -> decoded frames
await s.solve();          // SfM: poses + sparse points (events fire throughout)
await s.seed();           // Gaussians + WebGPU trainer
s.view.attach(canvas);    // render target
s.start();                // training loop (auto-stops, emits metrics)

const ply = await s.exportPlyBlob();
```

Or compose the pieces yourself:

```js
import { createGpu, decodeFrames, solve, seed, createTrainer, gaussiansToPly } from 'splat.js';

const gpu     = await createGpu();            // or createGpu({ device }) you own
const frames  = await decodeFrames(files);
const recon   = await solve(frames, { onEvent, signal });   // cancellable
const model   = seed(recon.points);
const trainer = await createTrainer({ gpu });
// ... trainer.setup(...), trainer.stepOnce(), trainer.renderView(pose, ctx)
```

The library reads no globals, touches no DOM (OffscreenCanvas for decoding),
and shares one WebGPU device between the matcher and the trainer — a host that
already owns a device can hand it in.

## Measured quality

Every number below is reproduced by the test suite (`npm test`,
`npm run test:quality` — the quality gates drive the public API in headless
Chrome and assert documented thresholds):

| scene | cameras | ATE vs reference | holdout PSNR @40k |
|---|---|---|---|
| Truck (Tanks & Temples, 42) | 42/42 | **0.02%** of path (COLMAP: 0.02%) | 27.0 dB |
| Train (Tanks & Temples, 84) | 84/84 | 0.03% | 24.9 dB |
| Camping (handheld video, 113) | 113/113 | 0.17% (server COLMAP ref) | 29.3 dB |
| Synthetic (12 rendered views) | 12/12 | focal within 0.4% of GT | — |

The holdout PSNR is scored on a photograph excluded from training — the honest
metric.

## Tree

```
src/          the library — no UI, no globals
  index.js    public surface
  session.js  Session: pipeline + training policy + events
  sfm/        SIFT, matching (GPU), geometry, incremental SfM, bundle adjustment
  gs/         WebGPU trainer, WGSL shaders, gradcheck harness
  gpu/        one shared device
  io/         frame decoding, PLY export
app/          the Splat.js app (a Session consumer — the UI never touches internals)
tests/unit/   node tests for the maths (geometry, BA, rotation averaging, SIFT)
tests/quality/ end-to-end accuracy gates in headless Chrome
data/synthetic/ the bundled test set (known ground-truth cameras)
```

The Tanks & Temples / video datasets behind the other quality gates are not
tracked; the gates skip automatically when they are absent.

## License

MIT © Stratum1 GmbH
