# SfM benchmark: stock COLMAP vs the Splat.js solver on Truck

Prepared 2026-09-09, not yet run. The question: the in-browser solve got
slower with the 09-04 desktop defaults (8000 SIFT features from the upsampled
first octave, pixel-aspect bundle adjustment) — how does it compare with stock
COLMAP on the same photographs, in time per phase and in pose accuracy?

## Inputs

- Images: `data/downloads/extracted/tandt/truck/images` — the 251 Tanks &
  Temples Truck release photographs, 979 × 546 px, the set the README table
  uses.
- Accuracy reference: the release COLMAP model
  `data/downloads/extracted/tandt/truck/sparse/0` (`images.bin`). Both solvers
  are scored against it with `tests/compare_colmap.mjs` (Umeyama-aligned ATE as
  a fraction of path length), so a fresh COLMAP run is judged the same way
  as ours.
- Machine: RTX 5080 desktop, GPU idle (close the app tab first).

## COLMAP side

Two builds are in `tools/`: 3.11.1 and 4.1.1, both **without CUDA** (CPU SIFT,
CPU matching). That is the honest "what this box can run" number; the
number people usually mean by stock COLMAP is the CUDA build. To get it,
download `COLMAP-3.11.1-windows-cuda.zip` from the COLMAP GitHub releases,
unzip anywhere, and pass its `bin\colmap.exe` with `-Gpu 1`.

```
powershell -ExecutionPolicy Bypass -File scratch\sfm_bench\run_colmap_truck.ps1
powershell -ExecutionPolicy Bypass -File scratch\sfm_bench\run_colmap_truck.ps1 -Colmap <cuda>\bin\colmap.exe -Gpu 1
```

The script times `feature_extractor` (8000 features, first octave −1, one
shared SIMPLE_RADIAL camera — the same budget as our defaults),
`exhaustive_matcher` (dense graph, like ours) and `mapper` (defaults), converts
the model to text, scores it against the release model and writes
`scratch/sfm_bench/colmap_truck/timings.json` plus `colmap.log`. Expect the
CPU exhaustive matcher to be the slow step (31,375 pairs).

## Splat.js side

Three headless cells, one per solve tier (`SOLVE_TIERS` in
`src/sfm/sfm.js`, bench `?solve=`), fresh solves (no `gtrecon`), each
followed by 30k training so the held-out PSNR shows what the poses buy; the
solver's full log and the solved cameras are posted:

```
node scratch/ab_cells.mjs scratch/sfm_bench/cells_sfm_bench.json
```

- `quick` — 3900 features, base octave, no aspect term (the pre-09-04
  defaults; Draft preset, phones).
- `standard` — 8000 features, base octave, no aspect term (the new desktop
  Standard preset, provisional until this benchmark says otherwise).
- `precise` — 8000 features from the upsampled octave + the aspect term
  (the 09-04 desktop defaults; High and Showcase presets; the README numbers).

The solver now logs a duration for every phase (commit after 22ba55d):
SIFT extraction, the feature-poor rescue pass, GPU matching, matching + pair
geometry (RANSAC over every pair), each focal-search candidate, and the final
registration + bundle adjustment. Kill leftover headless Chromes first
(`headless-rig-discipline`), and keep the desktop off the GPU while the cells
run.

## Collect

```
node scratch/sfm_bench/collect.mjs
```

prints one markdown table: features / matching / registration / total /
registered cameras / ATE for the two Splat.js cells and the COLMAP run.

## What to look for

- **Where the browser minutes go.** The app shows "Finding landmarks" through
  the rescue pass and the whole GPU matching (no progress event), then
  "Matching photos" during the per-pair RANSAC, then "Solving positions" for
  five focal-search registrations plus the final BA run. The log durations
  say which of those the 12 minutes belong to.
- **Feature budget vs time.** The previous-defaults cell isolates the cost of
  8000 features at octave −1 (roughly 2× the descriptors to match, more
  RANSAC work per pair, more observations in BA).
- **COLMAP's split.** Feature extraction and matching are the parts a CUDA
  build makes cheap; the mapper is CPU in every build, so its time is the
  like-for-like comparison with our registration + BA.
- **Accuracy.** Both ATEs against the release model, and registered counts.
  Ours read 0.00 % on this set in the README; a fresh COLMAP run should read
  near zero too (it is the same software as the reference).

## Results

_(fill in from `collect.mjs`)_

| solver | features | matching | registration + BA | total | registered | ATE |
|---|---:|---:|---:|---:|---:|---:|
| Splat.js, desktop defaults | | | | | | |
| Splat.js, previous defaults | | | | | | |
| COLMAP 3.11.1, CPU build | | | | | | |
| COLMAP 3.11.1, CUDA build (if fetched) | | | | | | |
