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
import { cutoutsCard } from './ui/cutouts.js';

export { isAvatar, STAGES, STAGE_LABEL, nextStage } from './manifest.js';
export { afterTraining } from './runner.js';

export async function prepareCapture(frames, source, { card, flash = () => {}, log = (m) => console.log('[avatar]', m) }) {
  const meter = (title, sub) => {
    card.innerHTML = `
      <div class="vid-head"><b>${title}</b><span class="prep-sub" id="av-sub">${sub}</span></div>
      <div class="prep-meter"><i id="av-bar" style="width:0%"></i></div>`;
  };
  meter('Cutting the person out', 'loading the matting model …');
  const manifest = newManifest(source);
  setStage(manifest, 'matte', { status: 'running' });
  let res;
  try {
    const { run } = await import('./stages/matte.js');
    res = await run(frames, {
      log,
      onProgress: (d, t) => {
        const bar = card.querySelector('#av-bar'), sub = card.querySelector('#av-sub');
        if (bar) bar.style.width = `${(d / t) * 100}%`;
        if (sub) sub.textContent = `${d} / ${t} frames`;
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
    session: { evalSplit: 0, initTarget: 100000 },
    trainer: { maxSplats: 600000, capMult: 8 },
    iters,
  };
}
