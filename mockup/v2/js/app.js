// v2 — the tech-demo cut.
//
// One screen, four states: pick a set → watch it get prepared → watch it train
// → look at the result. Everything explanatory moved out of the way into a
// Details sheet that only exists once there is something to explain.

import { PRESETS, EVENTS, HELP, REPO, ownSet } from '../../js/data.js';
import { loadScene, DATA } from '../../js/scene.js';
import { Viewport } from '../../js/viewport.js';
import { Developer, fitRect } from '../../js/develop.js';
import { Chart } from '../../js/chart.js';
import { drawMarks, drawMatches } from '../../js/marks.js';
import { bmp, readyBmp } from '../../js/img.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

// the automatic pass between "start" and "training" — four beats, ~8 seconds
const PREP = [
  { kind: 'marks',   dur: 2400, label: 'Finding landmarks' },
  { kind: 'matches', dur: 1900, label: 'Matching photos' },
  { kind: 'cameras', dur: 2800, label: 'Placing cameras' },
  { kind: 'seed',    dur: 1300, label: 'Seeding splats' },
];

const S = {
  state: 'ready',              // ready | prep | train | done
  preset: null, scene: null,
  sel: 0, active: 0,
  atFrame: -1, compare: 'swipe',      // atFrame = the camera is sitting on that pose
  pending: null,                      // set chosen in the picker, not loaded yet
  ownUrls: null,                      // object URLs for photographs the visitor chose
  fade: 0, fadeTo: 0,                 // how much of the photograph is laid over the model
  loupe: { x: 0, y: 0, r: 104 }, swipe: .5, rect: null,
  iter: 0, maxIter: 40000, speed: 1, splats: 0, training: false,
  prepAt: 0, fired: null, flash: null, own: false, picking: false,
  detailTab: 'marks',
};

let vp, dev, chart, dvp, dchart;

boot();

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
  addEventListener('keydown', (e) => {
    if (!$('about').hidden) { if (e.key === 'Escape') $('about').hidden = true; return; }
    if (!$('details').hidden) { if (e.key === 'Escape') $('details').hidden = true; return; }
    if (S.picking && e.key === 'Escape') { closePicker(); return; }
    if (e.key === ' ' && S.state === 'train') { e.preventDefault(); toggleTrain(); }
    if (e.key === 'ArrowRight') select(S.sel + 1);
    if (e.key === 'ArrowLeft') select(S.sel - 1);
  });
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
  window.__v2 = S;            // console access, same as v1
  window.__vp = vp;
  open(PRESETS[0]);
  requestAnimationFrame(loop);
}

/** the five sets, as five thumbnails — no menu to open, no page to go back to */
function buildSetPicker() {
  const host = $('setpick');
  host.innerHTML = '';
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.dataset.id = p.id;
    b.innerHTML = `<div class="ph"></div><span>${p.name}</span>`;
    b.addEventListener('click', () => {
      if (S.picking) { S.pending = p; paintCard(p); return; }   // choose, do not load
      if (p === S.preset) return;                               // already on it
      open(p);
    });
    host.appendChild(b);
    heroUrl(p).then((url) => {
      if (!url) return;
      const img = Object.assign(new Image(), { src: url, alt: '' });
      b.querySelector('.ph')?.replaceWith(img);
    });
  }
}

function paintCard(preset) {
  $('start-kind').textContent = preset.kind;
  $('start-title').textContent = preset.name;
  $('start-origin').textContent = preset.origin;
  $('start-links').innerHTML = preset.links
    .map((l) => `<a href="${l.url}" target="_blank" rel="noopener">${l.label}</a>`).join('');
  $('card-runs').hidden = false;
  $('btn-go').textContent = 'Start training';
  [...$('setpick').children].forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.id === preset.id)));
  $('upload').classList.toggle('is-current', preset.id === '__own');
}

/** the chooser, over a run that keeps going behind it. Choosing a tile only
 *  chooses — the current run is untouched until Start training commits. */
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

/**
 * Photographs the visitor picked. They are decoded here and never leave the
 * page; each one gets an object URL so the rest of the app can treat them
 * exactly like a staged set.
 */
async function useOwnPhotos(list) {
  const files = [...list].filter((f) => f.type.startsWith('image/'));
  if (files.length < 2) {
    flash('Pick at least a couple of overlapping photos of the same place.', 4500);
    return;
  }
  if (S.ownUrls) S.ownUrls.forEach(URL.revokeObjectURL);
  S.ownUrls = files.map((f) => URL.createObjectURL(f));

  let w = 1600, h = 1000;
  try {
    const probe = await createImageBitmap(files[0]);
    w = probe.width; h = probe.height;
    probe.close?.();
  } catch { /* a format the browser will not decode; the defaults will do */ }

  open(ownSet(files, S.ownUrls, w, h));
}

/** first frame of a set, without loading the whole thing */
async function heroUrl(p) {
  if (!p.files) {
    return `${DATA}${p.dir}/` +
      p.pattern.replace(/\{i:(\d+)\}/, (_, w) => String(p.start).padStart(+w, '0'));
  }
  try {
    const t = await (await fetch(`${DATA}${p.dir}/${p.files}`)).text();
    return `${DATA}${p.dir}/${JSON.parse(t.replace(/^﻿/, ''))[0]}`;
  } catch { return null; }
}

async function open(preset, autostart = false) {
  S.preset = preset;
  S.state = 'ready';
  S.picking = false; S.pending = null;
  S.scene = null;
  $('btn-go').textContent = 'Start training';
  $('card-x').hidden = true;
  $('card-runs').hidden = false;
  $('start').hidden = true;
  $('controls').hidden = true;
  $('btn-new').hidden = true;
  $('strip').innerHTML = '';
  dock('');

  vp.resize();
  S.scene = await loadScene(preset);
  S.sel = 0; S.active = 0; S.iter = 0; S.training = false;
  S.atFrame = -1; S.fade = 0; S.fadeTo = 0;
  S.prepAt = 0; S.fired = new Set();
  S.splats = Math.round(preset.stats.splats * .34);
  vp.lock = null; vp.enabled = true;
  vp.setScene(S.scene);
  buildStrip();

  paintCard(preset);
  bmp(S.scene.cams[0].url);
  if (autostart) startPrep();
  else $('start').hidden = false;
}

// ── prep ────────────────────────────────────────────────────────────────────
function startPrep() {
  $('start').hidden = true;
  $('btn-new').hidden = false;
  S.state = 'prep';
  S.prepAt = performance.now();
  dock('prep');
}

function prepStep() {
  let t = performance.now() - S.prepAt;
  for (let i = 0; i < PREP.length; i++) {
    if (t < PREP[i].dur) return { i, u: t / PREP[i].dur, ...PREP[i] };
    t -= PREP[i].dur;
  }
  return null;
}

function startTraining() {
  S.state = 'train';
  S.training = true;
  // No frame is selected — training opens on the model itself, evolving, and
  // stepping onto a photograph is a deliberate act. But the camera starts near
  // the first usable frame rather than at some arbitrary orbit, so the first
  // thing seen is roughly what the photographer saw. Never the held-back one.
  const first = S.scene.cams.find((c) => c.R && c.state !== 'holdout') || S.scene.cams[0];
  if (first && first.R) {
    S.sel = first.i;
    vp.freeF = null;
    vp.syncTo(first);
    vp.dist = S.scene.radius * 1.35;   // stepped back, so the model is in view
    paintStrip();
  }
  renderControls();
  dock('train');
}

// ── training ────────────────────────────────────────────────────────────────
function toggleTrain() {
  S.training = !S.training;
  const b = $('t-play');
  if (b) { b.dataset.state = S.training ? 'pause' : 'play'; b.textContent = S.training ? '❚❚' : '▶'; }
}

function finish() {
  S.state = 'done';
  S.training = false;
  S.iter = S.maxIter;
  S.atFrame = -1; S.fadeTo = 0;
  vp.lock = null; vp.freeF = null;
  $('stage').dataset.cursor = 'grab';
  vp.frameScene();
  vp.dist = S.scene.radius * 2.2;
  renderControls();
  dock('');
  flash(`Done · ${S.preset.psnr.hold.toFixed(1)} dB on the photograph it never saw`, 6000);
}

/** score curve: a saturating approach from ~11.5 dB below where it lands */
function psnrAt(p) {
  const f = (a, tau) => a - 11.5 * Math.exp(-p / tau);
  return { train: f(S.preset.psnr.train, .13), hold: f(S.preset.psnr.hold, .17) };
}

function fillCurve(c, upto = S.iter / S.maxIter) {
  c.maxIter = S.maxIter;
  c.events = EVENTS;
  c.reset();
  for (let i = 0; i <= 90; i++) {
    const p = (i / 90) * upto, v = psnrAt(p), n = Math.sin(i * 12.9898) * .06;
    c.push(p * S.maxIter, v.train + n, v.hold + n * .7);
  }
  c.draw();
}

// ── stage controls ──────────────────────────────────────────────────────────
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

  // on a frame: how much of that frame's photograph is revealed over the render
  if (S.atFrame >= 0) {
    c.appendChild(seg([['swipe', 'Swipe'], ['loupe', 'Loupe'], ['error', 'Error']],
      S.compare, (v) => {
        S.compare = v;
        $('stage').dataset.cursor = cursorFor(v);
        renderControls();
      }));
  }

  if (S.state !== 'done') return;

  // what the model came to, in three numbers — the rest is one click away
  const st = S.preset.stats;
  const stats = document.createElement('button');
  stats.className = 'statchip';
  stats.innerHTML = `<span><b>${fmt(st.splats)}</b> splats</span>` +
    `<span><b>${S.preset.psnr.hold.toFixed(1)}</b> dB</span>` +
    `<span><b>${S.preset.minutes}</b> min</span><i>Details ›</i>`;
  stats.addEventListener('click', openDetails);
  c.appendChild(stats);
  c.appendChild(buildExport());
}

const DL_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" class="dl">' +
  '<path d="M22 15.3333V19.7777C22 20.3671 21.7659 20.9323 21.3491 21.349C20.9324 21.7658 20.3671 21.9999 19.7778 21.9999H4.22222C3.63285 21.9999 3.06762 21.7658 2.65087 21.349C2.23413 20.9323 2 20.3671 2 19.7777V15.3333"/>' +
  '<path d="M6.44449 9.77745L12 15.333M12 15.333L17.5556 9.77745M12 15.333L12 1.99967"/></svg>';

/** the export control: a round icon and the two things it can do */
function buildExport() {
  const mb = (S.preset.stats.splats * 44 / 1e6).toFixed(1);
  const wrap = document.createElement('div');
  wrap.className = 'exportwrap';
  wrap.innerHTML = `
    <button class="iconbtn" title="Export" aria-label="Export">${DL_ICON}</button>
    <div class="menu" hidden>
      <button data-act="arr"><b>Send to Arrival.Space</b><span>Straight into one of your rooms</span></button>
      <button data-act="ply"><b>Download .ply</b><span>Standard splat file · ${mb} MB</span></button>
    </div>`;

  const menu = wrap.querySelector('.menu');
  wrap.querySelector('.iconbtn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.menu').forEach((m) => { if (m !== menu) m.hidden = true; });
    menu.hidden = !menu.hidden;
  });
  wrap.querySelector('[data-act="ply"]').addEventListener('click', () => {
    menu.hidden = true;
    flash(`A .ply of ${fmt(S.preset.stats.splats)} splats would land in your downloads.`, 4000);
  });
  wrap.querySelector('[data-act="arr"]').addEventListener('click', () => {
    menu.hidden = true;
    flash('Publishes the splat straight into one of your arrival.space rooms.', 4500);
  });
  return wrap;
}

/** put the camera exactly on a frame's pose and lay its photograph over the model */
function goToFrame(i) {
  const cam = S.scene.cams[i];
  if (!cam.R) { flash('That frame was never placed — there is no viewpoint to jump to.'); return; }
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
  if (!S.scene) return;
  S.sel = (i + S.scene.cams.length) % S.scene.cams.length;
  $('strip-scroll')?.children[S.sel]?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  if (S.state === 'train' || S.state === 'done') goToFrame(S.sel);
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
      const b = await bmp(S.scene.cams[+e.target.dataset.i].url, 140);
      if (!b) return;
      const cv = document.createElement('canvas');
      cv.width = b.width; cv.height = b.height;
      cv.getContext('2d').drawImage(b, 0, 0);
      e.target.querySelector('.ph')?.replaceWith(
        Object.assign(new Image(), { src: cv.toDataURL('image/jpeg', .7) }));
    });
  }, { root: sc, rootMargin: '250px' });

  S.scene.cams.forEach((c, i) => {
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
  if (!sc || !S.scene) return;
  const scored = S.state === 'train' || S.state === 'done';
  S.scene.cams.forEach((c, i) => {
    const b = sc.children[i];
    if (!b) return;
    b.dataset.sel = i === S.sel ? '1' : '0';
    b.dataset.live = (S.training && i === S.active) ? '1' : '0';
    b.dataset.state = c.state;
    const tag = b.querySelector('.frame-tag');
    const t = c.state === 'holdout' ? 'held' : c.state === 'unplaced' ? 'out' : null;
    tag.hidden = !t;
    if (t) { tag.dataset.t = c.state; tag.textContent = t; }
    const bar = b.querySelector('.frame-bar i');
    bar.style.width = scored ? `${clamp((c.psnr - 12) / 22, 0, 1) * 100}%` : '0%';
    bar.style.background = c.state === 'holdout' ? '#f2a03f' : '#2fd4c1';
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
        <div class="prep-label" id="p-label">Finding landmarks</div>
        <div class="prep-sub" id="p-sub">—</div>
        <div class="prep-meter"><i id="p-bar" style="width:0%"></i></div>
      </div>
      <div class="prep-steps" id="p-steps">${PREP.map((s, i) =>
        `<span data-k="${i}"><b>${s.label}</b></span>`).join('')}</div>`;
    return;
  }

  if (kind === 'train') {
    d.innerHTML = `
      <div class="tcontrols">
        <button class="play" id="t-play" data-state="pause">❚❚</button>
        <button class="tbtn-sm" id="t-speed">1×</button>
        <div class="tmeta">
          <span class="tmeta-1" id="t-iter">0</span>
          <span class="tmeta-2">of ${fmt(S.maxIter)} cycles · <span id="t-splats">—</span> splats</span>
        </div>
      </div>
      <div class="chartwrap"><canvas id="chart"></canvas><div class="chart-tip" id="chart-tip" hidden></div></div>
      <div class="tscores">
        <div class="score" data-tone="accent"><div class="score-v" id="t-ptrain">—</div><div class="score-k">trained dB</div></div>
        <div class="score" data-tone="alt"><div class="score-v" id="t-phold">—</div><div class="score-k">hidden dB</div></div>
      </div>`;
    $('t-play').addEventListener('click', toggleTrain);
    $('t-speed').addEventListener('click', () => {
      S.speed = S.speed === 1 ? 4 : S.speed === 4 ? 16 : 1;
      $('t-speed').textContent = `${S.speed}×`;
    });
    chart = new Chart($('chart'), { onHover: chartTip });
    chart.resize();
    fillCurve(chart);
    return;
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
let lastT = performance.now(), camTimer = 0, lastSample = 0;

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min(.05, (now - lastT) / 1000);
  lastT = now;
  if (!S.scene) return;

  if (S.flash && now > S.flash.until) S.flash = null;
  S.fade += (S.fadeTo - S.fade) * Math.min(1, dt * 10);

  if (S.state === 'prep') {
    const st = prepStep();
    if (!st) startTraining();
    else {
      const bar = $('p-bar');
      if (bar) {
        const total = PREP.reduce((a, s) => a + s.dur, 0);
        const before = PREP.slice(0, st.i).reduce((a, s) => a + s.dur, 0);
        bar.style.width = `${((before + st.u * st.dur) / total) * 100}%`;
        $('p-label').textContent = st.label;
        $('p-sub').textContent = prepSub(st);
        [...$('p-steps').children].forEach((el, k) =>
          el.dataset.on = k < st.i ? 'done' : k === st.i ? '1' : '0');
      }
    }
  }

  if (S.state === 'train' && S.training) {
    S.iter = Math.min(S.maxIter, S.iter + 540 * S.speed * dt);
    const p = S.iter / S.maxIter;
    S.splats = Math.round(lerp(S.preset.stats.splats * .34, S.preset.stats.splats, Math.min(1, p / .62)));

    camTimer += dt;
    if (camTimer > .28 / Math.min(4, S.speed)) {
      camTimer = 0;
      const placed = S.scene.cams.filter((c) => c.state === 'placed');
      if (placed.length) S.active = placed[(Math.random() * placed.length) | 0].i;
      paintStrip();
    }

    const v = psnrAt(p);
    S.scene.cams.forEach((c) => {
      c.psnr = (c.state === 'holdout' ? v.hold : v.train) + (c.sharp - .72) * 2.4 + Math.sin(c.i * 2.7) * .5;
    });

    if (now - lastSample > 260) {
      lastSample = now;
      fillCurve(chart);
      $('t-iter').textContent = fmt(S.iter);
      $('t-splats').textContent = fmt(S.splats);
      $('t-ptrain').textContent = v.train.toFixed(2);
      $('t-phold').textContent = v.hold.toFixed(2);
    }
    for (const e of EVENTS) {
      if (p >= e.at && e.at > 0 && !S.fired.has(e.label + e.at)) {
        S.fired.add(e.label + e.at);
        flash(e.kind === 'grow' ? `${e.label} → ${fmt(S.splats)} splats` : e.label, 2400);
      }
    }
    if (S.iter >= S.maxIter) finish();
  }

  renderHud();
  draw();
  if (!$('details').hidden) drawDetail();
}

function prepSub(st) {
  const n = S.scene.cams.length, s = S.preset.stats;
  if (st.kind === 'marks') return `${fmt(lerp(0, s.cams * 1800, st.u))} spots · frame ${Math.max(1, Math.round(st.u * n))} of ${n}`;
  if (st.kind === 'matches') return `${fmt(lerp(0, n * 38, st.u))} pairs checked, weak ones dropped`;
  if (st.kind === 'cameras') return `${Math.round(st.u * s.cams)} of ${n} placed · ${fmt(st.u * s.points)} points`;
  return `${fmt(s.points)} points → ${fmt(lerp(s.points, s.splats * .34, st.u))} splats`;
}

// ── drawing ─────────────────────────────────────────────────────────────────
function draw() {
  const cv = $('cv');
  const r = cv.getBoundingClientRect();
  if (Math.abs(r.width * (vp.dpr || 1) - cv.width) > 2 || Math.abs(r.height * (vp.dpr || 1) - cv.height) > 2) vp.resize();
  const ctx = vp.ctx, w = vp.w, h = vp.h, dpr = vp.dpr || 1;
  const prog = S.state === 'done' ? 1 : Math.pow(S.iter / S.maxIter, .62);

  if (S.state === 'ready') { photoStage(ctx, w, h, dpr, 0); return; }

  if (S.state === 'prep') {
    const st = prepStep();
    if (!st) return;
    if (st.kind === 'marks') return photoStage(ctx, w, h, dpr, st.u);
    if (st.kind === 'matches') return pairStage(ctx, w, h, dpr, st.u);
    return vp.draw({
      mode: st.kind === 'seed' ? 'splats' : 'points',
      progress: st.kind === 'seed' ? st.u * .05 : 0,
      cams: S.scene.cams, showCams: true, showPath: true,
      reveal: st.kind === 'cameras' ? Math.round(st.u * S.preset.stats.cams) : undefined,
      active: -1, sel: S.sel,
    });
  }

  const onFrame = S.atFrame >= 0;

  vp.draw({
    mode: 'splats', progress: prog,
    cams: S.scene.cams,
    showCams: true,
    showPath: S.state === 'train' && !onFrame,
    // context, not subject: on a frame, and once the run is done and the model
    // is the thing being looked at
    faint: onFrame || S.state === 'done',
    skip: S.atFrame,
    active: S.training ? S.active : -1, sel: S.sel,
    dimOthers: S.training,
  });

  // the frame the camera is sitting on, drawn over the model it lines up with
  if (S.fade > .005 && dev.ready) {
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.globalAlpha = S.fade;
    S.rect = dev.render(ctx, w / dpr, h / dpr, {
      mode: S.compare, loupe: S.loupe, swipe: S.swipe, dpr,
      key: `${S.atFrame}:${Math.round(prog * 90)}`,
    });
    ctx.restore();
  }
}

function photoStage(ctx, w, h, dpr, reveal) {
  ctx.fillStyle = '#070909';
  ctx.fillRect(0, 0, w, h);
  const img = readyBmp(S.scene.cams[S.sel].url);
  if (!img) return;
  const r = fitRect(img.width, img.height, w / dpr, h / dpr, 10);
  ctx.save(); ctx.scale(dpr, dpr);
  ctx.globalAlpha = S.state === 'ready' ? .42 : 1;   // the start card sits on top
  ctx.drawImage(img, r.x, r.y, r.w, r.h);
  ctx.globalAlpha = 1;
  if (reveal > 0) drawMarks(ctx, img, r, `k${S.sel}`, reveal);
  ctx.restore();
}

function pairStage(ctx, w, h, dpr, reveal) {
  ctx.fillStyle = '#070909';
  ctx.fillRect(0, 0, w, h);
  const a = readyBmp(S.scene.cams[S.sel].url);
  const j = (S.sel + 1) % S.scene.cams.length;
  const b = readyBmp(S.scene.cams[j].url);
  if (!a || !b) return;
  const half = w / dpr / 2;
  ctx.save(); ctx.scale(dpr, dpr);
  const r1 = fitRect(a.width, a.height, half, h / dpr, 14);
  const r2 = fitRect(b.width, b.height, half, h / dpr, 14);
  r2.x += half;
  ctx.globalAlpha = .7;                 // dim the photos so the lines carry
  ctx.drawImage(a, r1.x, r1.y, r1.w, r1.h);
  ctx.drawImage(b, r2.x, r2.y, r2.w, r2.h);
  ctx.globalAlpha = 1;
  drawMatches(ctx, a, r1, r2, `k${S.sel}`, reveal);
  ctx.fillStyle = '#93a1a0';
  ctx.font = '500 10px "Spline Sans Mono", monospace';
  ctx.fillText(`FRAME ${S.sel + 1}`, r1.x + 4, r1.y - 6);
  ctx.fillText(`FRAME ${j + 1}`, r2.x + 4, r2.y - 6);
  ctx.restore();
}

// ── details sheet ───────────────────────────────────────────────────────────
const DTABS = [['marks', 'Landmarks'], ['matches', 'Matching'], ['cams', 'Cameras']];

function openDetails() {
  $('details').hidden = false;
  $('d-export').replaceChildren(buildExport());
  renderDetails();
  if (!dchart) dchart = new Chart($('d-chart'), {});
  dchart.resize();
  fillCurve(dchart, 1);
}

function renderDetails() {
  const st = S.preset.stats, n = S.scene.cams.length;
  $('d-sub').textContent =
    `${S.preset.name} · ${n} photographs · ${st.cams} placed · ${fmt(st.points)} points · ${fmt(st.splats)} splats`;

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
        stat('Marks on this frame', fmt(S.scene.cams[S.sel].feats)),
        stat('Average per photo', fmt(st.cams ? 1800 : 0)),
        stat('Across the set', fmt(n * 1800)),
      ],
    },
    matches: {
      cap: 'Turquoise survived the geometry test. Red was thrown out.',
      title: 'The same spot, twice',
      body: [
        'Fingerprints are compared photo against photo. Plenty of pairings are wrong, so every ' +
        'candidate set is tested against geometry: only pairings that could be explained by one ' +
        'rigid scene seen from two positions survive.',
        'What survives is a chain — a spot tracked through many photos at once — and that chain ' +
        'is what makes a position solvable.',
      ],
      rows: [
        stat('Pairs compared', fmt(n * 38)),
        stat('Survived the test', '91%', 'accent'),
        stat('Average chain length', '4.6 photos'),
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
        stat('Placed', `${st.cams} <small>/ ${n}</small>`, st.cams === n ? 'accent' : 'red'),
        stat('Points', fmt(st.points)),
        stat('Reprojection error', `${st.rms} <small>px</small>`, st.rms < 1 ? 'accent' : 'red'),
        stat('Focal length', `${Math.round(S.scene.cams[0].f)} <small>px, guessed</small>`),
        stat('Solve time', `${st.sfm} <small>s</small>`),
      ],
    },
  }[S.detailTab];

  $('d-cap').textContent = T.cap;
  $('d-txt').innerHTML =
    `<h3>${T.title}</h3>${T.body.map((p) => `<p>${p}</p>`).join('')}<div class="grp">${T.rows.join('')}</div>`;

  const gap = S.preset.psnr.train - S.preset.psnr.hold;
  $('d-txt2').innerHTML = `
    <h3>Guess, compare, nudge</h3>
    <p>Every point from the solve became a <b>splat</b>: a soft 3D blob with a position, a
       size along three axes, an orientation, a colour and a transparency. That is the whole
       model — no mesh, no texture, no surface.</p>
    <p>Each cycle renders the splats from one photo's viewpoint, compares the result with that
       photograph, and nudges every splat a little to shrink the difference. Nothing here knows
       what a ${S.preset.name.toLowerCase()} is.</p>
    <p>${HELP.hold}</p>
    <div class="grp">
      ${stat('Cycles', fmt(S.maxIter))}
      ${stat('On trained photos', `${S.preset.psnr.train.toFixed(1)} <small>dB</small>`, 'accent')}
      ${stat('On the hidden photo', `${S.preset.psnr.hold.toFixed(1)} <small>dB</small>`, 'alt')}
      ${stat('Gap', `${gap >= 0 ? '' : '−'}${Math.abs(gap).toFixed(1)} <small>dB</small>`,
             Math.abs(gap) < 1.5 ? 'accent' : 'red')}
      ${stat('Splats', fmt(st.splats))}
      ${stat('Exported file', `${(st.splats * 44 / 1e6).toFixed(1)} <small>MB</small>`)}
      ${stat('Time in this tab', `${S.preset.minutes} <small>min</small>`)}
    </div>
    <button class="btn btn-quiet" id="d-hold" style="margin-top:14px">Look at the frame it never saw</button>`;

  $('d-hold')?.addEventListener('click', () => {
    const h = S.scene.holdout >= 0 ? S.scene.holdout : S.sel;
    $('details').hidden = true;
    S.compare = 'swipe';
    select(h);
  });

  if (S.detailTab === 'cams' && !dvp) {
    dvp = new Viewport($('d-cv'));
    dvp.setScene(S.scene);
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
    dvp.draw({ mode: 'points', cams: S.scene.cams, showCams: true, showPath: true, sel: S.sel, active: -1 });
    return;
  }
  const dpr = Math.min(2, devicePixelRatio || 1);
  if (cv.width !== Math.round(cv.clientWidth * dpr)) {
    cv.width = Math.round(cv.clientWidth * dpr);
    cv.height = Math.round(cv.clientHeight * dpr);
  }
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  if (S.detailTab === 'marks') photoStageOn(ctx, w, h, dpr, 1);
  else pairStageOn(ctx, w, h, dpr, 1);
}

// the detail canvas reuses the stage painters, just on a different context
function photoStageOn(ctx, w, h, dpr, reveal) {
  const img = readyBmp(S.scene.cams[S.sel].url);
  ctx.fillStyle = '#070909'; ctx.fillRect(0, 0, w, h);
  if (!img) return;
  const r = fitRect(img.width, img.height, w / dpr, h / dpr, 6);
  ctx.save(); ctx.scale(dpr, dpr);
  ctx.drawImage(img, r.x, r.y, r.w, r.h);
  drawMarks(ctx, img, r, `k${S.sel}`, reveal);
  ctx.restore();
}

function pairStageOn(ctx, w, h, dpr, reveal) {
  const a = readyBmp(S.scene.cams[S.sel].url);
  const j = (S.sel + 1) % S.scene.cams.length;
  const b = readyBmp(S.scene.cams[j].url);
  ctx.fillStyle = '#070909'; ctx.fillRect(0, 0, w, h);
  if (!a || !b) return;
  const half = w / dpr / 2;
  ctx.save(); ctx.scale(dpr, dpr);
  const r1 = fitRect(a.width, a.height, half, h / dpr, 8);
  const r2 = fitRect(b.width, b.height, half, h / dpr, 8);
  r2.x += half;
  ctx.drawImage(a, r1.x, r1.y, r1.w, r1.h);
  ctx.drawImage(b, r2.x, r2.y, r2.w, r2.h);
  drawMatches(ctx, a, r1, r2, `k${S.sel}`, reveal);
  ctx.restore();
}
