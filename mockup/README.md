# Splat.js — UX mockup

A clickable mockup of a public-facing front end for the trainer in
[`../prototype/`](../prototype/). Nothing here computes anything: the pipeline is
faked so the *interaction* can be judged before any of it is wired up.

```
cd Browser_3DGS && node serve.mjs 8734
# http://localhost:8734/mockup/      v1 — the full pipeline, six beats
# http://localhost:8734/mockup/v2/   v2 — the tech-demo cut, one screen
```

**Two versions, same modules.** v1 (this file) walks a visitor through every
stage of the pipeline and grew into something close to a web app. **[v2](v2/)**
strips it back to a toy you press play on: load a set, hit start, watch the solve
run itself, watch it train, look at the result — with the explanations moved into
a Details view that only appears once there is something to explain. Read
[v2/README.md](v2/README.md) for that cut.

Vanilla ES modules, no build step, same as the prototype. Source link in the
header points at `REPO` in `js/data.js` — set that before publishing.

**Colour carries meaning, so it is worth knowing:** turquoise is the signature —
live, selected, primary. Amber marks the one frame held back from training and
its score, so the two curves and the two dB numbers can never be confused. Red is
trouble (unplaced frames, rejected matches).

---

## The pitch

**Photos in, splat out, in this tab.** No accounts, no upload, no COLMAP, no
downloads. The demo's job is to make a stranger understand what 3D Gaussian
splatting *is* by watching one happen, and to leave them wanting to shoot their
own scene.

Six beats, one per step of the real pipeline, so the structure of the UI *is* the
explanation:

```
01 Frames → 02 Landmarks → 03 Cameras → 04 Seed → 05 Train → 06 Result
```

The stepper doubles as a state jumper — click any beat to see that state.

## The five decisions worth arguing about

**One stage, not a wall of panels.** The prototype has four canvases fighting for
attention. Here there is a single stage whose *content* changes per beat: the
photograph, then the pair with match lines, then the 3D solve, then the model.
Everything else is chrome around it — a rail that explains, a strip that browses,
an inspector that measures.

**"Rendered vs target" becomes one image, not two.** Two side-by-side canvases
force the eye to travel and guess at correspondence. Instead the stage *is* the
render, and the photograph is revealed inside it four ways:

| Mode | What it is for |
|---|---|
| **Render** | just the model, from this exact camera |
| **Loupe** | drag a magnifier over the photograph; inside the ring is the render |
| **Swipe** | wipe the photograph off the render, full height |
| **Error** | per-pixel disagreement as a heat map — where the model is still wrong |
| **Photo** | the plain photograph |

Because the locked view uses the frame's real pose and intrinsics, the render and
the photo line up pixel for pixel; the swipe seam is invisible on converged
geometry, which is itself the point.

**Cameras are browsable, everywhere.** The filmstrip along the bottom is always
there. Selecting a frame highlights its frustum in the 3D view, fills the
inspector with that frame's numbers, and — one click further — puts the stage at
its viewpoint. (v2 goes further and drops the mode switch entirely: clicking a
frame *is* moving the camera there.) While training runs, the frame currently being trained on pulses
in the strip: you can *see* that training samples one random photograph at a
time. Frames carry their state as a badge: `holdout`, `blur`, `unplaced`.

**One viewer, not two.** The trainer's own renderer is the viewer, all the way
through to the result. The PlayCanvas viewer stays a developer tool for verifying
the export; users never see two views of the same thing and wonder which one is
real. (Where PlayCanvas *does* belong publicly: "open this in your arrival.space
room" as an export destination.)

**The result gets the whole screen.** On the last beat the rail and inspector
disappear, the stage goes full bleed, and the bottom bar carries the honest
number (score on the photograph that was hidden from training), the file size,
and four actions: compare with the hidden photo, replay the training, export a
.ply, and **Export to Arrival.Space** — the primary one.

## Depth without overwhelm

- **The rail** always leads with one sentence a novice can read. Anything deeper
  is behind *What actually happens*, closed by default.
- **The inspector** shows the numbers that matter; the rest is behind the
  **Detail** switch in the top bar. Every stat has a `?` with one plain sentence
  — dB, reprojection error and parallax explained in the language of the thing,
  not of the algorithm.
- **Feature extraction** is shown, not described: marks appear on the photograph
  as they are found, then two frames side by side with the surviving matches in
  turquoise and the rejects in red. Counts and ratios live in the inspector for anyone
  who wants them.
- **The curve** during training plots both scores — trained-on and held-out —
  with markers at the moments the optimiser changes its own setup. The gap
  between the two lines is the whole overfitting lesson in one picture.

## Interactive during training

Play / pause / +1000 cycles / 1× 4× 16×, plus:

- **Camera positions keep moving** — toggling pose refinement, with a line saying
  what that costs when it is off.
- **Compare with** — a pre-baked ghost run drawn behind the live curve: half the
  photos, fixed cameras, a quarter of the splats. Turns "why does capture matter"
  from a claim into a comparison.
- Free orbit at any time; the current training camera flashes in the 3D view.
- `Space` play/pause, `←/→` step through frames.

## Capture guide (the education piece, for a later release)

Reachable from the top bar and from the start screen. Five rules, misconception
first: *turning on the spot records nothing*. Each has a diagram in the same
visual language as the 3D stage (camera frustums, subject, path). This is the
thing that saves a first-time user from a wasted capture, and it is why the
solve tab also reports **measured parallax** with a verdict — the guide's advice
and the app's diagnosis use the same words.

## What is deliberately not here

- **Importing COLMAP poses.** The demo is end-to-end in the browser. Bringing
  your own reconstruction is a later power-user path, not a button on the main flow.
- Training hyperparameters. The three knobs above are educational; a settings
  drawer for the rest can come later behind **Detail**.
- Accounts, sharing, storage.

---

## How the fake works (and what replaces it)

| Mockup | Real thing |
|---|---|
| `data.js` presets with measured numbers | `../data/index.json` + live stats |
| `scene.js` loads staged poses/cloud, or invents a plausible one | `runSfM()` output (`cams`, `points`) |
| `develop.js` renders the photo as a coarse blob field that sharpens | `trainer.renderTrainCam(cam, ctx)` |
| `viewport.js` — 2D-canvas painter's renderer | `trainer.renderView(pose, ctx)` |
| `psnrAt()` saturating curve | `trainer.readLoss()` / `evalCamPsnrRefined()` |
| staged `run()` timers | the real stage promises |

The seams are deliberately narrow. Wiring up means replacing four calls:

1. `drawStage()` → trainer render instead of `Developer` / `Viewport`
2. `psnrAt()` → sampled loss + holdout evaluation
3. `advance()` → `runSfM` / `initGaussians` / `GSTrainer.create` / `stepOnce`
4. `scene.js` → real `cams` / `points` from the solve

Everything else — stepper, rail, filmstrip, inspector, loupe, chart, guide — is
already state-driven and does not care where the numbers come from.

Preset numbers (`data.js`) are the prototype's real measured results, so the mock
does not promise anything the trainer cannot deliver. The staged poses and clouds
used to make the 3D stage line up with the photographs are a mockup shortcut
only; no part of the UI exposes them.

## Files

Shared modules live in `js/`; each version owns only its shell.

```
index.html        v1 shell: top bar, start screen, lab, guide dialog
css/app.css       tokens + components
js/data.js        presets, copy, glossary, events, ghost runs, guide
js/app.js         state machine, phases, rail, strip, inspector, transport
js/scene.js       frame list, poses, sparse cloud, per-frame numbers
js/viewport.js    3D stage: cloud, splats, frustums, orbit, lock-to-camera
js/develop.js     the comparison surface: blob-field render, loupe, swipe, error
js/chart.js       the score curve with event markers and a ghost run
js/marks.js       landmark + match overlays (shared)
js/img.js         one decode per photo (shared)
v2/               the tech-demo cut — see v2/README.md
```
