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
  the stage. One card sits on top of it carrying the five sets as five
  thumbnails plus a [+] tile for your own photos (click one, it loads
  immediately), what this set is, where it comes
  from with links to the paper and the image set, the fact that everything runs
  in this tab, and *Start training*. No description of the scene — the button
  already says there is no 3D yet. Once a run starts, the top left keeps the set
  name and a **← Train another set** button: that reopens this same card over the
  running job, with a Cancel. Nothing is thrown away until a different set is
  actually picked — clicking the set you are already on just closes the card.
- **prep** — the solve runs itself. Four beats, about eight seconds, each one
  visible on the big stage: landmarks appearing on a photo → two frames with the
  matches that survived → cameras dropping into place around the cloud → points
  becoming splats. The dock reads out what is happening; you cannot get it wrong
  because there is nothing to press.
- **train** — the main event. The stage is the model, sharpening. Play/pause,
  1×/4×/16×, cycle count, splat count, the score curve, both scores. Frames pulse
  in the strip as they get sampled.
- **done** — chrome recedes, the model gets the whole screen. The dock carries
  the honest number, and: compare with the hidden photo · replay · export .ply ·
  **Export to Arrival.Space** (the primary action — the demo's reason to exist is
  putting the result somewhere).

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

## One camera, no modes

There is no "Model" / "Frame N" switch. There is a camera, and a frame is a place
it can be:

- **Click any frame** (strip, or ←/→) and the camera jumps to where that
  photograph was taken. The photograph is then drawn *on* the model it lines up
  with — pose and intrinsics are the frame's own, so it registers exactly. The
  model keeps rendering outside the photo's frame, which is what makes it read as
  one scene rather than two pictures.
- **The photograph is the top layer, and every reveal takes some of it away.**
  *Swipe* wipes it off from the divider (photograph left, render right),
  *Loupe* punches a hole in it, *Render* removes it entirely, *Error* replaces
  both with the difference. That is the same mechanic the real thing will have:
  a 2D image lying over a live render, removed to show what is underneath.
- **Drag** and the camera simply moves off. It starts from the frame's exact
  position, orientation and focal length, so nothing jumps; the photograph fades
  out because it no longer lines up. Click another frame to snap onto that one.

The reveal controls only exist while the camera is on a frame, so there is never a
control that does nothing.

*Mockup detail:* what the reveal uncovers should be — and in the wired-up version
will be — the live render, because there is only ever one render. Here it is
`develop.js`'s photo-derived field instead, because this mockup's "model" is a 26k
sparse SfM cloud: revealing it next to a photograph reads as a broken
reconstruction while the score bar claims 25 dB. Open **`?reveal=model`** to see
the honest version — same code path, `base:false` passed to `Developer.render`,
nothing underneath but the 3D view. That is the one line to delete when the real
rasterizer is behind it.

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
