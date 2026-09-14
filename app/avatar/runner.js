// runner.js — walks the stages after training and shows one card for them.
//
// Each stage module exports { id, needs, run(ctx, manifest, hooks), review? }.
// The runner skips what the manifest says is done, shows the review card
// when a stage has one, and stops at the first card the user rejects. The
// app hands it the finished session and the capture record; it hands back
// the updated manifest (the app persists it).
import { STAGES, STAGE_LABEL, setStage, nextStage } from './manifest.js';

const LOADERS = {
  landmarks: () => import('./stages/landmarks.js'),
  facepass: () => import('./stages/facepass.js'),
  cut: () => import('./stages/cut.js'),
  facepolish: () => import('./stages/facepolish.js'),
  bodyfit: () => import('./stages/bodyfit.js'),
  bind: () => import('./stages/bind.js'),
  publish: () => import('./stages/publish.js'),
};

export function stageList(manifest) {
  return STAGES.map((s) => {
    const st = manifest.stages[s] || { status: 'todo' };
    const cls = st.status === 'done' ? 'done' : st.status === 'running' ? 'running' : st.status === 'failed' ? 'failed' : '';
    return `<li class="${cls}"><span>${STAGE_LABEL[s]}</span><em>${st.status === 'done' && st.note ? st.note : st.status === 'todo' ? '' : st.status}</em></li>`;
  }).join('');
}

/** ctx: { session, frames, manifest, capture, log, flash, mount } */
export async function afterTraining(ctx) {
  const { manifest, mount, log = () => {}, flash = () => {} } = ctx;
  setStage(manifest, 'train', { status: 'done', iters: ctx.session.trainer.iter, splats: ctx.session.trainer.n, note: `${ctx.session.trainer.n.toLocaleString()} splats` });
  const card = document.createElement('div');
  card.className = 'upcard av-card';
  card.id = 'avcard';
  mount(card);
  const paint = (sub = '') => {
    card.innerHTML = `
      <button class="card-x" id="av-x" aria-label="Close">&times;</button>
      <div class="vid-head"><b>Your avatar</b><span class="prep-sub" id="av-sub">${sub}</span></div>
      <ol class="av-stages" id="av-stages">${stageList(manifest)}</ol>
      <div class="prep-meter" id="av-meterwrap" hidden><i id="av-bar" style="width:0%"></i></div>
      <div id="av-body"></div>`;
    card.querySelector('#av-x').onclick = () => { ctx.cancelled = true; card.remove(); };
  };
  paint('the trained splat is isolated — next: joints, face, body, binding');
  const hooks = {
    progress: (d, t, msg) => {
      const w = card.querySelector('#av-meterwrap'), b = card.querySelector('#av-bar'), s = card.querySelector('#av-sub');
      if (w) w.hidden = false; if (b) b.style.width = `${(100 * d) / Math.max(1, t)}%`; if (s && msg) s.textContent = msg;
    },
    body: () => card.querySelector('#av-body'),
    log, flash,
  };
  // stages that ran before training (landmarks, for the head windows) still get
  // their look — the joints card — before the rest continues
  for (const s0 of STAGES) {
    const st = manifest.stages[s0]; if (!st || st.status !== 'done' || !st.reviewPending || ctx.cancelled) continue;
    delete st.reviewPending;
    let mod = null; try { mod = LOADERS[s0] ? await LOADERS[s0]() : null; } catch (e) { mod = null; }
    if (mod && mod.review) { paint(); const ok = await mod.review(ctx, manifest, hooks); if (!ok) { setStage(manifest, s0, { status: 'rejected' }); paint('stopped here — adjust and run again'); return manifest; } paint(); }
  }
  let s;
  while ((s = nextStage(manifest)) && !ctx.cancelled) {
    if (s === 'matte' || s === 'train') { setStage(manifest, s, { status: 'done' }); continue; }
    const loader = LOADERS[s];
    if (!loader) { setStage(manifest, s, { status: 'skipped', note: 'not built yet' }); continue; }
    if (s === 'facepolish' && !(typeof location !== 'undefined' && new URLSearchParams(location.search).get('facepolish'))) { setStage(manifest, s, { status: 'skipped', note: 'off' }); continue; }   // experiment: ?facepolish=1
    let mod;
    try { mod = await loader(); } catch (e) { setStage(manifest, s, { status: 'skipped', note: 'not built yet' }); paint(); continue; }
    setStage(manifest, s, { status: 'running' }); paint(`${STAGE_LABEL[s]} …`);
    try {
      const res = await mod.run(ctx, manifest, hooks);
      setStage(manifest, s, { status: 'done', ...res });
      if (mod.review) {
        paint();
        const ok = await mod.review(ctx, manifest, hooks);
        if (!ok) { setStage(manifest, s, { status: 'rejected' }); paint('stopped here — adjust and run again'); break; }
      }
    } catch (e) {
      log(`${s} failed: ${e.message || e}`);
      setStage(manifest, s, { status: 'failed', note: String(e.message || e).slice(0, 80) });
      paint(`${STAGE_LABEL[s]} failed`);
      break;
    }
    paint();
    ctx.persist?.(manifest);
  }
  if (!s && !ctx.cancelled) paint('done');
  return manifest;
}
