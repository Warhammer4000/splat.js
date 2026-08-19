# v2 — the tech-demo cut

```
cd Browser_3DGS && node serve.mjs 8734
# http://localhost:8734/mockup/v2/
```

Same subject as [v1](../README.md), a third of the surface. v1 turned into a web
app with a six-step pipeline, a rail of copy and a four-tab inspector. This one
is a toy you press play on.

## The whole thing

**One screen. Four states.**

```
ready  →  prep  →  train  →  done        (+ Details, on demand, once done)
```

- **ready** — the set is already loaded. The frames sit in the strip along the
  bottom, the first photo fills the stage, and one card asks for one click:
  *Start training*. Scene picker in the header, nothing else.
- **prep** — the solve runs itself. Four beats, about eight seconds, each one
  visible on the big stage: landmarks appearing on a photo → two frames with the
  matches that survived → cameras dropping into place around the cloud → points
  becoming blobs. The dock reads out what is happening; you cannot get it wrong
  because there is nothing to press.
- **train** — the main event. The stage is the render, sharpening. Orbit the
  model, or stay locked to a frame and drag the loupe over it to see the
  photograph underneath. Play/pause, 1×/4×/16×, cycle count, blob count, the
  score curve, both scores. Frames pulse in the strip as they get sampled.
- **done** — chrome recedes, the model gets the whole screen. The dock carries
  the honest number, and: compare with the hidden photo · replay · export.

**Details** is a separate view, and it only exists after the run: landmarks,
matching and the camera solve, each with its own picture, plus the score curve
and what the gap between the two lines means. Everything that would have made
the main screen heavy lives here, where someone who is now curious will go
looking for it.

## What changed from v1

| v1 | v2 |
|---|---|
| gallery page, then a lab | one screen, scene picker in the header |
| 6-step stepper you click through | prep runs itself, 4 automatic beats |
| left rail of explanation, always | a status line while prepping, nothing after |
| 4-tab inspector, always open | one Details view, only when done |
| ghost runs, pose-refinement toggle, capture guide | dropped |
| landmarks as a step you stop on | landmarks as a beat you watch, and a section you can return to |

Kept from v1 because they carry the demo: the loupe, the filmstrip, the two-line
score curve, and the full-bleed result.

## Code

Shares every module with v1 — `../js/{data,scene,viewport,develop,chart,marks,img}.js`.
Only the shell is new:

```
v2/index.html      header, stage, strip, dock, details sheet
v2/css/v2.css      imports v1's tokens and components, replaces the layout
v2/js/app.js       four states, the prep timeline, the dock, the details sheet
```

`window.__v2` exposes the state object for poking at from the console.

Wiring it to the real trainer is the same four seams listed in
[v1's README](../README.md#how-the-fake-works-and-what-replaces-it) — plus the
prep timeline, which becomes the actual `runSfM` / `initGaussians` progress
instead of a clock.
