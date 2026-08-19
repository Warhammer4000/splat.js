// Splat.js — the app. One screen, four states:
//
//   ready → prep → train → done      (+ Details, on demand, once done)
//
// The interaction model is the v2 mockup's, verbatim; underneath it now sits
// the real library: prep beats are the solver's own progress events, the
// model on the stage is the WebGPU trainer's render, the curve is measured
// PSNR, and Export writes a real .ply. The UI talks to ONE object — the
// splat.js Session — plus the trainer's rendered canvas.

import { createSession, gaussiansToPly } from '../../src/index.js';
import { extractSharpFrames, isVideoFile } from '../../src/io/video.js';
import { recordCaptureVideo, cameraSupported } from './camera.js';
import { handleOAuthCallback, sendToArrival, hasToken } from './arrival.js';
import { PRESETS, REPO, DATA, HOLD_HELP, ownSet } from './data.js';
import { Viewport, camCentre } from './viewport.js';
import { Developer, fitRect } from './develop.js';
import { Chart } from './chart.js';
import { bmp, readyBmp } from './img.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// short first run (phones especially) — the done screen offers "+10k cycles"
// which stretches the trainer's schedules and resumes. 20k, not 10k: with a
// 10k horizon the growth phase is squeezed against too few settle iterations
// and the model comes out over-grown for its polish time.
const INITIAL_ITERS = 20000;
const MORE_ITERS = 10000;

const S = {
  state: 'ready',              // ready | prep | train | done
  preset: null,
  session: null,
  photos: [],                  // [{ url, name }] — the strip + overlays
  scene: null,                 // { cams, center, radius, xyz, rgb } for overlays
  sel: 0, atFrame: -1, compare: 'swipe',
  pending: null, picking: false,
  ownUrls: null,
  fade: 0, fadeTo: 0,
  loupe: { x: 0, y: 0, r: 104 }, swipe: .5, rect: null,
  iter: 0, splats: 0, psnrTrain: null, psnrHold: null, itersPerSec: 0,
  minutes: 0, trainT0: 0,
  prep: null,                  // latest solve stage event
  feats: new Map(),            // image -> { n, x, y } (real keypoints)
  lastPairEv: null,            // latest surviving pair with sample matches
  regCams: [],                 // cameras as they register (beat 3)
  solveStats: { pairsChecked: 0, pairsUsable: 0, solveSec: 0 },
  chartEvents: [],             // real refine/growth moments for the curve
  flash: null,
  detailTab: 'marks',
  keys: new Set(),             // held WASD keys (camera-relative fly)
  maxIters: INITIAL_ITERS,     // grows when the user continues training
  gen: 0,                      // run generation — stale async work checks it
};

let vp, dev, chart, dchart, dvp;
let gpuCanvas = null;          // the trainer renders here; the stage blits it

// the OAuth popup lands back on this page with ?code= — report and close
if (!handleOAuthCallback()) boot();

// ── boot ────────────────────────────────────────────────────────────────────
function boot() {
  buildSetPicker();

  vp = new Viewport($('cv'));
  vp.onLeave = leaveFrame;
  dev = new Developer();

  $('btn-go').addEventListener('click', async () => {
    if (S.picking) { const p = S.pending || S.preset; closePicker(); await open(p, true); return; }
    startPrep();
  });
  $('btn-new').addEventListener('click', (e) => { e.stopPropagation(); showPicker(); });
  $('card-x').addEventListener('click', closePicker);
  $('file-input').addEventListener('change', (e) => useOwnPhotos(e.target.files));
  if (cameraSupported()) {
    const rb = $('btn-record');
    rb.hidden = false;
    rb.addEventListener('click', async () => {
      try {
        const got = await recordCaptureVideo();
        if (!got) return;
        if (got.kind === 'video') useOwnVideo(got.file);
        else useOwnPhotos(got.files);   // stills: straight in, no extraction
      } catch (e) {
        console.error(e);
        flash(`Camera unavailable: ${e.message}`, 6000);
      }
    });
  }

  const card = $('start');
  ['dragenter', 'dragover'].forEach((t) => card.addEventListener(t, (e) => {
    e.preventDefault(); card.classList.add('drop');
  }));
  ['dragleave', 'dragend'].forEach((t) => card.addEventListener(t, () => card.classList.remove('drop')));
  card.addEventListener('drop', (e) => {
    e.preventDefault(); card.classList.remove('drop');
    useOwnPhotos(e.dataTransfer.files);
  });
  $('d-close').addEventListener('click', () => { $('details').hidden = true; });

  addEventListener('resize', () => { vp.resize(); chart?.resize(); dchart?.resize(); dvp?.resize(); });
  const WASD = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'];
  addEventListener('keydown', (e) => {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (!$('about').hidden) { if (e.key === 'Escape') $('about').hidden = true; return; }
    if (!$('details').hidden) { if (e.key === 'Escape') $('details').hidden = true; return; }
    if (S.picking && e.key === 'Escape') { closePicker(); return; }
    if (e.key === ' ' && S.state === 'train') { e.preventDefault(); toggleTrain(); }
    if (e.key === 'ArrowRight') select(S.sel + 1);
    if (e.key === 'ArrowLeft') select(S.sel - 1);
    if (WASD.includes(e.code)) S.keys.add(e.code);
  });
  addEventListener('keyup', (e) => S.keys.delete(e.code));
  addEventListener('blur', () => S.keys.clear());
  wireStage();

  addEventListener('click', (e) => {
    if (!e.target.closest('.exportwrap')) {
      document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; });
    }
    if (S.picking && !e.target.closest('#start')) closePicker();
  });

  $('gh').href = REPO;
  $('about-gh').href = REPO;
  $('brand').addEventListener('click', (e) => { e.stopPropagation(); $('about').hidden = false; });
  $('about-x').addEventListener('click', () => { $('about').hidden = true; });
  $('about').addEventListener('click', (e) => {
    if (!e.target.closest('.about-card')) $('about').hidden = true;
  });

  if (!navigator.gpu) {
    flash('This demo needs WebGPU — use a current Chrome or Edge.', 60000);
  }
  window.__splat = S;          // console access
  open(PRESETS[0]);
  requestAnimationFrame(loop);
}

function buildSetPicker() {
  const host = $('setpick');
  host.innerHTML = '';
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.dataset.id = p.id;
    b.innerHTML = `<div class="ph"></div><span>${p.name}</span>`;
    b.addEventListener('click', () => {
      if (S.picking) { S.pending = p; paintCard(p); return; }
      if (p === S.preset) return;
      open(p);
    });
    host.appendChild(b);
    const url = presetUrl(p, p.start);
    const img = Object.assign(new Image(), { src: url, alt: '' });
    img.onload = () => b.querySelector('.ph')?.replaceWith(img);
  }
}

function presetUrl(p, i) {
  return `${DATA}${p.dir}/` +
    p.pattern.replace(/\{i:(\d+)\}/, (_, w) => String(i).padStart(+w, '0'));
}

function paintCard(preset) {
  $('start-kind').textContent = preset.kind;
  $('start-title').textContent = preset.name;
  $('start-origin').textContent = preset.origin;
  $('start-links').innerHTML = (preset.links || [])
    .map((l) => `<a href="${l.url}" target="_blank" rel="noopener">${l.label}</a>`).join('')
    + (preset.approx ? `<span class="approx">${preset.approx} on a fast GPU</span>` : '');
  $('card-runs').hidden = false;
  $('btn-go').textContent = 'Start training';
  [...$('setpick').children].forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.id === preset.id)));
  $('upload').classList.toggle('is-current', preset.id === '__own');
}

function showPicker() {
  if (S.state === 'ready') return;
  S.picking = true;
  S.pending = S.preset;
  paintCard(S.preset);
  $('card-x').hidden = false;
  $('start').hidden = false;
}

function closePicker() {
  S.picking = false; S.pending = null;
  $('start').hidden = true;
  $('card-x').hidden = true;
  $('btn-go').textContent = 'Start training';
}

async function useOwnPhotos(list) {
  const all = [...list];
  const video = all.find(isVideoFile);
  if (video) { useOwnVideo(video); return; }
  const files = all.filter((f) => f.type.startsWith('image/'));
  if (files.length < 2) {
    flash('Pick at least a couple of overlapping photos of the same place — or one video.', 4500);
    return;
  }
  if (S.ownUrls) S.ownUrls.forEach(URL.revokeObjectURL);
  S.ownUrls = files.map((f) => URL.createObjectURL(f));
  open(ownSet(files, S.ownUrls));
}

/** A video: pick its sharpest frames (the server pipeline's policy, run
 *  here) and continue exactly like a photo set. */
async function useOwnVideo(file) {
  const card = document.createElement('div');
  card.className = 'upcard';
  card.id = 'vidcard';
  card.innerHTML = `
    <b>Reading your video</b>
    <div class="prep-sub" id="vid-sub">decoding …</div>
    <div class="prep-meter"><i id="vid-bar" style="width:0%"></i></div>`;
  $('stage').appendChild(card);
  const LABEL = { scan: 'looking for the sharpest frames', capture: 'saving the winners' };
  try {
    const { frames, duration } = await extractSharpFrames(file, {
      log: (m) => console.log('[video]', m),
      onProgress: (e) => {
        const bar = $('vid-bar');
        if (!bar) return;
        const half = e.stage === 'scan' ? 0 : 50;
        bar.style.width = `${half + (e.done / e.total) * 50}%`;
        $('vid-sub').textContent = `${LABEL[e.stage]} · ${e.done} / ${e.total}`;
      },
    });
    if (frames.length < 12) {
      flash('That video is too short — a slow 20+ second pass works best.', 6000);
      return;
    }
    if (S.ownUrls) S.ownUrls.forEach(URL.revokeObjectURL);
    S.ownUrls = frames.map((f) => URL.createObjectURL(f.source));
    const set = ownSet(frames, S.ownUrls);
    set.kind = 'Your video';
    set.origin = `${frames.length} sharp frames picked from your ${Math.round(duration)}s video, ` +
      'right here in this tab. Blurred moments lost to their sharper neighbours.';
    open(set);
  } catch (e) {
    console.error(e);
    flash(`Could not read that video: ${e.message}`, 8000);
  } finally {
    card.remove();
  }
}

/** reset everything and show a set's start card (autostart commits a switch) */
async function open(preset, autostart = false) {
  S.gen++;
  if (S.session) { S.session.pause(); S.session.dispose(); }
  S.session = null;
  S.preset = preset;
  S.state = 'ready';
  S.picking = false; S.pending = null;
  S.scene = null;
  S.sel = 0; S.atFrame = -1; S.fade = 0; S.fadeTo = 0;
  S.iter = 0; S.splats = 0; S.psnrTrain = null; S.psnrHold = null;
  S.prep = null; S.feats = new Map(); S.lastPairEv = null; S.regCams = [];
  S.solveStats = { pairsChecked: 0, pairsUsable: 0, solveSec: 0 };
  S.chartEvents = [];
  S.maxIters = INITIAL_ITERS;
  S.holdHist = [];
  S.growthStopped = false;
  gpuCanvas = null;
  $('btn-go').textContent = 'Start training';
  $('card-x').hidden = true;
  $('card-runs').hidden = false;
  $('start').hidden = true;
  $('controls').hidden = true;
  $('btn-new').hidden = true;
  $('strip').innerHTML = '';
  dock('');
  vp.resize();
  vp.lock = null; vp.enabled = true; vp.scene = null;

  // the photographs: URLs only — decoding happens when the run starts
  if (preset.files) {
    S.photos = preset.files.map((f, i) => ({ url: preset.urls[i], name: f.name }));
  } else {
    S.photos = [];
    for (let k = 0, i = preset.start; k < preset.count; k++, i++) {
      S.photos.push({ url: presetUrl(preset, i), name: presetUrl(preset, i).split('/').pop() });
    }
  }
  buildStrip();
  paintCard(preset);
  bmp(S.photos[0].url);
  if (autostart) startPrep();
  else $('start').hidden = false;
}

// ── prep: the solve, live ───────────────────────────────────────────────────
const BEATS = [
  { id: 'decode',   label: 'Reading photographs' },
  { id: 'features', label: 'Finding landmarks' },
  { id: 'matching', label: 'Matching photos' },
  { id: 'cameras',  label: 'Placing cameras' },
  { id: 'seed',     label: 'Seeding splats' },
];
const beatIndex = (stage) =>
  ({ decode: 0, features: 1, matching: 2, focal: 3, register: 3, ba: 3, solved: 3, seed: 4 }[stage] ?? 0);

async function startPrep() {
  const gen = S.gen;
  $('start').hidden = true;
  $('btn-new').hidden = false;
  S.state = 'prep';
  S.prep = { stage: 'decode', done: 0, total: S.photos.length };
  dock('prep');

  try {
    // view buffers sized for the screen at 1x CSS pixels (the stage renders
    // at 1x — splats don't reward supersampling; clamps are pixel-count based)
    const mvW = Math.ceil(screen.width || 1280);
    const mvH = Math.ceil(screen.height || 800);
    S.viewPixBudget = Math.min(
      mvW * mvH,
      16000 * 256, // per-raster tile-grid cap (16k tiles of 16x16)
    );
    const session = createSession({
      maxIters: INITIAL_ITERS, holdout: 'auto', evalHoldEvery: 2500,
      maxViewW: mvW, maxViewH: mvH,
    });
    S.session = session;
    session.on('stage', (e) => { if (S.gen === gen) onStage(e); });
    session.on('metrics', (e) => { if (S.gen === gen) onMetrics(e); });
    session.on('event', (e) => { if (S.gen === gen) onTrainEvent(e); });

    // 1) decode
    let files;
    if (S.preset.files) {
      files = S.preset.files;
    } else {
      files = [];
      for (let i = 0; i < S.photos.length; i++) {
        const r = await fetch(S.photos[i].url);
        if (!r.ok) throw new Error(`could not fetch ${S.photos[i].name}`);
        files.push({ source: await r.blob(), name: S.photos[i].name });
        S.prep = { stage: 'decode', done: i + 1, total: S.photos.length };
        if (S.gen !== gen) return;
      }
    }
    await session.load(files);
    if (S.gen !== gen) return;

    // 2) solve — the beats are its real events
    const t0 = performance.now();
    await session.solve({ debug: (d) => { S.internals = d; } });
    if (S.gen !== gen) return;
    S.solveStats.solveSec = (performance.now() - t0) / 1000;

    // 3) seed + trainer
    S.prep = { stage: 'seed', done: 0, total: 1 };
    await session.seed();
    if (S.gen !== gen) return;

    buildSceneFromSession();
    gpuCanvas = document.createElement('canvas');
    session.view.attach(gpuCanvas);
    startTraining();
  } catch (e) {
    if (S.gen !== gen) return;
    console.error(e);
    flash(`That set did not solve: ${e.message}`, 12000);
    S.state = 'ready';
    dock('');
    $('start').hidden = false;
  }
}

function onStage(e) {
  if (S.state !== 'prep') return;
  S.prep = e;
  if (e.stage === 'features' && e.detail) {
    S.feats.set(e.detail.image, e.detail);
    S.sel = e.detail.image;
    paintStrip();
  }
  if (e.stage === 'matching' && e.detail) {
    S.solveStats.pairsChecked = e.done;
    S.solveStats.pairsUsable = e.detail.usable;
    if (e.detail.pair) { S.lastPairEv = e.detail.pair; S.sel = e.detail.pair.i; }
  }
  if (e.stage === 'register' && e.detail && e.detail.R) {
    const fr = S.session.frames[e.detail.image];
    S.regCams.push({
      i: e.detail.image, R: e.detail.R, t: e.detail.t, f: e.detail.f,
      w: fr.fw, h: fr.fh, cx: fr.fw / 2, cy: fr.fh / 2, state: 'placed',
    });
    // keep an orbit that frames the growing camera set
    const cs = S.regCams.map(camCentre);
    const c = cs.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0])
      .map((v) => v / cs.length);
    const r = Math.max(1e-3, ...cs.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])));
    vp.scene = { center: c, radius: r * 1.2, xyz: null, rgb: null };
    if (S.regCams.length === 3) { vp.detectUp(S.regCams); vp.frameScene(); }
  }
}

/** the display-side scene: every photograph, placed or not, plus the cloud */
function buildSceneFromSession() {
  const ses = S.session;
  const recon = ses.recon;
  const cams = S.photos.map((p, i) => ({
    i, url: p.url, name: p.name, R: null, t: null, state: 'unplaced', ci: -1, psnr: null,
  }));
  ses.trainer.camMeta.forEach((m, ci) => {
    const c = cams[m.imgIdx];
    const fr = ses.frames[m.imgIdx];
    Object.assign(c, {
      R: m.R, t: m.t, f: recon.cams.find((rc) => rc.imgIdx === m.imgIdx).f,
      w: fr.fw, h: fr.fh, cx: fr.fw / 2, cy: fr.fh / 2,
      state: ci === ses.holdout ? 'holdout' : 'placed', ci,
      feats: (S.feats.get(m.imgIdx) || {}).n || 0,
    });
  });
  const pts = recon.points;
  const xyz = new Float32Array(pts.length * 3);
  const rgb = new Uint8Array(pts.length * 3);
  pts.forEach((p, k) => {
    xyz.set(p.X, k * 3);
    rgb[k * 3] = p.rgb[0] * 255; rgb[k * 3 + 1] = p.rgb[1] * 255; rgb[k * 3 + 2] = p.rgb[2] * 255;
  });
  S.scene = { cams, xyz, rgb, center: ses.model.center, radius: ses.model.radius };
  vp.setScene(S.scene);
  vp.detectUp(cams);
  paintStrip();
}

// ── training ────────────────────────────────────────────────────────────────
function startTraining() {
  S.state = 'train';
  S.trainT0 = performance.now();
  const first = S.scene.cams.find((c) => c.R && c.state !== 'holdout') || S.scene.cams[0];
  if (first && first.R) {
    S.sel = first.i;
    vp.freeF = null;
    vp.syncTo(first);
    vp.dist = S.scene.radius * 1.35;
    paintStrip();
  }
  renderControls();
  dock('train');
  S.session.start();
}

function toggleTrain() {
  if (!S.session) return;
  if (S.session.training) S.session.pause();
  else S.session.start();
  const b = $('t-play');
  const on = S.session.training;
  if (b) { b.dataset.state = on ? 'pause' : 'play'; b.textContent = on ? '❚❚' : '▶'; }
  const f = $('t-finish');
  if (f) f.hidden = on;   // paused = the moment "stop here" makes sense
}

function onMetrics(m) {
  S.iter = m.iter;
  S.splats = m.splats;
  S.itersPerSec = m.itersPerSec;
  if (m.psnrTrain != null) S.psnrTrain = m.psnrTrain;
  if (m.psnrHold != null) S.psnrHold = m.psnrHold;
  if (m.psnrHold != null) (S.holdHist ??= []).push([m.iter, m.psnrHold]);
  if (chart && m.psnrTrain != null) {
    chart.push(m.iter, m.psnrTrain, m.psnrHold ?? null);
    chart.maxIter = S.maxIters;
    chart.events = S.chartEvents.map((e) => ({ ...e, at: e.iter / S.maxIters }));
    chart.draw();
  }
  if (S.state === 'train') {
    const el = $('t-iter');
    if (el) {
      el.textContent = fmt(S.iter);
      $('t-splats').textContent = fmt(S.splats);
      $('t-ips').textContent = fmt(S.itersPerSec);
      $('t-ptrain').textContent = S.psnrTrain != null ? S.psnrTrain.toFixed(2) : '—';
      $('t-phold').textContent = S.psnrHold != null ? S.psnrHold.toFixed(2) : '—';
    }
  }
}

function onTrainEvent(e) {
  if (e.kind === 'refine' && e.grown > 0) {
    S.chartEvents.push({ iter: e.iter, kind: 'grow', label: `Capacity +${fmt(e.grown)}` });
    flash(`Capacity grows → ${fmt(e.n)} splats`, 2200);
  }
  if (e.kind === 'refine' && e.grown === 0 && !S.growthStopped && e.iter > S.maxIters * 0.7) {
    S.growthStopped = true;
    S.chartEvents.push({ iter: e.iter, kind: 'stop', label: 'Growth stops' });
  }
  if (e.kind === 'train-complete') finish();
}

async function finish() {
  S.state = 'done';
  S.iter = S.session.trainer.iter;   // honest count — the run may end early
  S.minutes = Math.max(1, Math.round((performance.now() - S.trainT0) / 60000));
  S.atFrame = -1; S.fadeTo = 0;
  vp.lock = null; vp.freeF = null;
  $('stage').dataset.cursor = 'grab';
  // land roughly where the first photograph was taken — the photographer's
  // view of the result, not an abstract overview
  const first = S.scene.cams.find((c) => c.R && c.state !== 'holdout') || S.scene.cams[0];
  if (first && first.R) {
    vp.syncTo(first);
    vp.dist = S.scene.radius * 1.1;   // stepped back just enough for context
  } else {
    vp.frameScene();
  }
  renderControls();
  dock('');
  const hold = S.psnrHold != null ? ` · ${S.psnrHold.toFixed(1)} dB on the photograph it never saw` : '';
  flash(`Done${hold}`, 6000);
  scoreFrames();
}

/** after the run: an honest per-photograph score, filled in the background */
async function scoreFrames() {
  const gen = S.gen;
  for (const c of S.scene.cams) {
    if (c.ci < 0 || S.gen !== gen || S.state !== 'done') return;
    try {
      c.psnr = await S.session.evalFramePsnr(c.ci);
      paintStrip();
    } catch { return; }
  }
}

// ── stage controls (train/done) ─────────────────────────────────────────────
function seg(items, active, onPick) {
  const d = document.createElement('div');
  d.className = 'seg';
  items.forEach(([val, label]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('aria-pressed', String(val === active));
    b.addEventListener('click', () => onPick(val));
    d.appendChild(b);
  });
  return d;
}

const cursorFor = (m) => (m === 'loupe' ? 'loupe' : m === 'swipe' ? 'swipe' : 'grab');

function renderControls() {
  const c = $('controls');
  c.innerHTML = '';
  const live = S.state === 'train' || S.state === 'done';
  c.hidden = !live;
  if (!live) return;

  if (S.atFrame >= 0) {
    c.appendChild(seg([['swipe', 'Swipe'], ['loupe', 'Loupe'], ['error', 'Error']],
      S.compare, (v) => {
        S.compare = v;
        $('stage').dataset.cursor = cursorFor(v);
        renderControls();
      }));
  }

  if (S.state !== 'done') return;

  const stats = document.createElement('button');
  stats.className = 'statchip';
  stats.innerHTML = `<span><b>${fmt(S.splats)}</b> splats</span>` +
    (S.psnrHold != null ? `<span><b>${S.psnrHold.toFixed(1)}</b> dB</span>` : '') +
    `<span><b>${S.minutes}</b> min</span><i>Details ›</i>`;
  stats.addEventListener('click', openDetails);
  c.appendChild(stats);
  const more = document.createElement('button');
  more.className = 'btn btn-quiet';
  more.textContent = `Train +${fmt(MORE_ITERS / 1000)}k`;
  more.title = 'Continue training — the schedules stretch to the longer run';
  more.addEventListener('click', continueTraining);
  c.appendChild(more);
  c.appendChild(buildExport());
}

/** Resume from done: raise the horizon, restore the curve, back to train. */
function continueTraining() {
  if (!S.session || S.state !== 'done') return;
  S.maxIters = S.session.continueFor(MORE_ITERS);
  S.state = 'train';
  S.trainT0 = performance.now() - S.minutes * 60000;   // minutes stay cumulative
  S.growthStopped = false;
  S.atFrame = -1; S.fadeTo = 0;
  vp.lock = null;
  $('stage').dataset.cursor = 'grab';
  renderControls();
  dock('train');
  if (chart) {
    chart.train = S.session.lossHistory.map(([i, v]) => [i, v]);
    chart.hold = (S.holdHist || []).slice();
    chart.maxIter = S.maxIters;
    chart.draw();
  }
  paintStrip();
}

const DL_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" class="dl">' +
  '<path d="M22 15.3333V19.7777C22 20.3671 21.7659 20.9323 21.3491 21.349C20.9324 21.7658 20.3671 21.9999 19.7778 21.9999H4.22222C3.63285 21.9999 3.06762 21.7658 2.65087 21.349C2.23413 20.9323 2 20.3671 2 19.7777V15.3333"/>' +
  '<path d="M6.44449 9.77745L12 15.333M12 15.333L17.5556 9.77745M12 15.333L12 1.99967"/></svg>';

function buildExport() {
  const mb = (S.splats * 164 / 1e6).toFixed(1); // 41 float properties per splat (SH deg 2)
  const wrap = document.createElement('div');
  wrap.className = 'exportwrap';
  wrap.innerHTML = `
    <button class="iconbtn" title="Export" aria-label="Export">${DL_ICON}</button>
    <div class="menu" hidden>
      <button data-act="arr"><b>Upload to Arrival.Space</b><span>Straight into a space of yours</span></button>
      <button data-act="ply"><b>Download .ply</b><span>Standard splat file · ${mb} MB</span></button>
    </div>`;

  const menu = wrap.querySelector('.menu');
  wrap.querySelector('.iconbtn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.menu').forEach((m) => { if (m !== menu) m.hidden = true; });
    menu.hidden = !menu.hidden;
  });
  wrap.querySelector('[data-act="ply"]').addEventListener('click', async () => {
    menu.hidden = true;
    const blob = await S.session.exportPlyBlob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(S.preset.name || 'splat').toLowerCase().replace(/\W+/g, '_')}.ply`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    flash(`${fmt(S.splats)} splats on their way to your downloads.`, 3500);
  });
  wrap.querySelector('[data-act="arr"]').addEventListener('click', () => {
    menu.hidden = true;
    if (!S.uploading) uploadDialog();
  });
  return wrap;
}

/** Ask for the space's title (a default is prefilled), then upload. The
 *  sign-in window MUST be opened synchronously inside the Upload click —
 *  after any await it would be popup-blocked. The finished space is
 *  presented as a link, never auto-opened. */
function uploadDialog() {
  document.getElementById('upcard')?.remove();
  const card = document.createElement('div');
  card.className = 'upcard';
  card.id = 'upcard';
  card.innerHTML = `
    <b>Upload to Arrival.Space</b>
    <input id="up-title" type="text" spellcheck="false" maxlength="80">
    <div class="upcard-row">
      <button class="btn btn-quiet" id="up-cancel">Cancel</button>
      <button class="btn btn-accent" id="up-go">Upload</button>
    </div>`;
  $('stage').appendChild(card);
  const input = card.querySelector('#up-title');
  input.value = S.preset.id === '__own' ? 'My splat' : S.preset.name;
  input.focus();
  input.select();
  const close = () => card.remove();
  card.querySelector('#up-cancel').addEventListener('click', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') card.querySelector('#up-go').click();
    if (e.key === 'Escape') close();
  });
  card.querySelector('#up-go').addEventListener('click', async () => {
    const title = input.value.trim() || 'My splat';
    // synchronously, inside the click: the sign-in window (about:blank now,
    // the login page once the auth URL is built)
    const popup = hasToken() ? null : window.open('', 'arrival-oauth', 'width=480,height=720');
    close();
    if (!hasToken() && !popup) {
      flash('The sign-in window was blocked — allow popups for this site and try again.', 8000);
      return;
    }
    S.uploading = true;
    try {
      const blob = await S.session.exportPlyBlob();
      const url = await sendToArrival(blob, title, {
        popup,
        onStatus: (m) => flash(m, 120000),
        onProgress: (pct) => flash(`Uploading … ${pct}%`, 120000),
      });
      flash(`<b>${title}</b> is live · <a href="${url}" target="_blank" rel="noopener">Open your space ↗</a>`, 300000);
    } catch (e) {
      console.error(e);
      if (popup && !popup.closed) popup.close();
      flash(`Upload failed: ${e.message}`, 9000);
    } finally {
      S.uploading = false;
    }
  });
}

/** put the camera exactly on a frame's pose and lay its photograph over the model */
function goToFrame(i) {
  const cam = S.scene.cams[i];
  if (!cam || !cam.R) { flash('That frame was never placed — there is no viewpoint to jump to.'); return; }
  S.sel = i; S.atFrame = i;
  vp.lock = cam;
  bmp(cam.url).then((b) => {
    if (b && S.scene.cams[S.atFrame]?.url === cam.url) dev.setBitmap(b, cam.url);
  });
  S.fadeTo = 1;
  S.loupe.x = $('stage').clientWidth / 2;
  S.loupe.y = $('stage').clientHeight / 2;
  $('stage').dataset.cursor = cursorFor(S.compare);
  renderControls(); paintStrip();
}

/** a drag pulls the camera off the frame — same position, same lens, now free */
function leaveFrame() {
  if (S.atFrame < 0) return;
  const cam = S.scene.cams[S.atFrame];
  vp.freeF = cam.f * Math.min(vp.w / cam.w, vp.h / cam.h);
  vp.lock = null;
  vp.syncTo(cam);
  S.atFrame = -1;
  S.fadeTo = 0;
  $('stage').dataset.cursor = 'grab';
  renderControls();
}

function select(i) {
  if (!S.photos.length) return;
  S.sel = (i + S.photos.length) % S.photos.length;
  $('strip-scroll')?.children[S.sel]?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  if ((S.state === 'train' || S.state === 'done') && S.scene) goToFrame(S.sel);
  paintStrip(); renderControls();
  if (!$('details').hidden) renderDetails();
}

function wireStage() {
  const st = $('stage');
  st.addEventListener('pointermove', (e) => {
    if (S.atFrame < 0) return;
    const r = st.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (S.compare === 'loupe') { S.loupe.x = x; S.loupe.y = y; }
    if (S.compare === 'swipe' && S.rect) S.swipe = clamp((x - S.rect.x) / S.rect.w, 0, 1);
  });
  st.addEventListener('wheel', (e) => {
    if (S.atFrame < 0 || S.compare !== 'loupe') return;
    e.preventDefault();
    S.loupe.r = clamp(S.loupe.r - e.deltaY * .12, 40, 260);
  }, { passive: false });
}

// ── filmstrip ───────────────────────────────────────────────────────────────
function buildStrip() {
  const strip = $('strip');
  strip.innerHTML = '<div class="strip-scroll" id="strip-scroll"></div>';
  const sc = $('strip-scroll');
  const io = new IntersectionObserver((es) => {
    es.forEach(async (e) => {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      const b = await bmp(S.photos[+e.target.dataset.i].url, 140);
      if (!b) return;
      const cv = document.createElement('canvas');
      cv.width = b.width; cv.height = b.height;
      cv.getContext('2d').drawImage(b, 0, 0);
      e.target.querySelector('.ph')?.replaceWith(
        Object.assign(new Image(), { src: cv.toDataURL('image/jpeg', .7) }));
    });
  }, { root: sc, rootMargin: '250px' });

  S.photos.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'frame';
    b.dataset.i = i;
    b.innerHTML = `<div class="ph"></div>
      <span class="frame-tag" hidden></span><div class="frame-bar"><i></i></div>`;
    b.addEventListener('click', () => select(i));
    sc.appendChild(b);
    io.observe(b);
  });
  paintStrip();
}

function paintStrip() {
  const sc = $('strip-scroll');
  if (!sc) return;
  const active = (S.state === 'train' && S.session && S.session.training && S.scene)
    ? (S.scene.cams.find((c) => c.ci === S.session.activeCam) || {}).i : -1;
  S.photos.forEach((p, i) => {
    const b = sc.children[i];
    if (!b) return;
    const c = S.scene ? S.scene.cams[i] : null;
    b.dataset.sel = i === S.sel ? '1' : '0';
    b.dataset.live = i === active ? '1' : '0';
    b.dataset.state = c ? c.state : 'placed';
    const tag = b.querySelector('.frame-tag');
    const t = c && c.state === 'holdout' ? 'held' : c && c.state === 'unplaced' ? 'out' : null;
    tag.hidden = !t;
    if (t) { tag.dataset.t = c.state; tag.textContent = t; }
    const bar = b.querySelector('.frame-bar i');
    const score = c && (c.psnr != null ? c.psnr
      : (S.state !== 'ready' && c.state !== 'unplaced'
        ? (c.state === 'holdout' ? S.psnrHold : S.psnrTrain) : null));
    bar.style.width = score != null ? `${clamp((score - 12) / 22, 0, 1) * 100}%` : '0%';
    bar.style.background = c && c.state === 'holdout' ? '#f2a03f' : '#2fd4c1';
  });
}

// ── dock ────────────────────────────────────────────────────────────────────
function dock(kind) {
  const d = $('dock');
  d.className = 'dock' + (kind ? ` dock-${kind}` : '');
  if (!kind) { d.innerHTML = ''; return; }

  if (kind === 'prep') {
    d.innerHTML = `
      <div>
        <div class="prep-label" id="p-label">Reading photographs</div>
        <div class="prep-sub" id="p-sub">—</div>
        <div class="prep-meter"><i id="p-bar" style="width:0%"></i></div>
      </div>
      <div class="prep-steps" id="p-steps">${BEATS.map((s, i) =>
        `<span data-k="${i}"><b>${s.label}</b></span>`).join('')}</div>`;
    return;
  }

  if (kind === 'train') {
    d.innerHTML = `
      <div class="tcontrols">
        <button class="play" id="t-play" data-state="pause">❚❚</button>
        <button class="tbtn-sm" id="t-finish" hidden title="Stop here and keep the model as it is">Finish</button>
        <div class="tmeta">
          <span class="tmeta-1"><span id="t-iter">0</span> <span class="tmeta-max">/ <span id="t-max">${fmt(S.maxIters)}</span></span></span>
          <span class="tmeta-2"><span id="t-splats">—</span> splats · <span id="t-ips">—</span>/s</span>
        </div>
      </div>
      <div class="chartwrap"><canvas id="chart"></canvas><div class="chart-tip" id="chart-tip" hidden></div></div>
      <div class="tscores">
        <div class="score" data-tone="accent"><div class="score-v" id="t-ptrain">—</div><div class="score-k">trained dB</div></div>
        <div class="score" data-tone="alt"><div class="score-v" id="t-phold">—</div><div class="score-k">hidden dB</div></div>
      </div>`;
    $('t-play').addEventListener('click', toggleTrain);
    $('t-finish').addEventListener('click', async () => {
      $('t-finish').disabled = true;
      await S.session.finish();   // emits train-complete -> finish()
    });
    chart = new Chart($('chart'), { onHover: chartTip });
    chart.maxIter = S.maxIters;
    chart.resize();
  }
}

function chartTip(h) {
  const tip = $('chart-tip');
  if (!tip) return;
  if (!h) { tip.hidden = true; return; }
  tip.hidden = false;
  tip.style.left = `${h.xPct}%`;
  tip.style.top = '4px';
  tip.innerHTML = `${fmt(h.iter)} · <b style="color:#2fd4c1">${h.train.toFixed(1)}</b>` +
    (h.hold != null ? ` / <b style="color:#f2a03f">${h.hold.toFixed(1)}</b> dB` : '') +
    (h.event ? `<br><span style="color:#93a1a0">${h.event}</span>` : '');
}

// ── flash ───────────────────────────────────────────────────────────────────
function flash(msg, ms = 2800) {
  S.flash = { msg, until: performance.now() + ms };
}

function renderHud() {
  const chips = [];
  if (S.flash) chips.push(`<span class="chip" data-tone="accent">${S.flash.msg}</span>`);
  const hud = $('hud');
  const next = `<div class="chip-row">${chips.join('')}</div>`;
  if (hud.dataset.k !== next) { hud.innerHTML = next; hud.dataset.k = next; }
}

// ── main loop ───────────────────────────────────────────────────────────────
let lastPulse = 0;
let lastLoopT = performance.now();

/** WASD fly: move the orbit target along the camera's own axes */
function flyStep(dt) {
  if (!S.keys.size || !S.scene) return;
  if (S.state !== 'train' && S.state !== 'done') return;
  if (S.picking || !$('details').hidden) return;
  if (S.atFrame >= 0) leaveFrame();   // like a drag, movement leaves the photo
  const { fwd, right, down } = vp._basis();
  const boost = (S.keys.has('ShiftLeft') || S.keys.has('ShiftRight')) ? 3 : 1;
  const sp = S.scene.radius * 0.7 * dt * boost;
  let any = false;
  const move = (v, f) => { for (let i = 0; i < 3; i++) vp.target[i] += v[i] * f; any = true; };
  if (S.keys.has('KeyW')) move(fwd, sp);
  if (S.keys.has('KeyS')) move(fwd, -sp);
  if (S.keys.has('KeyA')) move(right, -sp);
  if (S.keys.has('KeyD')) move(right, sp);
  if (S.keys.has('KeyE')) move(down, -sp);   // up
  if (S.keys.has('KeyQ')) move(down, sp);    // down
  if (any) vp.dirty = true;
}

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastLoopT) / 1000);
  lastLoopT = now;
  if (S.flash && now > S.flash.until) S.flash = null;
  // no fade on the photo overlay — it reads as lag on slow devices
  S.fade = S.fadeTo;
  flyStep(dt);

  if (S.state === 'prep') paintPrepDock();

  if (S.state === 'train' && now - lastPulse > 300) {
    lastPulse = now;
    paintStrip();          // the pulse on the frame being trained on
  }

  renderHud();
  draw();
  if (!$('details').hidden) drawDetail();
}

function paintPrepDock() {
  const bar = $('p-bar');
  if (!bar || !S.prep) return;
  const bi = beatIndex(S.prep.stage);
  const frac = S.prep.total ? S.prep.done / S.prep.total : 0;
  bar.style.width = `${((bi + Math.min(1, frac)) / BEATS.length) * 100}%`;
  $('p-label').textContent = BEATS[bi].label;
  $('p-sub').textContent = prepSub();
  [...$('p-steps').children].forEach((el, k) =>
    el.dataset.on = k < bi ? 'done' : k === bi ? '1' : '0');
}

function prepSub() {
  const e = S.prep;
  if (!e) return '—';
  const n = S.photos.length;
  if (e.stage === 'decode') return `photo ${e.done} of ${e.total}`;
  if (e.stage === 'features') {
    const total = [...S.feats.values()].reduce((a, f) => a + f.n, 0);
    return `${fmt(total)} spots · frame ${e.done} of ${e.total}`;
  }
  if (e.stage === 'matching') {
    return `${fmt(e.done)} of ${fmt(e.total)} pairs · ${fmt(e.detail?.usable ?? 0)} survived the geometry test`;
  }
  if (e.stage === 'focal') return `no lens data in the files — trying focal ${e.done + 1} of ${e.total}`;
  if (e.stage === 'register') return `${e.done} of ${e.total} cameras placed`;
  if (e.stage === 'ba') return 'polishing the geometry (bundle adjustment)';
  if (e.stage === 'solved') return `${e.detail.cams} cameras · ${fmt(e.detail.points)} points · ${e.detail.rms ? e.detail.rms.toFixed(2) + 'px' : ''}`;
  if (e.stage === 'seed') return 'one splat per landmark, plus jittered copies';
  return '—';
}

// ── drawing ─────────────────────────────────────────────────────────────────
function draw() {
  const cv = $('cv');
  const r = cv.getBoundingClientRect();
  if (Math.abs(r.width * (vp.dpr || 1) - cv.width) > 2 || Math.abs(r.height * (vp.dpr || 1) - cv.height) > 2) vp.resize();
  const ctx = vp.ctx, w = vp.w, h = vp.h, dpr = vp.dpr || 1;

  if (S.state === 'ready') { photoStage(ctx, w, h, dpr); return; }

  if (S.state === 'prep') {
    const st = S.prep && S.prep.stage;
    if (st === 'decode' || st === 'features') return photoStage(ctx, w, h, dpr, st === 'features');
    if (st === 'matching') return pairStage(ctx, w, h, dpr);
    // focal / register / ba / solved / seed: the camera solve, live
    if (S.scene) {
      vp.draw({ points: true, cams: S.scene.cams, showCams: true, showPath: true, sel: S.sel, active: -1 });
    } else {
      vp.draw({ cams: S.regCams, showCams: true, showPath: true, reveal: S.regCams.length, active: -1, sel: -1 });
    }
    return;
  }

  // train/done: the model, rendered by the trainer at this exact pose
  // (render capped at the session's view-buffer size, blit scales up)
  const onFrame = S.atFrame >= 0;
  const pose = vp.viewPose();
  if (gpuCanvas && S.session && S.session.trainer) {
    const now = performance.now();
    if (vp.dirty) S._camMovedAt = now;
    const training = S.state === 'train' && S.session.training;
    const moving = vp.dirty || now - (S._camMovedAt || 0) < 250;
    // progressive resolution: ~1.3MP while the camera moves or training runs
    // (fluid), the FULL device-pixel canvas once it settles (true retina) —
    // always inside the allocated view buffers / tile-grid budget
    const budgetPx = Math.min(S.viewPixBudget || 2560 * 1440,
      (training || moving) ? 1.3e6 : 1e9);
    const sc = Math.min(1, Math.sqrt(budgetPx / (w * h)));
    const gw = Math.max(2, Math.round(w * sc)), gh = Math.max(2, Math.round(h * sc));
    const key = `${gw}x${gh}|${Math.round(pose.f)}|` +
      pose.R.map((v) => Math.round(v * 8192)).join(',') + '|' +
      pose.t.map((v) => Math.round(v * 8192)).join(',');
    // re-render when the view actually changed; while training also every
    // 400ms so the evolving model stays visible without stealing every frame
    if (key !== S._viewKey || (training && now - (S._lastViewAt || 0) > 400)) {
      S._viewKey = key;
      S._lastViewAt = now;
      if (gpuCanvas.width !== gw || gpuCanvas.height !== gh) {
        gpuCanvas.width = gw; gpuCanvas.height = gh;
        S.session.view.attach(gpuCanvas);
      }
      S.session.view.setCamera({
        R: pose.R, t: pose.t,
        f: pose.f * sc, cx: pose.cx * sc, cy: pose.cy * sc, w: gw, h: gh,
      });
      S.session.view.renderNow();
    }
  }

  vp.draw({
    modelCanvas: gpuCanvas,
    cams: S.scene.cams,
    showCams: true,
    showPath: S.state === 'train' && !onFrame,
    faint: onFrame || S.state === 'done',
    skip: S.atFrame,
    active: S.state === 'train' && S.session.training
      ? (S.scene.cams.find((c) => c.ci === S.session.activeCam) || {}).i : -1,
    sel: S.sel,
    dimOthers: S.state === 'train' && S.session.training,
  });

  if (S.fade > .005 && dev.ready) {
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.globalAlpha = S.fade;
    S.rect = dev.render(ctx, w / dpr, h / dpr, {
      mode: S.compare, loupe: S.loupe, swipe: S.swipe, dpr,
      key: `${S.atFrame}:${S.iter}`,
    });
    ctx.restore();
  }
}

/** a photograph filling the stage (ready + the first prep beats) */
function photoStage(ctx, w, h, dpr, marks = false) {
  ctx.fillStyle = '#070909';
  ctx.fillRect(0, 0, w, h);
  const img = readyBmp(S.photos[S.sel] && S.photos[S.sel].url);
  if (!img) return;
  const r = fitRect(img.width, img.height, w / dpr, h / dpr, 10);
  ctx.save(); ctx.scale(dpr, dpr);
  ctx.globalAlpha = S.state === 'ready' ? .42 : 1;
  ctx.drawImage(img, r.x, r.y, r.w, r.h);
  ctx.globalAlpha = 1;
  if (marks) drawRealMarks(ctx, r, S.sel);
  ctx.restore();
}

/** the solver's actual keypoints, appearing as they are found */
function drawRealMarks(ctx, r, imgIdx) {
  const f = S.feats.get(imgIdx);
  const fr = S.session && S.session.frames[imgIdx];
  if (!f || !fr) return;
  const sx = r.w / fr.fw, sy = r.h / fr.fh;
  ctx.fillStyle = 'rgba(47,212,193,.8)';
  const n = Math.min(f.n, 1200);
  for (let k = 0; k < n; k++) {
    ctx.fillRect(r.x + f.x[k] * sx - 1, r.y + f.y[k] * sy - 1, 2, 2);
  }
  ctx.fillStyle = '#93a1a0';
  ctx.font = '500 10px "Spline Sans Mono", monospace';
  ctx.fillText(`${fmt(f.n)} LANDMARKS`, r.x + 4, r.y + r.h + 14);
}

/** two photographs, and the matches that survived between them */
function pairStage(ctx, w, h, dpr) {
  ctx.fillStyle = '#070909';
  ctx.fillRect(0, 0, w, h);
  const ev = S.lastPairEv;
  if (!ev) return;
  const a = readyBmp(S.photos[ev.i].url);
  const b = readyBmp(S.photos[ev.j].url);
  if (!a || !b) return;
  const half = w / dpr / 2;
  ctx.save(); ctx.scale(dpr, dpr);
  const r1 = fitRect(a.width, a.height, half, h / dpr, 14);
  const r2 = fitRect(b.width, b.height, half, h / dpr, 14);
  r2.x += half;
  ctx.globalAlpha = .7;
  ctx.drawImage(a, r1.x, r1.y, r1.w, r1.h);
  ctx.drawImage(b, r2.x, r2.y, r2.w, r2.h);
  ctx.globalAlpha = 1;

  const fa = S.feats.get(ev.i), fb = S.feats.get(ev.j);
  const f1 = S.session.frames[ev.i], f2 = S.session.frames[ev.j];
  if (fa && fb && f1 && f2) {
    ctx.strokeStyle = 'rgba(47,212,193,.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k + 1 < ev.sample.length * 2 && k < 100; k += 2) {
      const [ia, ib] = ev.sample[k / 2];
      const x1 = r1.x + fa.x[ia] * (r1.w / f1.fw), y1 = r1.y + fa.y[ia] * (r1.h / f1.fh);
      const x2 = r2.x + fb.x[ib] * (r2.w / f2.fw), y2 = r2.y + fb.y[ib] * (r2.h / f2.fh);
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    }
    ctx.stroke();
  }
  ctx.fillStyle = '#93a1a0';
  ctx.font = '500 10px "Spline Sans Mono", monospace';
  ctx.fillText(`FRAME ${ev.i + 1}`, r1.x + 4, r1.y - 6);
  ctx.fillText(`FRAME ${ev.j + 1}`, r2.x + 4, r2.y - 6);
  ctx.restore();
}

// ── details sheet ───────────────────────────────────────────────────────────
const DTABS = [['marks', 'Landmarks'], ['matches', 'Matching'], ['cams', 'Cameras']];

function openDetails() {
  $('details').hidden = false;
  $('d-export').replaceChildren(buildExport());
  renderDetails();
  if (!dchart) dchart = new Chart($('d-chart'), {});
  dchart.maxIter = S.maxIters;
  dchart.train = S.session.lossHistory.map(([i, v]) => [i, v]);
  dchart.hold = chart ? chart.hold : [];
  dchart.events = S.chartEvents.map((e) => ({ ...e, at: e.iter / S.maxIters }));
  dchart.resize();
}

function renderDetails() {
  const ses = S.session, recon = ses.recon;
  const n = S.photos.length;
  const placed = recon.cams.length;
  $('d-sub').textContent =
    `${S.preset.name} · ${n} photographs · ${placed} placed · ${fmt(recon.points.length)} points · ${fmt(S.splats)} splats`;

  const segHost = $('d-seg');
  segHost.innerHTML = '';
  DTABS.forEach(([id, label]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('aria-pressed', String(S.detailTab === id));
    b.addEventListener('click', () => { S.detailTab = id; renderDetails(); });
    segHost.appendChild(b);
  });

  const stat = (k, v, tone) =>
    `<div class="stat"><span class="stat-k">${k}</span>
     <span class="stat-v"${tone ? ` data-tone="${tone}"` : ''}>${v}</span></div>`;

  const featsTotal = [...S.feats.values()].reduce((a, f) => a + f.n, 0);
  const selFeats = (S.feats.get(S.sel) || {}).n;
  const survived = S.solveStats.pairsChecked
    ? Math.round(100 * S.solveStats.pairsUsable / S.solveStats.pairsChecked) : 0;

  const T = {
    marks: {
      cap: `Frame ${S.sel + 1}. Pick another below — flat sky and plain walls stay empty.`,
      title: 'Spots worth remembering',
      body: [
        'Before there is any 3D, every photo is scanned for places that could be recognised ' +
        'again from another angle: corners, texture, edges. Each one gets a short numeric ' +
        'fingerprint of its surroundings.',
        'Smooth surfaces produce nothing, which is exactly why blank walls, water and sky are ' +
        'hard for this kind of reconstruction.',
      ],
      rows: [
        stat('Marks on this frame', selFeats != null ? fmt(selFeats) : '—'),
        stat('Average per photo', fmt(featsTotal / Math.max(1, S.feats.size))),
        stat('Across the set', fmt(featsTotal)),
      ],
    },
    matches: {
      cap: 'The pairings that survived the geometry test, drawn between two frames.',
      title: 'The same spot, twice',
      body: [
        'Fingerprints are compared photo against photo. Plenty of pairings are wrong, so every ' +
        'candidate set is tested against geometry: only pairings that could be explained by one ' +
        'rigid scene seen from two positions survive.',
        'What survives is a chain — a spot tracked through many photos at once — and that chain ' +
        'is what makes a position solvable.',
      ],
      rows: [
        stat('Pairs compared', fmt(S.solveStats.pairsChecked)),
        stat('Survived the test', `${fmt(S.solveStats.pairsUsable)} · ${survived}%`, 'accent'),
      ],
    },
    cams: {
      cap: 'The sparse cloud and the position of every photograph. Drag to orbit.',
      title: 'Where the camera was',
      body: [
        'A spot seen from two known directions fixes a point in space; a photo with enough known ' +
        'points fixes a camera. Solved together they give both — the positions, and a sparse ' +
        'cloud of a few thousand points.',
        'That cloud is far too coarse to look at. Its job is to say roughly where surfaces are, ' +
        'so the splats do not start from nothing.',
      ],
      rows: [
        stat('Placed', `${placed} <small>/ ${n}</small>`, placed === n ? 'accent' : 'red'),
        stat('Points', fmt(recon.points.length)),
        stat('Reprojection error', recon.rmsBA ? `${recon.rmsBA.toFixed(2)} <small>px</small>` : '—',
          recon.rmsBA && recon.rmsBA < 1 ? 'accent' : undefined),
        stat('Focal length', `${Math.round(recon.cams[0].f)} <small>px, solved — no lens data was read</small>`),
        stat('Solve time', `${Math.round(S.solveStats.solveSec)} <small>s</small>`),
      ],
    },
  }[S.detailTab];

  $('d-cap').textContent = T.cap;
  $('d-txt').innerHTML =
    `<h3>${T.title}</h3>${T.body.map((p) => `<p>${p}</p>`).join('')}<div class="grp">${T.rows.join('')}</div>`;

  const gap = (S.psnrTrain != null && S.psnrHold != null) ? S.psnrTrain - S.psnrHold : null;
  $('d-txt2').innerHTML = `
    <h3>Guess, compare, nudge</h3>
    <p>Every point from the solve became a <b>splat</b>: a soft 3D blob with a position, a
       size along three axes, an orientation, a colour and a transparency. That is the whole
       model — no mesh, no texture, no surface.</p>
    <p>Each cycle renders the splats from one photo's viewpoint, compares the result with that
       photograph, and nudges every splat a little to shrink the difference.</p>
    <p>${HOLD_HELP}</p>
    <div class="grp">
      ${stat('Cycles', fmt(S.iter))}
      ${S.psnrTrain != null ? stat('On trained photos', `${S.psnrTrain.toFixed(1)} <small>dB</small>`, 'accent') : ''}
      ${S.psnrHold != null ? stat('On the hidden photo', `${S.psnrHold.toFixed(1)} <small>dB</small>`, 'alt') : ''}
      ${gap != null ? stat('Gap', `${gap.toFixed(1)} <small>dB</small>`, Math.abs(gap) < 1.5 ? 'accent' : undefined) : ''}
      ${stat('Splats', fmt(S.splats))}
      ${stat('Exported file', `${(S.splats * 164 / 1e6).toFixed(1)} <small>MB</small>`)}
      ${stat('Time in this tab', `${S.minutes} <small>min</small>`)}
    </div>
    <button class="btn btn-quiet" id="d-hold" style="margin-top:14px">Look at the frame it never saw</button>`;

  $('d-hold')?.addEventListener('click', () => {
    const h = S.scene.cams.find((c) => c.state === 'holdout');
    $('details').hidden = true;
    S.compare = 'swipe';
    select(h ? h.i : S.sel);
  });

  if (S.detailTab === 'cams' && !dvp) {
    dvp = new Viewport($('d-cv'));
    dvp.setScene(S.scene);
    dvp.upSign = vp.upSign;
  }
  if (dvp) dvp.resize();
}

function drawDetail() {
  const cv = $('d-cv');
  if (!cv.clientWidth) return;
  if (S.detailTab === 'cams') {
    if (!dvp) return;
    const r = cv.getBoundingClientRect();
    if (Math.abs(r.width * (dvp.dpr || 1) - cv.width) > 2) dvp.resize();
    dvp.draw({ points: true, cams: S.scene.cams, showCams: true, showPath: true, sel: S.sel, active: -1 });
    return;
  }
  const dpr = Math.min(2, devicePixelRatio || 1);
  if (cv.width !== Math.round(cv.clientWidth * dpr)) {
    cv.width = Math.round(cv.clientWidth * dpr);
    cv.height = Math.round(cv.clientHeight * dpr);
  }
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  if (S.detailTab === 'marks') {
    ctx.fillStyle = '#070909'; ctx.fillRect(0, 0, w, h);
    const img = readyBmp(S.photos[S.sel].url);
    if (!img) return;
    const r = fitRect(img.width, img.height, w / dpr, h / dpr, 6);
    ctx.save(); ctx.scale(dpr, dpr);
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
    drawRealMarks(ctx, r, S.sel);
    ctx.restore();
  } else {
    pairStage(ctx, w, h, dpr);
  }
}
