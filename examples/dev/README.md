# Browser 3DGS — research prototype

Rough end-to-end prototype for [`../browser_gs.txt`](../browser_gs.txt):
**overlapping photos → camera/geometry reconstruction → Gaussian init →
WebGPU optimization → PLY export**, entirely in the browser, no server, no
model download.

This implements the **classical SfM branch (option A)** of the research plan
plus a from-scratch WebGPU splat trainer, as the baseline against which the
neural (VGGT/DUSt3R) and hybrid branches can later be compared.

## Run

Serve the **parent** directory (`Browser_3DGS/`) so the test dataset under
`data/` is reachable, then open the prototype in Chrome/Edge (WebGPU needed
for training; SfM alone runs anywhere):

```
cd Browser_3DGS
python -m http.server 8734
# then open http://localhost:8734/prototype/
```

Buttons, left to right:

1. **Input** — drop photos, or *Synthetic test scene* (12 rendered views of a
   textured room corner, exercises the whole pipeline deterministically), or
   *Camping test set* (fetches every 3rd frame from `../data/camping`).
2. **Run SfM** — features → matching → RANSAC essential matrices → tracks →
   two-view init → incremental PnP + retriangulation.
3. **Init Gaussians + WebGPU** — one Gaussian per SfM point + 2 jittered
   clones, scale from nearest-neighbor distance; uploads everything to the GPU.
4. **Start training** — the WebGPU optimization loop; watch the side-by-side
   render-vs-target preview and the orbitable interactive view.
5. **Export PLY** — standard INRIA 3DGS PLY layout (loads in common viewers).

## What's implemented

### SfM (pure JS, `js/sfm/`)
- Shi-Tomasi corners + oriented BRIEF-256 descriptors (`features.js`)
- brute-force Hamming matching, ratio + cross check (`matching.js`)
- 8-point essential matrix in RANSAC (Sampson error), pose decomposition with
  cheirality test, DLT triangulation, DLT-PnP in RANSAC, Levenberg-Marquardt
  pose refinement with numeric Jacobians (`geometry.js` — unit-tested against
  synthetic ground truth, see the scratchpad geometry test)
- incremental pipeline (`sfm.js`), tuned on real low-parallax video input:
  - tracks are built by union-find over per-pair E-RANSAC inlier matches;
    pairs whose matches cannot support an essential matrix are dropped
    entirely (their raw matches would merge unrelated tracks); tracks with
    two features in one image are discarded as bad merges
  - the init pair is ranked by **shared tracks** — tracks chain matches across
    many frames, connecting wide baselines that direct matching cannot reach
    (on the camping video, direct matching dies past ~10 frames while frame
    pairs 40+ apart still share 100+ chained tracks)
  - new images register from the pose of the registered image sharing the most
    tracks + IRLS-style LM refinement (DLT-PnP RANSAC only as fallback), in
    multiple passes so early failures get retried as the reconstruction grows
  - alternating pose-refine / retriangulate as a cheap bundle-adjustment
    stand-in
- no EXIF: a small **focal search** runs the geometry stage at several focal
  scales (0.78–1.87 × maxDim) and keeps the reconstruction with the most
  registered cameras / points

### WebGPU trainer (`js/gs/`)
**Anisotropic 3DGS** (per-axis scales + rotation quaternion, stride-16 layout).
Per iteration (one random training camera): EWA project + tile-bin (16px
tiles) → **per-tile depth sort** (bitonic, one workgroup per tile, 1024-entry
shared memory, id tie-break for determinism) → fused forward/backward per
pixel → covariance chain rule (conic → 2D cov → 3D cov → scales/quaternion,
incl. the J position term) → Adam. Compositing is standard sorted
front-to-back alpha blending with the back-to-front transmittance-recursion
backward pass (INRIA formulation), plus Mip-Splatting opacity compensation on
the 0.3px dilation so rendering is resolution-independent (verified:
identical pixel statistics at 1x and 2x render resolution).

Loss is Charbonnier (smooth L1, δ=0.03). Opacity is L1-regularized
(constant push in Adam) and dead splats are periodically **relocated** onto
jittered copies of well-supported donors (MCMC-lite, `trainer.refine()`),
which recycles floaters into useful capacity.

**All gradients are validated against finite differences** —
`js/gs/gradcheck.js` builds a small dedicated rig (160 splats, strict cutoff
shader variant so boundary discontinuities vanish) and central-differences
the loss w.r.t. sampled parameters; every parameter type checks in at 0.2–1.3%
median relative error. Run from the console:
`(await import('./js/gs/gradcheck.js')).gradCheckSmall()`.

A second viewer renders the live training state through the **PlayCanvas
engine** (`js/pcviewer.js`, engine build in `lib/`) by exporting to an
in-memory PLY — it shows exactly what the exported file looks like in a
standard sorted splat renderer, and now closely matches the trainer's own
view. Export bakes the opacity-compensation factor into opacities
(`bakeOpacityCompensation` in `js/ply.js`) since standard viewers don't
apply it.

Hyperparameters follow LichtFeld Studio conventions where they transfer
(`C:\Dev\Lichtfeld`, see `src/core/include/core/parameters.hpp`): scene-scaled
position lr with exponential decay, Adam eps 1e-15, 0.3px screen-space
variance dilation, knn-based scale init, SH0 color conversion for export.

Remaining simplifications vs reference 3DGS (all noted for the comparison
experiments in the research doc):

- **DC color only** (no spherical harmonics, sigmoid-activated so colors are
  bounded — unbounded colors let the optimizer build view-dependent
  cancellation stacks that explode into saturation on novel views), black
  background
- no clone/split densification (capacity = init clones + dead-splat
  relocation; total count stays constant)
- no SSIM term; camera poses are fixed during splat training
- binning is GLOBAL and uncapped: count -> single-workgroup prefix scan ->
  scatter into exact-size per-tile segments -> per-segment depth sort
  (shared-memory bitonic fast path up to 2048 entries, global-memory bitonic
  for larger segments; deterministic via id tie-break). No splats are ever
  dropped per tile; the only bound is a global 6M-entry budget (whole-tile
  drops flagged in stats and surfaced in the refine log — never observed in
  practice). Binning stays opacity-aware and radius-unclamped. Costs ~10-15%
  throughput vs the old capped per-tile sort.
- image downscaling: training targets use stepped high-quality downscaling
  (single-step drawImage at 6x decimation point-samples and bakes aliasing
  speckle into the loss); the SfM grayscale deliberately keeps the sharp
  single-step path — its residual high-frequency detail is discriminative
  texture for corners/BRIEF (the smooth variant registers 13/40 cameras
  instead of 18/40)

## Results

Current configuration (full-res training, unbiased PSNR metric, 60k
iterations auto-stop, moderate capacity, camOpt on, holdout = one camera
never trained on, scored after test-time pose refinement):

| scene | SfM registration | train PSNR | holdout PSNR |
|---|---|---|---|
| synthetic (640x480) | 12/12 | 37.2 | 35.6 |
| camping video, FULL 113 frames (640x360) | **113/113** | 21.8 | **21.2** |
| camping video, 40-frame subset | 18/40 | 26.5 | 18.7 |
| truck T&T (640x357) | 42/42 | 20.4 | 19.4 |
| bicycle M360 | 10/42 | (arc only) | 17.3* |
| playroom DB | 7/45 | (fragment) | — |

The full-set camping row is the important one: with all 113 frames (stride 1)
SfM registers everything (17k points, 112s) and the train/holdout gap
collapses from ~8dB to 0.6dB — +2.5dB honest novel-view quality over the
subset, at 312MB of target buffers and ~340 it/s with ~88k splats. Image
density was the whole ballgame for this capture.

*bicycle at the older 300px/biased-metric configuration.

Historical numbers from earlier README revisions are NOT comparable: the
training resolution changed (300px -> full-res) and the PSNR accumulator was
fixed (plain truncation inflated readings above ~40dB; now dithered/unbiased).

Measured trade-offs (same protocol):
- capacity: on synthetic, 163k splats vs 50k = +0.8 train but **-1.9 holdout**
  (overfit) — hence moderate defaults, raise via `__trainerOpts` per scene
- per-image exposure compensation (gain/bias, NeRF-W-lite): no holdout gain
  on the camping video (its exposure is stable; the freedom absorbs error) —
  implemented, FD-validated, default OFF (`__trainerOpts = { expComp: true }`)

Novel views no longer collapse into saturated blob soup (bounded colors +
opacity regularization + relocation).

**Needle artifacts, investigated and fixed:** on low-parallax data the thin
axes of anisotropic splats are unconstrained by the loss and random-walk to
the scale clamps (measured on the camping scene: median axis ratio 118:1,
p90 pinned at the clamp value of 500:1; long axes mildly view-ray aligned at
|cos|=0.69 vs 0.5 random). Fix: an anisotropy regularizer in the chain pass
(pull each log-scale toward the splat's mean, `anisoReg = 0.02` — Adam
normalization makes it dominate exactly where data gradients are absent) plus
a saner minimum scale clamp (1e-3·radius instead of 1e-4, capping ratios at
50:1). A/B with a **held-out camera** (trainer.holdout + evalCamPsnr, the
honest novel-view metric): camping ratios collapse 468→9 (p90) with the best
train PSNR of the three variants and unchanged holdout PSNR; synthetic keeps
its data-supported plates (p90 13.7). The residual train/holdout gap
(~25.5/19 on camping) is *not* needle-driven — it is pose error +
view-dependent appearance, the next frontier.

## Camera pose optimization (on by default)

Unlike COLMAP-based pipelines (and LichtFeld), this trainer **refines camera
poses and a shared focal during splat optimization** — our SfM poses are far
from COLMAP grade, so it pays here. Per-camera 6-DOF gradients (rotation via
left-perturbation `R <- exp(w^)R`, including the covariance-projection W term)
plus `dL/d log f` are accumulated atomically in the chain pass and applied by
a CPU-side Adam every 25 iterations (camera 0 pinned as gauge anchor, 1.5k
iteration splat warmup, decayed lr). All camera gradients are FD-validated
(`gradCheckPose()`: 0.1–1.8% relative error).

Evaluation note: with pose optimization the global frame drifts slightly, so
the held-out camera is scored after **test-time pose refinement** of its own
6-DOF pose (`evalCamPsnrRefined`, splats frozen — standard protocol).

A/B at 50k iterations, holdout protocol:

| scene | camOpt | train | holdout (refined) |
|---|---|---|---|
| camping | off | 31.13 | 20.60 |
| camping | on | **32.25** | **21.29** |
| truck (T&T) | off | 22.13 | 21.51 |
| truck (T&T) | on | **22.88** | **21.87** |

The shared focal self-corrected to 0.994x (camping) / 0.998x (truck) of the
SfM focal-search value. Disable via `window.__trainerOpts = { camOpt: false }`.

## Datasets

`data/index.json` drives the dataset buttons (pattern- or file-list based).
Included: the camping video, and research-grade scenes staged from the INRIA
3DGS benchmark inputs (`tandt_db.zip`): **truck** (Tanks&Temples, 42-frame
orbit arc at stride 1 — SfM registers 42/42 with 4989 points) and **playroom**
(Deep Blending). Note the truck orbit needs stride 1: BRIEF matching dies
beyond ~4 degrees of orbit per step.

Notably, truck's train/holdout gap is ~1dB vs camping's ~11dB — the camping
overfit is a capture-conditioning problem (low parallax), not a trainer
problem.

## Where this leaves the open questions (browser_gs.txt)

- Q1/Q11: this is the classical-SfM baseline; pose quality is the weak part
  (no real bundle adjustment, guessed focal). Neural init (VGGT-class via ONNX
  Runtime Web) is the natural next comparison.
- Q9/Q10: the trainer shows WebGPU-native training is viable; a faithful
  sorted anisotropic rasterizer (or reusing Brush/WebDGS kernels) is the next
  step for quality parity with CUDA gsplat.
- Q6: visibly, bad poses show up as blur the optimizer can't fix — supports
  adding pose optimization during training (Q7).

## Next steps (not in this prototype)

- SSIM term: `(1-λ)Charbonnier + λ(1-SSIM)`
  (LichtFeld: λ=0.2, fused kernel in `src/training/losses/photometric_loss.cpp`)
- growth: relocation keeps count constant; LichtFeld's MCMC also *grows* 5%
  per refine up to a cap (`src/training/strategies/mcmc.cpp`)
- spherical harmonics (view-dependent color)
- EXIF focal / focal refinement in global BA; a real sparse BA
- pose optimization during splat training (LichtFeld notably does *not* do
  this — it compensates per-image appearance instead via bilateral grid/ISP)
- ONNX Runtime Web (WebGPU EP) experiment with a small multi-view model
- SPZ export, memory instrumentation for the experiment matrix
