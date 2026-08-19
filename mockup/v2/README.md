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

- **ready** — the set is already loaded: frames in the strip, first photo filling
  the stage. One card sits on top of it, and it leads with **your own photos** —
  a drop zone and a *Choose photos* button, the only filled button on the card.
  Below a divider come the five ready-made sets as thumbnails (click one, it
  loads immediately), what that set is, where it comes from with links to the
  paper and the image set, the fact that everything runs in this tab, and an
  outlined *Start training*.

  **Dropping photos actually works.** They are decoded in the page, kept as
  object URLs, and become a set like any other: the strip fills with them, the
  prep beats mark landmarks on them, and the training compares against them. The
  geometry is invented (there is no solver here) but its colours are sampled from
  the first photo, so the stand-in cloud at least belongs to the scene. No description of the scene — the button
  already says there is no 3D yet. Once a run starts, the top left keeps the set
  name and a **← Train another set** button, which reopens this same card over the
  running job with an × in its corner. There it is a chooser, not a switch:
  clicking a tile only chooses (the card repaints for that set), the run behind it
  carries on untouched, and nothing loads until **Start training** commits. × or
  Esc goes back to the run.
- **prep** — the solve runs itself. Four beats, about eight seconds, each one
  visible on the big stage: landmarks appearing on a photo → two frames with the
  matches that survived → cameras dropping into place around the cloud → points
  becoming splats. The dock reads out what is happening; you cannot get it wrong
  because there is nothing to press.
- **train** — the main event. It opens on the model itself with **no frame
  selected**, so the first thing you watch is the thing that is changing. The
  camera starts near the first usable frame (never the held-back one) and stepped
  back, so that is roughly the photographer's view rather than an arbitrary
  orbit. Stepping onto a photograph — and the reveal that comes with it — is a
  deliberate click. A status
  strip sits directly under the header — play/pause, 1×/4×/16×, cycle count,
  splat count, the score curve, both scores — so the photographs keep the bottom
  of the screen to themselves. Frames pulse in the strip as they get sampled.
- **done** — the status bar disappears entirely and the model gets everything
  between the header and the filmstrip, with the camera frustums left on faintly so it still
  reads as a reconstruction. Top right carries a readout of what the run came to
  — *92,000 splats · 25.6 dB · 3 min · Details ›* — which opens the sheet, and a
  round **export** button beside it whose menu offers Arrival.Space or a .ply.
  The same export control sits in the sheet header next to its ×.

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

## The model, and how it gets better

`viewport.js` is the only renderer: project, bucket-sort by depth, composite soft
sprites back to front. The scene is seeded the way the trainer seeds it — one
splat per landmark plus jittered clones, ~80–90k — and **quality is a function of
training progress**, so the thing you watch improve is the model itself:

| | early | late |
|---|---|---|
| capacity | ~28% of the set drawn | all of it |
| position | displaced along a per-splat random direction | settled on the landmark |
| size | fat | tight |
| colour | washed toward grey | resolved |
| opacity | thin | firm |
| floaters | present | recycled away past 45% |

It re-rasterises only when the camera or the training state moves, at reduced
capacity while the camera is actually moving and one full pass once it stops —
the same progressive trick every splat viewer uses.

## One camera, no modes

There is no "Model" / "Frame N" switch. There is a camera, and a frame is a place
it can be:

- **Click any frame** (strip, or ←/→) and the camera jumps to where that
  photograph was taken. The photograph is then drawn *on* the model it lines up
  with — pose and intrinsics are the frame's own, so it registers exactly. The
  model keeps rendering outside the photo's frame, which is what makes it read as
  one scene rather than two pictures.
- **The photograph is the top layer, and every reveal takes some of it away.**
  *Swipe* wipes it off from the divider (photograph left, render right), *Loupe*
  punches a hole in it, *Error* replaces both with the difference. Swipe is where
  a frame always opens; change it and the choice sticks as you move between
  frames. There is no "off" — a mode that does nothing is not a mode.
- **Drag** and the camera simply moves off. It starts from the frame's exact
  position, orientation and focal length, so nothing jumps; the photograph fades
  out because it no longer lines up. Click another frame to snap onto that one.

The reveal controls only exist while the camera is on a frame, so there is never a
control that does nothing.

There is no second renderer and no preview image. `develop.js` never draws the
model — it only lays the photograph over whatever `viewport.js` has put on the
canvas and takes some of it away again, and the error map is a genuine read-back
of those pixels diffed against the photograph. Wiring the trainer in means
swapping what fills the canvas, and nothing else.

## What it says it is

Clicking the wordmark opens a short panel: what Splat.js does (photographs in,
landmarks, matching, camera solve, splats, training, a standard `.ply` out), a
highlighted note that nothing is uploaded — no server, no cloud, no account, the
photographs are decoded in the page and go nowhere — the GitHub link, and
*Made by Stratum1 GmbH*. Esc, ×, or a click outside closes it.

## Which way is up

A COLMAP-style world has **+Y pointing down**, so a staged scene arrives on its
head. `scene.js` asks the cameras — each one's world-space up is minus its second
row — and if they disagree with the viewer it rotates the whole scene 180° about
X. That is a real rotation, so nothing mirrors, and applying R·F to the poses
leaves every projection identical: a frame still lines up with its photograph to
the pixel. Procedurally posed scenes already agree and are left alone.

## Words

They are **splats** everywhere in the UI, not "blobs" — the product is called
Splat.js and that is the word people will look up. The Details sheet defines it
once, in plain language: *a splat is a soft 3D blob with a position, a size along
three axes, an orientation, a colour and a transparency.*

## Colour

Turquoise = live / selected / primary. Amber = the frame held back from training
and its score. Red = trouble. Corners are round; controls are pills.

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
