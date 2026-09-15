// index.js — avatar mode, the app's one import. Lazy-loaded when the box on
// the video review card is ticked; the app keeps two touch points:
//
//   prepareCapture(frames, source, ui)  after the frames are captured, before
//       training: cuts the person out (matte stage) and asks "is this the
//       person?". Resolves the manifest to hang on the capture record, or
//       null when the user says it is not an avatar (the run continues as a
//       plain scene).
//   trainingOptions(manifest)            what the session needs for a
//       masked, avatar-sized run.
//   afterTraining(...)                   the remaining stages (landmarks,
//       face pass, body fit, bind, publish) — see runner.js.
//
// Everything avatar-specific lives under app/avatar/; src/ stays generic.
import { newManifest, setStage } from './manifest.js';
import { solveTierOpts } from '../../src/sfm/sfm.js';
import { cutoutsCard } from './ui/cutouts.js';

export { isAvatar, STAGES, STAGE_LABEL, nextStage, setStage } from './manifest.js';
export { afterTraining } from './runner.js';
export { addPersonCrops } from './crops.js';
export { faceSeedPoints, faceSeedGaussians } from './faceseed.js';
export { headSeedGaussians } from './headseed.js';   // the whole head from the fitted body model, protected from relocation   // a dense seed on the face mesh, next to the sparse cloud   // native windows of the person as extra cameras, between solve and seed

export async function prepareCapture(frames, source, { card, flash = () => {}, log = (m) => console.log('[avatar]', m) }) {
  const meter = (title, sub) => {
    card.innerHTML = `
      <div class="vid-head"><b>${title}</b><span class="prep-sub" id="av-sub">${sub}</span></div>
      <div class="prep-meter"><i id="av-bar" style="width:0%"></i></div>
      <canvas class="prep-cut" id="av-cut" width="300" height="300"></canvas>`;
  };
  meter('Cutting the person out', 'loading the matting model …');
  // the frame just cut, shown while the matte runs (photo x matte over the panel colour);
  // one draw at a time — a slow decode never queues behind the next frame
  let drawing = false;
  const showCut = async (f) => {
    const cv = card.querySelector('#av-cut'); if (!cv || drawing || !f || !f.mask) return;
    drawing = true;
    try {
      const [bmp, mask] = await Promise.all([createImageBitmap(f.source), createImageBitmap(f.mask)]);
      const h = 300, w = Math.round((bmp.width / bmp.height) * h);
      if (cv.width !== w) { cv.width = w; cv.style.width = `${w / 2}px`; }
      const tmp = new OffscreenCanvas(w, h); const t = tmp.getContext('2d');
      t.drawImage(bmp, 0, 0, w, h); t.globalCompositeOperation = 'destination-in';
      const m = new OffscreenCanvas(w, h); const mg = m.getContext('2d'); mg.drawImage(mask, 0, 0, w, h);
      const md = mg.getImageData(0, 0, w, h); const ad = mg.createImageData(w, h);
      for (let p = 0; p < w * h; p++) ad.data[p * 4 + 3] = md.data[p * 4];
      mg.putImageData(ad, 0, 0); t.drawImage(m, 0, 0);
      const g = cv.getContext('2d'); g.clearRect(0, 0, w, h); g.drawImage(tmp, 0, 0);
      bmp.close(); mask.close(); cv.classList.add('on');
    } catch (e) { /* preview only */ } finally { drawing = false; }
  };
  const manifest = newManifest(source);
  setStage(manifest, 'matte', { status: 'running' });
  let res;
  try {
    const { run } = await import('./stages/matte.js');
    res = await run(frames, {
      log,
      onProgress: (d, t, f) => {
        const bar = card.querySelector('#av-bar'), sub = card.querySelector('#av-sub');
        if (bar) bar.style.width = `${(d / t) * 100}%`;
        if (sub) sub.textContent = `${d} / ${t} frames`;
        showCut(f);
      },
    });
  } catch (e) {
    log(`matte failed: ${e.message || e}`);
    flash(`Could not cut the person out (${e.message || e}) — continuing as a scene.`, 8000);
    return null;
  }
  setStage(manifest, 'matte', { status: 'done', ...res });
  if (res.coverage < 0.02) {
    flash('Almost nothing was recognised as a person in these frames — continuing as a scene.', 8000);
    for (const f of frames) delete f.mask;
    return null;
  }
  const ok = await cutoutsCard(card, frames, res);
  if (!ok) {
    for (const f of frames) delete f.mask;
    return null;
  }
  return manifest;
}

/** Session/trainer options for the masked run. The session turns the masks
 *  into the random-background target, the seed filter and the hull on its
 *  own; here only the sizing differs from a scene: a person is one subject,
 *  not a room. */
export function trainingOptions(manifest, { iters = 30000 } = {}) {
  return {
    // the precise solve tier: an orbit around a person is a small, low-texture
    // scene, and the quick/standard tiers collapsed a 1080p orbit into a
    // rotation-only solution once (2026-09-13) — nothing downstream survives that
    // the person trains as part of the ROOM (maskTraining false: the mattes
    // stay for the hull and the cut after the face pass) — the masked recipe
    // gave needle ratio 344 vs 15 for the same clip trained whole (2026-09-14b)
    // SH on the horizontal part of the view direction only (default since 2026-09-14):
    // an orbit never looks down at a person, so the vertical colour variation was
    // unconstrained — blotches from above; the highlight still turns with the walk-around.
    // ?shup=0 keeps full SH (experiment).
    session: { evalSplit: 0, initTarget: 100000, sfm: solveTierOpts('precise'), maskTraining: false, shHorizontal: !(typeof location !== 'undefined' && new URLSearchParams(location.search).get('shup') === '0') },
    // the 600k cap is hit at 30k+ with the person crops, but lifting it to 1M only
    // grew low-opacity splats the export prunes (package 108.9k either way; 2026-09-14)
    // ?camopt=1 (experiment, 2026-09-14): photometric pose refinement of every camera
    // during training — Filip's front views ghost (the head moved between the far
    // start and the close-up end of the orbit); the target is per-window pose
    // freedom for the crops, this is the first check that the mechanism helps
    // ?avsh=N (experiment): the avatar run's SH degree (the app's ?sh= is not a URL switch)
    // opacity pressure 0.004 for a person (trainer default 0.01): the pressure dims what
    // the loss does not defend, and on an avatar that is the face — at 0.003 the visible
    // face splats doubled at smaller sizes, at 0 the skin went waxy (Tom 30k, 2026-09-15d)
    // needle term 0.03 (2026-09-15f): needles 5.3 % -> 1.5 % on the face, discs and the
    // visible count untouched — the one shape term with no measured cost
    trainer: { maxSplats: 600000, capMult: 8, opacityReg: 0.004, needleReg: 0.03, ...(typeof location !== 'undefined' && new URLSearchParams(location.search).get('avsh') != null ? { shDeg: +new URLSearchParams(location.search).get('avsh') } : {}), ...(typeof location !== 'undefined' && new URLSearchParams(location.search).get('camopt') ? { camOpt: true, ...(new URLSearchParams(location.search).get('camopt') === 'crop' ? { camOptOnly: 'crop' } : {}) } : {}),
      // ?needle=W[,T] (experiment, 2026-09-15): the needle regularizer — the longest axis over
      // the middle one beyond ratio T (default 3) is pulled in; discs stay ("every needle
      // destroys the illusion in a close-up")
      ...(typeof location !== 'undefined' && new URLSearchParams(location.search).get('needle') ? (() => { const [w, t] = new URLSearchParams(location.search).get('needle').split(',').map(Number); return { needleReg: w, ...(t > 1 ? { needleRatio: t } : {}) }; })() : {}),
      // ?orient=W (experiment, 2026-09-15): the orientation regularizer — discs turn to face
      // the cameras that see them (a disc seen edge-on draws a line; a quarter of Tom's
      // visible face splats were edge-on to the frontal camera)
      ...(typeof location !== 'undefined' && new URLSearchParams(location.search).get('orient') ? { orientReg: +new URLSearchParams(location.search).get('orient') } : {}),
      // ?blob=R (experiment, 2026-09-15): only train blobs — a hard clamp after every Adam step
      // keeps each splat's longest axis within R x its shortest (the user's rule: no needles, no
      // edge-on discs, a near-round volume never draws a line)
      ...(typeof location !== 'undefined' && +new URLSearchParams(location.search).get('blob') > 1 ? { blobRatio: +new URLSearchParams(location.search).get('blob') } : {}),
      // ?camlr=N (experiment, 2026-09-15): multiplier on the pose learning rates of ?camopt
      ...(typeof location !== 'undefined' && +new URLSearchParams(location.search).get('camlr') > 0 ? { camLr: +new URLSearchParams(location.search).get('camlr') } : {}),
      // ?opreg=N (experiment, 2026-09-15): the opacity pressure (trainer default 0.01) — the visible face density lever
      ...(typeof location !== 'undefined' && new URLSearchParams(location.search).get('opreg') != null ? { opacityReg: +new URLSearchParams(location.search).get('opreg') } : {}) },
    iters,
  };
}
