# Lab log

What we tried, what it did, what it cost. Newest first. PSNR numbers are
held-out (eval8) unless noted; "noise band" on repeated truck 40k runs is
about ±0.1 dB.

## 2026-08-31 (defaults: measured rollout)

- **DC-convention bridge shipped** (b5b2356): PLY/SOG imports keep the
  standard SH-DC convention (tagged); trainer.setup converts per engine.
  v2 continuation round-trip now EXACT (25.914 vs 25.916 trained).
  Three bugs found by measurement: parse-time logit conversion crushed
  colors (~1.1 dB), seedFrom dropped the dc tag (double-conversion,
  −2.7), and v1's near-perfect wrong answer (sigmoid(x)≈0.5+x/4 mimics
  C0·x+0.5) almost masked it.
- **Point-scaled initTarget default**: min(250k, max(60k, points×8)),
  phones pinned at 60k. Bench validation: garden 30k 26.07 → **26.56**
  (+0.49 free), truck 40k 25.42 → 25.47 (noise). New bench baselines.
- **v2 desktop auto-select: built, measured, DORMANT.** The decisive
  number was storage, not training: SOG costs v2 models **−0.95** vs
  v1's −0.36 (8-bit palette vs unbounded DC) → stored/shared scenes
  land at parity (24.74 vs 24.75 truck 30k) despite v2's +0.58 live.
  Cross-engine continuation lossy both ways (2.5–3.2) → stored scenes
  must record+match engine. Gates for enabling: SOG extended-range DC
  (encoder) or a DC-range regularizer in v2 training. ?engine=v2
  override available.

## 2026-08-30 (overnight: trainer v2)

- **Flagship 250k refresh (v1, current defaults): 26.30 @116min train** —
  reproduces the published 26.37 within noise, but at ~2x the published
  ~60min: today's defaults fill the 2M population early, so most
  iterations carry full-population cost. SPEED DEBT (user: "tackle
  later"): pace the growth curve on long budgets + v2's 1.8x SSIM tax.

- **Closing-the-last-0.3 attempts, both NEGATIVE**: (A) Brush-style
  visibility-normalized growth stat (grad per rendered contribution) =
  25.20 vs 25.69 raw (−0.49 — diverts growth to rarely-seen periphery the
  ring eval never rewards; kept behind `growNorm` knob). (B) entry-buffer
  overflow at 2M: counter reads 0 — no silent tile drops, nothing to fix.
  Remaining candidates tested and ALL negative: windowed-MAX stat
  semantics −0.08 (noise), opacity pressure 0.003 flat, gradient
  precision 2× (gradFixed 32768, WGSL override) flat — the dithered i32
  quantum was already sub-noise. **The −0.3 hunt is closed**: five
  best-theory transplants failed to move it; the residual is distributed
  implementation minutiae, not a lever. Higher-yield backlog: guided
  matching (+0.28 measured headroom), v2 speed (1.8×), small-cap tuning.

- **Engine v2 built and measured** (`trainer.engine='v2'`, opt-in): clean
  Brush-style optimization system on our unchanged (faster) renderer —
  unbounded SH-DC color (standard PLY convention, export simplifies),
  Brush LR table + smooth decays, no SH ramp, no Langevin, L1+0.2·D-SSIM
  default, and refineV3: relocation ∝ opacity + growth triggered by a NEW
  window-accumulated screen-gradient stat (gradP slot 12), every op an
  alpha-conserving split pair with in-kernel ellipsoid offsets. All @30k:
  | scene | v1 | v2 | Brush (our inputs) |
  |---|---|---|---|
  | truck (2M) | 25.11 | **25.69** | 25.93 |
  | garden (2M, init250k) | 26.45* | **26.89** | 27.20 |
  | camping 50k | 26.08 | **26.36** | — |
  | shiny (60k cap) | 37.21 | 34.14 | 31.54 |
  *v1 garden at 1.05M formula-cap = 26.45; the 2M row is v2.
  Gap to Brush now a UNIFORM ~0.25-0.3 at equal inputs+capacity (was
  0.7-1.1). GT-vs-our inputs inverts for v2 too (25.54 GT vs 25.69 ours) —
  our poses keep out-rendering COLMAP's.
- **SSIM finally pays — but only in v2**: garden v2 26.21 without / 26.49
  with (+0.28). Same term, same scene: v1 −0.4. The coupling thesis
  (structural error must steer densification) demonstrated in our own
  codebase.
- **Two capacity ceilings unmasked**: garden growth froze at EXACTLY
  seed×capMult (752,496) — `initTarget` 60k default seed-binds every
  list-set bench cell (garden v1 26.07→26.45 just from init=250k!); and
  the iters×35 maxSplats formula (1.05M) sat below Brush's 2M. Much of
  the week's "trainer gap" was these.
- **v2 known costs**: ~1.7-1.9× train time (SSIM passes at 1600px);
  shiny tiny-cap synthetic REGRESSES (37.2→34.1 — conserving splits +
  SSIM misspend a 60k budget). v2 stays opt-in; product default remains
  v1 (speed) until the time cost and small-budget behavior are tuned.
- First v2 gate starved at 568k splats (heavy-tail stat × mean-multiple
  threshold) — fixed with a median-multiple; growth knobs growTau/
  growFrac/init/maxsplats/refevery exposed through both harnesses.

## 2026-08-29

- **Garden 2×2: trainer × inputs** (30k, eval8, identical 1297px images;
  ours = release defaults, Brush = truck protocol; ours→COLMAP text export
  + COLMAP GT parsed to our recon format, intrinsics at FEATURE scale —
  image-scale intrinsics first gave a bogus 18.28):
  | | our solve | GT COLMAP |
  |---|---|---|
  | Splat.js | 26.07 | 26.76 |
  | Brush | 27.20 | 27.60 |
  Inputs help both (+0.69 us, +0.40 Brush — their growth compensates
  sparse seeds better); Brush's trainer edge widens on texture-dense
  scenes (+0.8..1.1 vs truck's +0.6). Our garden cloud: 31k pts vs GT
  139k (4.4×) — same densification gap as truck.
- **SSIM re-test on garden** (user asked): 25.66 vs 26.07 default →
  **−0.41 dB**. With truck's flat result, D-SSIM is now two-scene
  negative in our trainer — stays opt-in/off.
- **SSIM cross-examination** (user: "everybody uses SSIM — bug in ours?"):
  Brush garden-GT with `--ssim-weight 0` = 26.68 vs 27.60 → SSIM is worth
  **+0.92** in THEIR system (and 2.4× their train time). L1-vs-charbonnier
  pairing fix in ours: 25.69 ≈ no change → not a pairing bug either.
  Conclusion: SSIM pays through gradient-driven densification (structural
  error steers capacity); our size/opacity-driven refine can't hear it.
  This is the strongest single argument for the clean trainer-v2 rewrite
  (shared renderer, Brush-style optimization system) proposed today.
- **SSAA supersampled training** (`trainer.ssaa = 2`: raster at 2×, box-
  downsample, loss at native res vs unmodified targets — dB stays
  comparable; built on the SSIM split-kernel chassis) — user's "ringing"
  hypothesis. Truck: 25.67 vs 25.59 (+0.08, noise-edge) at **2.3× train
  cost** → not worth it on photos (targets carry their own optical blur).
  Shiny (crisp synthetic targets): **36.54 → 38.06 (+1.5 dB)** — new
  record on the set, +6.5 over Brush. Verdict: big lever for synthetic /
  render-target content, PSNR-invisible on photographs; opt-in.

- **Input decomposition on truck (2×2 + controls)** — WORKED, surprising.
  Same 40k protocol, only the solve inputs swapped (COLMAP GT aligned into
  our frame via Umeyama):
  | poses | seed cloud | psnrTest |
  |---|---|---|
  | ours | ours (25k pts) | 25.59 (repeat; prior run 25.50 → noise ±0.09) |
  | ours | GT (60k pts) | **25.87** |
  | GT | ours | 25.35 |
  | GT | GT | 25.66 |
  The seed **cloud is worth +0.28 dB**; COLMAP's **poses cost −0.24** vs
  ours (both directions agree). Our BA poses out-render the COLMAP
  reference.
- **Seed densification via relaxed re-triangulation** (`sfm.denseSeed`,
  3× reproj budget, 0.0015 rad parallax floor on rejected tracks) —
  NO-OP (25.55 vs 25.59). Lesson: loosening acceptance on tracks we
  already formed recovers junk; COLMAP's extra points come from matches
  our budgeted matcher never made. The +0.28 lives in a **denser track
  graph** (guided epipolar re-matching) — open follow-up.
- **RobustNeRF-style transient tile vote** (`trainer.robustLoss`, per-16×16
  vote at κ× running mean loss) — implemented; first run COLLAPSED to
  4.7 dB (u32 overflow in the loss accumulator fed a ~0 threshold; every
  tile trimmed, opacityReg starved the model — fixed via MSE-derived
  reference with floor). Fixed A/B on truck: κ=0 25.50 / κ=3 25.38 /
  κ=6 25.48 → PSNR-flat, and **visually backfires** on truck's one real
  mover (the photographer, cam 60): baseline erases him via multi-view
  consensus, robust preserves his ghost (splats formed during warmup are
  uncorrectable once their only witnessing frame is voted out). Needs
  transient-splat decay to be useful; truck's movers too sparse to be the
  right test set. Flag stays opt-in experimental.
- **maxScale sweep {0.05, 0.5, 2}** → default **0.5·r committed**
  (`e919ca9`): synthetic 39.06 (best of all three; cap 2 regressed it
  −1.63), shiny 36.5, playroom 26.25. Full 16-cell matrix at the lifted
  default: 13/16 cells improved, playroom **+1.02/+0.84**, train +0.26,
  garden +0.14, nothing regressed.

## 2026-08-28

- **maxScale clamp discovered** — THE find of the week (user's tile-artifact
  hunch). The hardcoded 0.05·r splat-size cap forced sky/far content into
  per-view mosaics of small cards = the long-standing "tile artifacts" +
  massive holdout collapse on sky scenes. Shiny 3-sphere bench: defaults
  **18.47 → 37.21** with the cap lifted (single knob; cut relaxation and
  MCMC tweaks were second-order: +1.9 and +0.7). Beats Brush (31.54) on
  the same data by 5.7 dB. Sphere-border seams and sky blocks visually
  gone. Standing lesson recorded: a visible artifact with ~0 benchmark
  delta means the benchmark has a blind spot, not that the artifact is
  free (our gates had no sky-dominated scene).
- **Brush comparison suite** — native 26.07/SSIM 0.896 @30k/7.6min vs our
  25.49 @40k. Matched-constants run (GT poses+cloud, 2M cap, 30k) = 25.35
  → the gap was the trainer, and our trainer saturates (30k≈40k).
  **Browser Brush** (WASM demo driven via CDP, same zip, same split):
  **26.10/0.903 in 30m18s** — quality survives WASM perfectly at 4× the
  wall time. Equal-wall-clock answer: our 100k run = **26.00 @38min** →
  parity at long budgets; the 30k gap is sample efficiency, not a ceiling.
  Short budgets stay ours (25.35 in 7 min vs Brush <25). README got one
  measured Brush row (26.10, 30k cycles, ~30min).
- **Brush-recipe transplants into our trainer** — all FAILED or neutral:
  full cluster (error-guided donors + alpha-conserving splits + Brush LR +
  no SH ramp) = 24.85; minus LR = 24.73; error-donors alone = 25.40.
  Their densification works as a *system* (grow-by-error + conserving
  splits + pruning + recycling), pieces don't transplant.
- **D-SSIM loss term** (`trainer.ssimWeight`, split fwd/bwd kernels + 6
  image passes, FD-validated) — train +0.95 but holdout FLAT (25.38 vs
  25.49): the ceiling is capacity placement, not the loss. Infrastructure
  kept (any image-space loss can now plug in). WGSL lesson: unreachable
  code still counts toward the 8-storage-buffer per-stage limit.
- **PlayCanvas viewer angle-pop fixed** — engine `colorUpdateAngle`
  default 10° holds SH colors stale until the camera swings past the
  threshold; set to 0 (updates on any camera translation, statics free).
  Deployed nightly + live. Viewer stays WebGL2 by decision.
- **PR #5 merged** (long PLY headers; genuine human drive-by) + follow-up
  making the CRLF handling real.
- **Camping tail verdict** (user A/B in app): server-COLMAP poses train
  *notably better* than our 1920 solve → our video-tail drift is real
  pose error, not reference error. Registration is not the issue
  (113/113); detector saturates at ~5.3k feats/img at 1920 (blur erases
  fine scale; raising the cap to 15.6k changed nothing, bit-identical).
  Solve-tail quality on blurry video = standing backlog item.

## 2026-08-27

- **Local runs library** shipped (IndexedDB, create→progress→persist→
  view/train/share/delete, 12 kept), capture tiles, ⋯ menus, delete
  prompts, Local Scene naming, wall refresh on return.
- **iOS silent-purge guard** — iOS can wipe WebGPU buffers of a hidden tab
  WITHOUT device-loss; training continued on garbage. Fix: pause on
  hidden + 64-splat sanity probe on return → recovery. Works in field.
- **EXIF capture-time sort** + landmarks-beat time overlay (iOS picker
  shuffles selection order; strict marker walk — resync wanders into
  embedded preview JPEGs).
- **SPA history navigation** (Back closes layers, no implicit truck
  preset at boot), document-scroll phone home so iOS renders under the
  collapsed URL pill.
- **Solve resolution arc** — phone featMaxDim 720→960 (user field result:
  15/45 → 35/45 photos registered), Solve resolution gear option added.
  **Feature-density law measured**: fixed 3900 features at 1600px =
  2.8× sparser → camping ATE 0.17%→0.34%; budget scaled ∝ area (8192
  cap = COLMAP parity) → 0.19%. Truck 40k at 1600 solve: poses were
  already COLMAP-identical (0.004% ATE over 251 cams) → no dB change;
  resolution pays only when registration-limited.
- **Camping 1920 solve**: first-ever 113/113 registration; trajectory-tail
  disagreement vs server COLMAP grows (0.42% vs 0.19% @1600) — later
  settled by the in-app A/B (see 08-28): the tail drift is ours.
