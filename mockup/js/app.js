// app.js — the mockup shell: one stage, one strip of frames, one inspector,
// six beats from photographs to a finished splat.

import { PRESETS, PHASES, COPY, HELP, EVENTS, GHOSTS, GUIDE, REPO } from './data.js';
import { loadScene, DATA } from './scene.js';
import { Viewport } from './viewport.js';
import { Developer, fitRect } from './develop.js';
import { Chart } from './chart.js';
import { drawMarks, drawMatches } from './marks.js';

const $ = (id) => document.getElementById(id);
const html = (s) => s;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (n) => n.toLocaleString('en-US');
const lerp = (a, b, t) => a + (b - a) * t;

// ── shared bitmap cache ─────────────────────────────────────────────────────
const bmps = new Map();     // key -> Promise
const ready = new Map();    // key -> decoded bitmap
const bkey = (url, w) => (w ? `${url}@${w}` : url);

function bmp(url, w) {
  const key = bkey(url, w);
  if (bmps.has(key)) return bmps.get(key);
  const p = fetch(url).then((r) => r.blob())
    .then((b) => createImageBitmap(b, w ? { resizeWidth: w, resizeQuality: 'medium' } : undefined))
    .then((b) => { ready.set(key, b); return b; })
    .catch(() => null);
  bmps.set(key, p);
  return p;
}

/** decoded bitmap if it is already here, otherwise null and a load is started */
function readyBmp(url, w) {
  const key = bkey(url, w);
  if (ready.has(key)) return ready.get(key);
  bmp(url, w);
  return null;
}

// ── state ───────────────────────────────────────────────────────────────────
const S = {
  phase: 'frames',
  preset: null,
  scene: null,
  sel: 0,
  active: 0,
  locked: false,
  compare: 'loupe',
  pairView: false,
  showCams: true,
  showPath: true,
  loupe: { x: 0, y: 0, r: 108 },
  swipe: 0.5,
  training: false,
  iter: 0,
  maxIter: 40000,
  speed: 1,
  splats: 0,
  ghost: 'none',
  replayAt: null,
  tab: 'scene',
  run: null,             // { kind, t0, dur } running stage animation
  flash: null,
  camOpt: true,
};

let vp, dev, chart;

// ── boot ────────────────────────────────────────────────────────────────────
buildStepper();
buildGallery();
buildGuide();
wireChrome();

function wireChrome() {
  $('gh').href = REPO;
  $('btn-detail').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(on));
    document.documentElement.toggleAttribute('data-detail', on);
    renderInspector(); renderRail();
  });
  $('btn-guide').addEventListener('click', () => $('guide').showModal());
  $('btn-guide-2').addEventListener('click', () => $('guide').showModal());
  $('guide-close').addEventListener('click', () => $('guide').close());
  $('btn-restart').addEventListener('click', () => {
    S.training = false;
    $('screen-lab').classList.remove('is-active');
    $('screen-start').classList.add('is-active');
    $('btn-restart').hidden = true;
    setPhase('frames', true);
  });

  const dz = $('dropzone');
  ['dragover', 'dragenter'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, () => dz.classList.remove('over')));
  dz.addEventListener('drop', (e) => { e.preventDefault(); ownPhotos(); });
  $('file-input').addEventListener('change', ownPhotos);

  addEventListener('keydown', (e) => {
    if ($('guide').open || !$('screen-lab').classList.contains('is-active')) return;
    if (e.key === ' ' && S.phase === 'train') { e.preventDefault(); toggleTrain(); }
    if (e.key === 'ArrowRight') selectCam(S.sel + 1);
    if (e.key === 'ArrowLeft') selectCam(S.sel - 1);
  });

  addEventListener('resize', () => { vp?.resize(); chart?.resize(); });
}

function ownPhotos() {
  flash('Your own photos are the point of the real thing — this mockup ships the ready sets only.', 5200);
}

// ── start screen ────────────────────────────────────────────────────────────
function buildGallery() {
  const g = $('gallery');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.className = 'card';
    b.setAttribute('aria-pressed', 'false');
    const first = p.files ? '' : p.pattern.replace(/\{i:(\d+)\}/, (_, w) => String(p.start).padStart(+w, '0'));
    b.innerHTML = html(`
      <div class="card-shot">
        <span class="badge" data-kind="${p.badge.kind}">${p.badge.text}</span>
        <img alt="" loading="lazy">
      </div>
      <div class="card-body">
        <div class="card-title"><h3>${p.name}</h3><span>${p.where}</span></div>
        <div class="card-meta">
          <span class="n">${p.count} frames</span><span class="t">${p.captureLine}</span>
        </div>
        <p class="card-blurb">${p.blurb}</p>
        <div class="card-go">Open this set →</div>
      </div>`);
    const img = b.querySelector('img');
    (async () => {
      const name = first || (await heroName(p));
      if (name) img.src = `${DATA}${p.dir}/${name}`;
    })();
    b.addEventListener('click', () => start(p));
    g.appendChild(b);
  }
}

async function heroName(p) {
  try {
    const t = await (await fetch(`${DATA}${p.dir}/${p.files}`)).text();
    return JSON.parse(t.replace(/^﻿/, ''))[0];
  } catch { return null; }
}

// ── stepper ─────────────────────────────────────────────────────────────────
function buildStepper() {
  const s = $('stepper');
  for (const ph of PHASES) {
    const b = document.createElement('button');
    b.className = 'step';
    b.dataset.id = ph.id;
    b.innerHTML = `<span class="step-n">${ph.n}</span><span class="step-l">${ph.label}</span>`;
    b.addEventListener('click', () => { if (S.scene) setPhase(ph.id); });
    s.appendChild(b);
  }
}

function paintStepper() {
  const order = PHASES.map((p) => p.id);
  const now = order.indexOf(S.phase);
  [...$('stepper').children].forEach((b, i) => {
    b.dataset.state = i === now ? 'now' : i < now ? 'done' : 'todo';
    b.disabled = !S.scene;
  });
}

// ── open a scene ────────────────────────────────────────────────────────────
async function start(preset) {
  S.preset = preset;
  S.maxIter = 40000;
  $('screen-start').classList.remove('is-active');
  $('screen-lab').classList.add('is-active');
  $('btn-restart').hidden = false;

  if (!vp) {
    vp = new Viewport($('stage-canvas'));
    vp.onLeave = () => { if (S.locked) unlock(); };   // drag pulls off the frame
    dev = new Developer();
  }
  vp.resize();

  S.scene = await loadScene(preset);
  S.sel = 0; S.active = 0; S.iter = 0; S.training = false; S.locked = false;
  S.camsRevealed = null; S.fired = new Set(); S.replayAt = null; S.seedMix = 0;
  vp.enabled = true; vp.lock = null;
  S.splats = Math.round(preset.stats.splats * 0.34);
  vp.setScene(S.scene);
  buildStrip();
  setPhase('frames', true);
  loop();
}

// ── phases ──────────────────────────────────────────────────────────────────
function setPhase(id, force) {
  if (S.phase === id && !force) return;
  S.phase = id;
  $('screen-lab').dataset.phase = id;
  S.run = null;

  if (id === 'train' || id === 'result') {
    if (id === 'result') {
      S.iter = S.maxIter; S.training = false; S.locked = false; S.showCams = false;
      vp.lock = null; vp.enabled = true;
      $('stage-view').dataset.cursor = 'grab';
      vp.frameScene();
      vp.dist = S.scene.radius * 2.2;    // the result gets a slightly closer look
    }
    ensureCurve();
  }
  if (id === 'cameras' && S.camsRevealed == null) S.camsRevealed = S.scene.cams.length;
  if (id === 'seed') S.splats = Math.round(S.preset.stats.splats * 0.34);
  if (id === 'frames' || id === 'features') S.locked = false;

  paintStepper(); renderRail(); renderStageBar(); renderInspector(); renderTransport(); paintStrip();
  vp.resize();
}

/** kick off the fake work that happens between two phases */
function run(kind, dur, onDone) {
  S.run = { kind, t0: performance.now(), dur, onDone };
  renderTransport();
}

function advance() {
  const p = S.phase;
  if (p === 'frames') {
    run('features', 1800, () => setPhase('features'));
  } else if (p === 'features') {
    setPhase('cameras');
    S.camsRevealed = 0;
    run('cameras', 3600, () => { S.camsRevealed = S.scene.cams.length; renderStageBar(); renderInspector(); });
  } else if (p === 'cameras') {
    setPhase('seed');
    run('seed', 1500, () => renderInspector());
  } else if (p === 'seed') {
    setPhase('train');
    S.training = true;
    lockTo(S.sel);
    renderTransport();
  } else if (p === 'train') {
    S.iter = S.maxIter; S.training = false;
    setPhase('result');
  } else if (p === 'result') {
    flash('A .ply of ' + fmt(S.preset.stats.splats) + ' splats would land in your downloads.', 4000);
  }
}

// ── rail ────────────────────────────────────────────────────────────────────
function renderRail() {
  const c = COPY[S.phase], ph = PHASES.find((p) => p.id === S.phase);
  const r = $('rail');
  r.innerHTML = html(`
    <div>
      <div class="rail-phase">${ph.n} · ${ph.label}</div>
      <h2>${c.title}</h2>
      <p class="rail-lead">${c.lead}</p>
    </div>
    ${c.more.length ? `<details class="more"><summary>What actually happens</summary>${c.more.map((m) => `<p>${m}</p>`).join('')}</details>` : ''}
    <div class="rail-fill"></div>
    <div id="rail-knobs"></div>
    <button class="btn ${S.phase === 'train' ? 'btn-quiet' : 'btn-accent'}" id="rail-go">${c.action}</button>
  `);
  $('rail-go').addEventListener('click', advance);
  if (S.phase === 'train') renderKnobs($('rail-knobs'));
}

function renderKnobs(host) {
  const g = GHOSTS[S.ghost];
  host.innerHTML = html(`
    <div class="knobs">
      <div class="knobs-head">Try changing it</div>
      <label class="knob">Camera positions keep moving
        <button class="toggle" id="k-cam" aria-pressed="${S.camOpt}"></button></label>
      <p class="knob-note">${S.camOpt
        ? 'On: the solve was rough, so the poses are being corrected as the splats learn.'
        : 'Off: the splats have to hide the pose error themselves, and it shows as blur.'}</p>
      <label class="knob">Show camera frames
        <button class="toggle" id="k-frust" aria-pressed="${S.showCams}"></button></label>
      <div class="knob">Compare with
        <select class="sel" id="k-ghost">
          <option value="none">this run only</option>
          ${Object.entries(GHOSTS).filter(([k]) => k !== 'none')
            .map(([k, v]) => `<option value="${k}" ${S.ghost === k ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select>
      </div>
      ${g ? `<p class="knob-note">${g.note}</p>` : ''}
    </div>`);
  $('k-cam').addEventListener('click', () => { S.camOpt = !S.camOpt; renderKnobs(host); });
  $('k-frust').addEventListener('click', () => { S.showCams = !S.showCams; renderKnobs(host); });
  $('k-ghost').addEventListener('change', (e) => { S.ghost = e.target.value; ensureCurve(); renderKnobs(host); });
}

// ── stage bar ───────────────────────────────────────────────────────────────
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

function renderStageBar() {
  const bar = $('stage-bar');
  bar.innerHTML = '';
  const title = document.createElement('span');
  title.className = 'stage-title';
  bar.appendChild(title);
  const cam = S.scene?.cams[S.sel];

  if (S.phase === 'frames') {
    title.textContent = `Frame ${S.sel + 1} of ${S.scene.cams.length}`;
    bar.appendChild(note('Pick any frame below'));
  } else if (S.phase === 'features') {
    title.textContent = 'Landmarks';
    bar.appendChild(seg([[false, 'One photo'], [true, 'Two photos']], S.pairView, (v) => { S.pairView = v; renderStageBar(); }));
    bar.appendChild(spacer());
    bar.appendChild(note(S.pairView
      ? 'Green survived the geometry test, red did not'
      : `${fmt(cam?.feats || 0)} marks on this frame`));
  } else if (S.phase === 'cameras' || S.phase === 'seed') {
    title.textContent = S.phase === 'seed' ? 'Seeded splats' : 'Sparse cloud';
    bar.appendChild(seg([[true, 'Show cameras'], [false, 'Cloud only']], S.showCams, (v) => { S.showCams = v; renderStageBar(); }));
    bar.appendChild(spacer());
    bar.appendChild(note(`${S.preset.stats.cams} of ${S.scene.cams.length} frames placed · ${fmt(S.preset.stats.points)} points`));
  } else {
    title.textContent = 'Model';
    bar.appendChild(seg([[false, 'Free view'], [true, `From frame ${S.sel + 1}`]], S.locked,
      (v) => (v ? lockTo(S.sel) : unlock())));
    if (S.locked) {
      bar.appendChild(seg([
        ['render', 'Render'], ['loupe', 'Loupe'], ['swipe', 'Swipe'], ['error', 'Error'], ['photo', 'Photo'],
      ], S.compare, (v) => {
        S.compare = v;
        $('stage-view').dataset.cursor = v === 'loupe' ? 'loupe' : 'default';
        renderStageBar();
      }));
    } else {
      bar.appendChild(seg([[true, 'Cameras'], [false, 'Hide']], S.showCams, (v) => { S.showCams = v; renderStageBar(); }));
    }
    bar.appendChild(spacer());
    bar.appendChild(note(S.locked
      ? (S.compare === 'loupe' ? 'Move the loupe — inside it is the photograph'
        : S.compare === 'swipe' ? 'Drag the divider'
        : S.compare === 'error' ? 'Bright means the render still disagrees with the photo'
        : S.compare === 'photo' ? 'The photograph the model is trying to match'
        : 'What the model renders from this exact viewpoint')
      : 'Drag to orbit · scroll to zoom'));
  }
  renderHud();
}

const note = (t) => { const s = document.createElement('span'); s.className = 'stage-note'; s.textContent = t; return s; };
const spacer = () => { const s = document.createElement('span'); s.className = 'spacer'; return s; };

// ── hud ─────────────────────────────────────────────────────────────────────
function renderHud() {
  const hud = $('hud');
  const chips = [];
  if (S.phase === 'train') {
    chips.push(`<span class="chip" data-tone="accent">training on <b>frame ${S.active + 1}</b></span>`);
    chips.push(`<span class="chip"><b>${fmt(S.splats)}</b> splats</span>`);
  }
  if (S.phase === 'result') {
    chips.push(`<span class="chip" data-tone="alt"><b>${fmt(S.preset.stats.splats)}</b> splats</span>`);
    chips.push(`<span class="chip">${(S.preset.stats.splats * 44 / 1e6).toFixed(1)} MB</span>`);
  }
  if (S.phase === 'cameras' && S.run) chips.push(`<span class="chip" data-tone="accent">placing frame <b>${S.camsRevealed}</b></span>`);
  if (S.flash) chips.push(`<span class="chip" data-tone="accent">${S.flash.msg}</span>`);

  const legend = (S.phase === 'cameras' || S.phase === 'seed' || (S.phase === 'train' && !S.locked)) && S.showCams
    ? `<div class="legend">
         <span style="color:#2fd4c1"><i></i>in use now</span>
         <span style="color:#f2a03f"><i></i>held back from training</span>
         <span><i></i>placed</span>
       </div>` : '';

  hud.innerHTML = `<div class="chip-row">${chips.join('')}</div>${legend}`;
}

// ── filmstrip ───────────────────────────────────────────────────────────────
function buildStrip() {
  const strip = $('strip');
  strip.innerHTML = html(`
    <div class="strip-head">
      <b>Frames</b><span id="strip-info"></span><span class="spacer"></span>
      <span>← → to step through</span>
    </div>
    <div class="strip-scroll" id="strip-scroll"></div>`);
  const sc = $('strip-scroll');
  const io = new IntersectionObserver((es) => {
    es.forEach(async (e) => {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      const i = +e.target.dataset.i;
      const b = await bmp(S.scene.cams[i].url, 160);
      if (!b) return;
      const cv = document.createElement('canvas');
      cv.width = b.width; cv.height = b.height;
      cv.getContext('2d').drawImage(b, 0, 0);
      const img = e.target.querySelector('.ph');
      if (img) img.replaceWith(Object.assign(new Image(), { src: cv.toDataURL('image/jpeg', .7) }));
    });
  }, { root: sc, rootMargin: '200px' });

  S.scene.cams.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'frame';
    b.dataset.i = i;
    b.innerHTML = `<div class="ph"></div><span class="frame-n">${i + 1}</span>
      <span class="frame-tag" hidden></span><div class="frame-bar"><i></i></div>`;
    b.addEventListener('click', () => selectCam(i));
    sc.appendChild(b);
    io.observe(b);
  });
  paintStrip();
}

function paintStrip() {
  if (!S.scene) return;
  const sc = $('strip-scroll');
  if (!sc) return;
  const showScores = S.phase === 'train' || S.phase === 'result';
  S.scene.cams.forEach((c, i) => {
    const b = sc.children[i];
    if (!b) return;
    b.dataset.sel = i === S.sel ? '1' : '0';
    b.dataset.live = (S.training && i === S.active) ? '1' : '0';
    b.dataset.state = c.state;
    const tag = b.querySelector('.frame-tag');
    const t = c.state === 'holdout' ? 'holdout' : c.state === 'unplaced' ? 'unplaced' : c.state === 'blurry' ? 'blur' : null;
    tag.hidden = !t;
    if (t) { tag.dataset.t = c.state; tag.textContent = t; }
    const bar = b.querySelector('.frame-bar i');
    bar.style.width = showScores ? `${clamp((c.psnr - 12) / 22, 0, 1) * 100}%` : '0%';
    bar.style.background = c.state === 'holdout' ? '#f2a03f' : '#2fd4c1';
  });
  const info = $('strip-info');
  if (info) {
    const placed = S.scene.cams.filter((c) => c.state !== 'unplaced').length;
    info.textContent = S.phase === 'frames'
      ? `${S.scene.cams.length} photographs · ${S.preset.res}`
      : `${placed} placed · 1 held back${S.scene.cams.some((c) => c.state === 'blurry') ? ' · blurred frames excluded from the comparison' : ''}`;
  }
}

function selectCam(i) {
  if (!S.scene) return;
  S.sel = (i + S.scene.cams.length) % S.scene.cams.length;
  const b = $('strip-scroll')?.children[S.sel];
  b?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  if (S.locked) lockTo(S.sel);
  paintStrip(); renderStageBar(); renderInspector();
}

function lockTo(i) {
  const c = S.scene.cams[i];
  if (!c.R) { flash('That frame was never placed — there is no viewpoint to render from.'); return; }
  S.sel = i; S.locked = true;
  vp.lock = c;
  loadPhoto(c.url);
  S.loupe.x = vp.w / 2 / (vp.dpr || 1); S.loupe.y = vp.h / 2 / (vp.dpr || 1);
  $('stage-view').dataset.cursor = S.compare === 'loupe' ? 'loupe' : 'default';
  renderStageBar(); paintStrip();
}

function unlock() {
  if (!S.locked) return;
  S.locked = false;
  vp.lock = null;
  vp.syncTo(S.scene.cams[S.sel]);
  $('stage-view').dataset.cursor = 'grab';
  renderStageBar();
}

async function loadPhoto(url) {
  const b = await bmp(url);
  if (b && S.scene.cams[S.sel].url === url) dev.setBitmap(b, url);
}

// ── inspector ───────────────────────────────────────────────────────────────
const TABS = [['scene', 'Scene'], ['cams', 'Cameras'], ['model', 'Model'], ['train', 'Training']];

function renderInspector() {
  if (!S.scene) return;
  const host = $('inspector');
  host.innerHTML = `<div class="tabs" role="tablist"></div><div class="tabpanel" id="tabpanel"></div>`;
  const tabs = host.querySelector('.tabs');
  TABS.forEach(([id, label]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('aria-selected', String(S.tab === id));
    b.addEventListener('click', () => { S.tab = id; renderInspector(); });
    tabs.appendChild(b);
  });
  const p = $('tabpanel');
  ({ scene: tabScene, cams: tabCams, model: tabModel, train: tabTrain })[S.tab](p);
  p.querySelectorAll('.q').forEach((q) => {
    q.addEventListener('pointerenter', (e) => showTip(e.currentTarget, HELP[q.dataset.h]));
    q.addEventListener('pointerleave', hideTip);
    q.addEventListener('click', (e) => { e.stopPropagation(); showTip(e.currentTarget, HELP[q.dataset.h]); });
  });
}

function grp(title, rows) {
  return `<div class="grp"><div class="grp-head">${title}</div>${rows.join('')}</div>`;
}
function stat(k, v, o = {}) {
  return `<div class="stat"${o.adv ? ' data-adv' : ''}>
    <span class="stat-k">${k}${o.help ? `<button class="q" data-h="${o.help}" aria-label="What is this?">?</button>` : ''}</span>
    <span class="stat-v"${o.tone ? ` data-tone="${o.tone}"` : ''}>${v}</span></div>`;
}

function tabScene(p) {
  const st = S.preset.stats, sc = S.scene;
  const par = { orbit: 3.1, walk: 0.29 }[S.preset.capture] ?? 1.4;
  const good = par > 1.2;
  p.innerHTML = html(`
    ${grp('Input', [
      stat('Photographs', sc.cams.length, { help: 'frames' }),
      stat('Resolution', S.preset.res),
      stat('Capture', S.preset.captureLine.toLowerCase()),
      stat('Blurred frames', sc.cams.filter((c) => c.state === 'blurry').length, { help: 'sharp', adv: true }),
    ])}
    ${grp('Solve', [
      stat('Placed', `${st.cams} <small>/ ${sc.cams.length}</small>`, {
        help: 'placed', tone: st.cams === sc.cams.length ? 'accent' : 'red' }),
      stat('Points', fmt(st.points), { help: 'points' }),
      stat('Reprojection error', `${st.rms} <small>px</small>`, { help: 'rms', tone: st.rms < 1 ? 'accent' : 'red' }),
      stat('Focal length', `${Math.round(sc.cams[0].f)} <small>px, guessed</small>`, { help: 'focal', adv: true }),
      stat('Landmarks per photo', fmt(sc.cams[S.sel]?.feats || 0), { adv: true }),
      stat('Solve time', `${st.sfm} <small>s</small>`, { adv: true }),
    ])}
    <div class="verdict" data-tone="${good ? 'good' : 'warn'}">
      <h4>${good ? '✓ Good capture' : '! Thin on parallax'}</h4>
      <p>Viewpoint moved <b>${par}°</b> between neighbouring photos on average.
      ${good
        ? 'Enough sideways movement for depth to be recoverable everywhere.'
        : 'Walking forward past a scene barely changes the angle on what is ahead, so distant parts stay guesswork. Circling the subject fixes this.'}</p>
    </div>
    ${grp('Coverage', [
      stat('Overlap between neighbours', `${S.preset.capture === 'walk' ? 94 : 71}%`, { help: 'parallax' }),
      stat('Loop closed', S.preset.capture === 'orbit' ? 'yes' : 'no', { adv: true }),
    ])}`);
}

function tabCams(p) {
  const showScore = S.phase === 'train' || S.phase === 'result';
  const rows = S.scene.cams.map((c) => `
    <tr data-i="${c.i}" data-sel="${c.i === S.sel ? 1 : 0}">
      <td>${c.i + 1}</td>
      <td data-tone="dim">${fmt(c.feats)}</td>
      <td data-tone="${c.err > 1 ? 'red' : ''}">${c.state === 'unplaced' ? '—' : c.err}</td>
      <td data-tone="${c.state === 'holdout' ? 'alt' : ''}">${showScore && c.state !== 'unplaced' ? c.psnr.toFixed(1) : '—'}</td>
      <td data-tone="${c.state === 'unplaced' ? 'red' : c.state === 'holdout' ? 'alt' : 'dim'}">${
        c.state === 'placed' ? '·' : c.state === 'holdout' ? 'held' : c.state === 'blurry' ? 'blur' : 'unplaced'}</td>
    </tr>`).join('');
  p.innerHTML = html(`
    <table class="ctable">
      <thead><tr><th>Frame</th><th>Marks</th><th>Err px</th><th>dB</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`);
  p.querySelectorAll('tr[data-i]').forEach((tr) => tr.addEventListener('click', () => selectCam(+tr.dataset.i)));
}

function tabModel(p) {
  const n = S.phase === 'result' ? S.preset.stats.splats : S.splats;
  p.innerHTML = html(`
    ${grp('Model', [
      stat('Splats', fmt(n), { help: 'splats' }),
      stat('Numbers per splat', '14', { help: 'splats' }),
      stat('Seeded from', `${fmt(S.preset.stats.points)} <small>points</small>`),
      stat('Ceiling', fmt(Math.round(S.preset.stats.splats * 1.4)), { adv: true }),
    ])}
    ${grp('Each splat carries', [
      stat('Position', '3 numbers', { adv: true }),
      stat('Size along 3 axes', '3 numbers', { adv: true }),
      stat('Orientation', '4 numbers', { adv: true }),
      stat('Colour', '3 numbers', { adv: true }),
      stat('Transparency', '1 number', { adv: true }),
    ])}
    ${grp('Memory', [
      stat('Graphics memory', `${(n * 96 / 1e6).toFixed(0)} <small>MB</small>`, { help: 'vram' }),
      stat('Exported file', `${(n * 44 / 1e6).toFixed(1)} <small>MB</small>`, { help: 'mem' }),
    ])}`);
}

function tabTrain(p) {
  const c = S.scene.cams[S.sel];
  const prog = S.iter / S.maxIter;
  p.innerHTML = html(`
    ${grp('Progress', [
      stat('Cycles', `${fmt(S.iter)} <small>/ ${fmt(S.maxIter)}</small>`, { help: 'iter' }),
      stat('Cycles per second', S.training ? fmt(Math.round(340 * S.speed)) : '—', { help: 'ips' }),
      stat('Photos seen', fmt(S.iter), { adv: true }),
      stat('Step size', `${(1.6e-4 * Math.pow(.01, prog)).toExponential(1)}`, { adv: true }),
    ])}
    ${grp('Score', [
      stat('On trained photos', `${psnrAt(prog).train.toFixed(2)} <small>dB</small>`, { help: 'psnr', tone: 'accent' }),
      stat('On the hidden photo', `${psnrAt(prog).hold.toFixed(2)} <small>dB</small>`, { help: 'hold', tone: 'alt' }),
      stat('Gap', `${(psnrAt(prog).train - psnrAt(prog).hold).toFixed(2)} <small>dB</small>`, { adv: true }),
    ])}
    ${grp(`Frame ${S.sel + 1}`, [
      stat('State', c.state),
      stat('Score', c.psnr ? `${c.psnr.toFixed(1)} <small>dB</small>` : '—', { tone: c.state === 'holdout' ? 'alt' : '' }),
      stat('Sharpness', `${(c.sharp * 100) | 0}%`, { help: 'sharp' }),
      stat('Landmarks', fmt(c.feats), { adv: true }),
      stat('Matched into the cloud', fmt(c.matched), { help: 'match', adv: true }),
    ])}`);
}

// ── transport ───────────────────────────────────────────────────────────────
function renderTransport() {
  const t = $('transport');
  t.className = 'transport';
  if (S.phase === 'result') return renderResultBar(t);

  if (S.run) {
    t.innerHTML = html(`
      <div class="tmeta"><span class="tmeta-1" id="run-title"></span><span class="tmeta-2" id="run-sub"></span></div>
      <div class="meter" style="height:6px"><i id="run-bar" style="width:0%"></i></div>
      <div></div>`);
    return;
  }
  if (S.phase !== 'train') { t.innerHTML = ''; return; }

  t.innerHTML = html(`
    <div class="tcontrols">
      <button class="play" id="t-play" data-state="${S.training ? 'pause' : 'play'}">${S.training ? '❚❚' : '▶'}</button>
      <button class="tbtn-sm" id="t-step">+1000</button>
      <button class="tbtn-sm" id="t-speed">${S.speed}×</button>
      <div class="tmeta">
        <span class="tmeta-1" id="t-iter">${fmt(S.iter)}</span>
        <span class="tmeta-2">of ${fmt(S.maxIter)} cycles</span>
      </div>
    </div>
    <div class="chartwrap"><canvas id="chart"></canvas><div class="chart-tip" id="chart-tip" hidden></div></div>
    <div class="tscores">
      <div class="score" data-tone="accent"><div class="score-v" id="t-ptrain">—</div><div class="score-k">trained dB</div></div>
      <div class="score" data-tone="alt"><div class="score-v" id="t-phold">—</div><div class="score-k">hidden dB</div></div>
    </div>`);

  $('t-play').addEventListener('click', toggleTrain);
  $('t-step').addEventListener('click', () => { S.iter = Math.min(S.maxIter, S.iter + 1000); ensureCurve(); });
  $('t-speed').addEventListener('click', () => {
    S.speed = S.speed === 1 ? 4 : S.speed === 4 ? 16 : 1;
    $('t-speed').textContent = `${S.speed}×`;
  });
  attachChart();
}

function renderResultBar(t) {
  t.className = 'transport resultbar';
  const st = S.preset.stats;
  t.innerHTML = html(`
    <div class="result-head">
      <h2>${S.preset.name} is done</h2>
      <p><b class="mono">${S.preset.psnr.hold.toFixed(1)} dB</b> on the photograph it never saw ·
         ${fmt(st.splats)} splats · ${(st.splats * 44 / 1e6).toFixed(1)} MB ·
         ${S.preset.minutes} min in this tab</p>
    </div>
    <div class="result-actions">
      <button class="btn btn-quiet" id="r-compare">Compare with the hidden photo</button>
      <button class="btn btn-quiet" id="r-replay">Replay the training</button>
      <button class="btn btn-quiet" id="r-export">Export .ply</button>
      <button class="btn btn-accent" id="r-arrival">Export to Arrival.Space</button>
    </div>`);
  $('r-compare').addEventListener('click', () => {
    const h = S.scene.holdout >= 0 ? S.scene.holdout : S.sel;
    S.compare = 'swipe';
    selectCam(h); lockTo(h);
  });
  $('r-replay').addEventListener('click', replay);
  $('r-export').addEventListener('click', advance);
  $('r-arrival').addEventListener('click', () =>
    flash('Publishes the splat straight into one of your arrival.space rooms.', 4500));
}

function replay() {
  S.replayAt = 0;
  if (!S.locked) lockTo(S.sel);
  S.compare = 'render';
  const t0 = performance.now();
  const tick = () => {
    const u = (performance.now() - t0) / 5200;
    S.replayAt = Math.min(1, u);
    if (u < 1) requestAnimationFrame(tick); else setTimeout(() => { S.replayAt = null; }, 700);
  };
  tick();
  renderStageBar();
}

function toggleTrain() {
  S.training = !S.training;
  const b = $('t-play');
  if (b) { b.dataset.state = S.training ? 'pause' : 'play'; b.textContent = S.training ? '❚❚' : '▶'; }
}

// ── the score curve ─────────────────────────────────────────────────────────
/** score curve: a saturating approach, starting ~11.5 dB below where it lands */
function psnrAt(p, drop = 0, holdDrop = 0) {
  const f = (a, tau) => a - 11.5 * Math.exp(-p / tau);
  return {
    train: f(S.preset.psnr.train - drop, .13),
    hold: f(S.preset.psnr.hold - holdDrop, .17),
  };
}

function ensureCurve() {
  if (!chart) return;
  chart.maxIter = S.maxIter;
  chart.events = EVENTS;
  chart.reset();
  const steps = 90;
  const upto = S.iter / S.maxIter;
  for (let i = 0; i <= steps; i++) {
    const p = (i / steps) * upto;
    const v = psnrAt(p);
    const n = Math.sin(i * 12.9898) * 0.06;
    chart.push(p * S.maxIter, v.train + n, v.hold + n * .7);
  }
  const g = GHOSTS[S.ghost];
  chart.ghost = g ? {
    train: Array.from({ length: steps + 1 }, (_, i) => {
      const p = (i / steps) * upto; return [p * S.maxIter, psnrAt(p, g.drop, g.holdDrop).train];
    }),
    hold: Array.from({ length: steps + 1 }, (_, i) => {
      const p = (i / steps) * upto; return [p * S.maxIter, psnrAt(p, g.drop, g.holdDrop).hold];
    }),
  } : null;
  chart.draw();
}

function attachChart() {
  const cv = $('chart');
  if (!cv) return;
  chart = new Chart(cv, {
    onHover: (h) => {
      const tip = $('chart-tip');
      if (!tip) return;
      if (!h) { tip.hidden = true; return; }
      tip.hidden = false;
      tip.style.left = `${h.xPct}%`;
      tip.style.top = '4px';
      tip.innerHTML = `${fmt(h.iter)} · <b style="color:#2fd4c1">${h.train.toFixed(1)}</b>` +
        (h.hold != null ? ` / <b style="color:#f2a03f">${h.hold.toFixed(1)}</b> dB` : '') +
        (h.event ? `<br><span style="color:#93a1a0">${h.event}</span>` : '');
    },
  });
  chart.resize();
  ensureCurve();
}

// ── flash ───────────────────────────────────────────────────────────────────
function flash(msg, ms = 3000) {
  S.flash = { msg, until: performance.now() + ms };
  renderHud();
}

// ── main loop ───────────────────────────────────────────────────────────────
let lastT = performance.now(), lastStrip = 0, lastSample = 0, camTimer = 0;

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  if (S.flash && now > S.flash.until) { S.flash = null; renderHud(); }

  // staged fake work
  if (S.run) {
    const u = clamp((now - S.run.t0) / S.run.dur, 0, 1);
    const bar = $('run-bar');
    if (bar) {
      bar.style.width = `${u * 100}%`;
      const T = { features: ['Finding landmarks', 'scanning frame'], cameras: ['Placing cameras', 'frame'], seed: ['Seeding splats', 'point'] }[S.run.kind];
      $('run-title').textContent = T[0];
      $('run-sub').textContent = S.run.kind === 'cameras'
        ? `${Math.round(u * S.preset.stats.cams)} of ${S.scene.cams.length} placed`
        : `${T[1]} ${Math.max(1, Math.round(u * S.scene.cams.length))} of ${S.scene.cams.length}`;
    }
    if (S.run.kind === 'cameras') S.camsRevealed = Math.round(u * S.preset.stats.cams);
    if (S.run.kind === 'seed') S.seedMix = u;
    if (u >= 1) { const d = S.run.onDone; S.run = null; renderTransport(); d?.(); }
  }

  // training clock
  if (S.training && S.phase === 'train') {
    S.iter = Math.min(S.maxIter, S.iter + 540 * S.speed * dt);
    const p = S.iter / S.maxIter;
    S.splats = Math.round(lerp(S.preset.stats.splats * .34, S.preset.stats.splats, Math.min(1, p / .62)));
    camTimer += dt;
    if (camTimer > .28 / Math.min(4, S.speed)) {
      camTimer = 0;
      const cams = S.scene.cams.filter((c) => c.state === 'placed');
      if (cams.length) S.active = cams[(Math.random() * cams.length) | 0].i;
      paintStrip();
    }
    // per-frame scores drift up with the run
    const v = psnrAt(p);
    S.scene.cams.forEach((c) => {
      const base = c.state === 'holdout' ? v.hold : v.train;
      c.psnr = base + (c.sharp - .72) * 2.4 + Math.sin(c.i * 2.7) * .5;
    });
    if (now - lastSample > 260) {
      lastSample = now;
      ensureCurve();
      const a = $('t-iter'), b = $('t-ptrain'), c = $('t-phold');
      if (a) a.textContent = fmt(Math.round(S.iter));
      if (b) b.textContent = v.train.toFixed(2);
      if (c) c.textContent = v.hold.toFixed(2);
      if (S.tab === 'train' || S.tab === 'model') renderInspector();
      renderHud();
    }
    for (const e of EVENTS) {
      if (p >= e.at && !(S.fired ||= new Set()).has(e.label + e.at)) {
        S.fired.add(e.label + e.at);
        if (e.kind === 'grow') flash(`${e.label} → ${fmt(S.splats)} splats`, 2600);
        else if (e.at > 0) flash(e.label, 2600);
      }
    }
    if (S.iter >= S.maxIter) { S.training = false; renderTransport(); flash('Training finished', 4000); }
  }

  drawStage(now);
}

// ── stage drawing ───────────────────────────────────────────────────────────
function drawStage(now) {
  if (!S.scene) return;
  const cv = $('stage-canvas');
  const rect = cv.getBoundingClientRect();
  if (Math.abs(rect.width * (vp.dpr || 1) - cv.width) > 2 || Math.abs(rect.height * (vp.dpr || 1) - cv.height) > 2) vp.resize();
  const ctx = vp.ctx, w = vp.w, h = vp.h, dpr = vp.dpr || 1;

  const phase = S.phase;
  const trainProg = S.replayAt != null ? S.replayAt : Math.pow(S.iter / S.maxIter, .62);

  if (phase === 'frames' || phase === 'features') {
    drawPhotoStage(ctx, w, h, dpr, phase === 'features');
    return;
  }

  if (S.locked && (phase === 'train' || phase === 'result')) {
    if (!dev.ready) { ctx.fillStyle = '#070909'; ctx.fillRect(0, 0, w, h); return; }
    const p = phase === 'result' && S.replayAt == null ? 1 : trainProg;
    vp.draw({ mode: 'splats', progress: p, cams: S.scene.cams, showCams: S.showCams,
              faint: true, skip: S.sel, active: -1, sel: S.sel });
    ctx.save();
    ctx.scale(dpr, dpr);
    S.rect = dev.render(ctx, w / dpr, h / dpr, {
      mode: S.compare, loupe: S.loupe, swipe: S.swipe, dpr,
      key: `${S.sel}:${Math.round(p * 90)}`,
    });
    ctx.restore();
    return;
  }

  // 3D stage
  const mode = phase === 'cameras' ? 'points' : 'splats';
  const prog = phase === 'seed' ? (S.seedMix ?? 0) * .06
    : phase === 'result' ? 1 : trainProg;
  vp.draw({
    mode,
    progress: prog,
    cams: S.scene.cams,
    showCams: S.showCams,
    showPath: S.showPath && S.showCams,
    reveal: phase === 'cameras' ? S.camsRevealed : undefined,
    active: S.training ? S.active : -1,
    sel: S.sel,
    dimOthers: phase === 'train' && S.training,
  });
}

function drawPhotoStage(ctx, w, h, dpr, withMarks) {
  const cam = S.scene.cams[S.sel];
  const pair = withMarks && S.pairView;
  ctx.fillStyle = '#070909';
  ctx.fillRect(0, 0, w, h);

  const img = readyBmp(cam.url);
  if (!img) { drawWait(ctx, w, h); return; }

  if (!pair) {
    const r = fitRect(img.width, img.height, w / dpr, h / dpr, 10 / dpr);
    ctx.save(); ctx.scale(dpr, dpr);
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
    if (withMarks) drawMarks(ctx, img, r, `k${S.sel}`, markReveal());
    ctx.restore();
    return;
  }

  const j = (S.sel + 1) % S.scene.cams.length;
  const img2 = readyBmp(S.scene.cams[j].url);
  const halfW = w / dpr / 2;
  ctx.save(); ctx.scale(dpr, dpr);
  const r1 = fitRect(img.width, img.height, halfW, h / dpr, 12);
  ctx.drawImage(img, r1.x, r1.y, r1.w, r1.h);
  let r2 = null;
  if (img2) {
    r2 = fitRect(img2.width, img2.height, halfW, h / dpr, 12);
    r2.x += halfW;
    ctx.drawImage(img2, r2.x, r2.y, r2.w, r2.h);
  }
  if (r2) drawMatches(ctx, img, r1, r2, `k${S.sel}`, markReveal());
  ctx.fillStyle = '#93a1a0';
  ctx.font = '500 10px "Spline Sans Mono", monospace';
  ctx.fillText(`FRAME ${S.sel + 1}`, r1.x + 4, r1.y - 5);
  if (r2) ctx.fillText(`FRAME ${j + 1}`, r2.x + 4, r2.y - 5);
  ctx.restore();
}

/** how far the landmark pass has run, for the reveal animation */
function markReveal() {
  return S.run && S.run.kind === 'features'
    ? clamp((performance.now() - S.run.t0) / S.run.dur, 0, 1) : 1;
}

function drawWait(ctx, w, h) {
  ctx.fillStyle = '#6b7877';
  ctx.font = '400 12px "Spline Sans Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('loading frame…', w / 2, h / 2);
  ctx.textAlign = 'left';
}

// ── loupe / swipe interaction ───────────────────────────────────────────────
(() => {
  const view = $('stage-view');
  const local = (e) => {
    const r = view.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width };
  };
  view.addEventListener('pointermove', (e) => {
    if (!S.locked) return;
    const p = local(e);
    if (S.compare === 'loupe') { S.loupe.x = p.x; S.loupe.y = p.y; }
    if (S.compare === 'swipe' && S.rect) S.swipe = clamp((p.x - S.rect.x) / S.rect.w, 0, 1);
  });
  view.addEventListener('wheel', (e) => {
    if (!S.locked || S.compare !== 'loupe') return;
    e.preventDefault();
    S.loupe.r = clamp(S.loupe.r - e.deltaY * .12, 40, 260);
  }, { passive: false });
})();

// ── tooltip ─────────────────────────────────────────────────────────────────
function showTip(anchor, text) {
  if (!text) return;
  const t = $('tip');
  t.textContent = text;
  t.hidden = false;
  const r = anchor.getBoundingClientRect();
  t.style.left = `${Math.min(innerWidth - 280, r.left - 240)}px`;
  t.style.top = `${r.top - 4}px`;
}
function hideTip() { $('tip').hidden = true; }

// ── capture guide ───────────────────────────────────────────────────────────
function buildGuide() {
  $('guide-body').innerHTML = GUIDE.map((g) => `
    <div class="rule" data-kind="${g.kind}">
      <div>${diagram(g.diagram)}</div>
      <div>
        <h3><span class="rule-mark">${g.kind === 'bad' ? '✕' : '✓'}</span>${g.title}</h3>
        <p>${g.body}</p>
      </div>
    </div>`).join('');
}

function diagram(kind) {
  const A = '#2fd4c1', T = '#f2a03f', R = '#e2664f', D = '#4c4038';
  const cam = (x, y, a, col) => `<g transform="translate(${x} ${y}) rotate(${a})">
      <path d="M0 0 L9 -6 L9 6 Z" fill="${col}" opacity=".85"/></g>`;
  if (kind === 'spin') {
    let g = `<circle cx="64" cy="46" r="3" fill="${R}"/>`;
    for (let i = 0; i < 8; i++) g += cam(64, 46, i * 45, R);
    g += `<circle cx="64" cy="46" r="30" stroke="${D}" fill="none" stroke-dasharray="2 3"/>`;
    return `<svg viewBox="0 0 128 92">${g}<text x="64" y="86" fill="${R}" font-size="8" font-family="monospace" text-anchor="middle">0° parallax</text></svg>`;
  }
  if (kind === 'orbit') {
    let g = `<circle cx="64" cy="44" r="9" fill="${D}"/>`;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      g += cam(64 + Math.cos(a) * 32, 44 + Math.sin(a) * 26, (a * 180 / Math.PI) + 180, T);
    }
    return `<svg viewBox="0 0 128 92">${g}<ellipse cx="64" cy="44" rx="32" ry="26" stroke="${T}" fill="none" opacity=".35"/><text x="64" y="86" fill="${T}" font-size="8" font-family="monospace" text-anchor="middle">every step = depth</text></svg>`;
  }
  if (kind === 'overlap') {
    let g = '';
    for (let i = 0; i < 4; i++) {
      g += `<rect x="${10 + i * 22}" y="24" width="46" height="34" fill="none" stroke="${i % 2 ? A : T}" opacity=".7"/>`;
    }
    return `<svg viewBox="0 0 128 92">${g}<text x="64" y="80" fill="${T}" font-size="8" font-family="monospace" text-anchor="middle">~70% shared</text></svg>`;
  }
  if (kind === 'height') {
    let g = `<circle cx="64" cy="50" r="8" fill="${D}"/>`;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g += cam(64 + Math.cos(a) * 30, 50 + Math.sin(a) * 18, a * 180 / Math.PI + 180, T);
      g += cam(64 + Math.cos(a) * 22, 30 + Math.sin(a) * 12, a * 180 / Math.PI + 180, A);
    }
    return `<svg viewBox="0 0 128 92">${g}<text x="64" y="86" fill="${A}" font-size="8" font-family="monospace" text-anchor="middle">two heights</text></svg>`;
  }
  return `<svg viewBox="0 0 128 92">
    <rect x="34" y="20" width="60" height="44" fill="none" stroke="${R}" stroke-dasharray="3 3"/>
    <path d="M40 60 L88 26" stroke="${R}" stroke-width="2"/>
    <path d="M40 26 L88 60" stroke="${R}" stroke-width="2"/>
    <text x="64" y="80" fill="${R}" font-size="8" font-family="monospace" text-anchor="middle">mirrors · glass · sky</text></svg>`;
}
