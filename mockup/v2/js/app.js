// v2 — the tech-demo cut.
//
// One screen, four states: pick a set → watch it get prepared → watch it train
// → look at the result. Everything explanatory moved out of the way into a
// Details sheet that only exists once there is something to explain.

import { PRESETS, EVENTS, HELP } from '../../js/data.js';
import { loadScene } from '../../js/scene.js';
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
  { kind: 'seed',    dur: 1300, label: 'Seeding blobs' },
];

const S = {
  state: 'ready',              // ready | prep | train | done
  preset: null, scene: null,
  sel: 0, active: 0,
  locked: false, compare: 'loupe',
  loupe: { x: 0, y: 0, r: 104 }, swipe: .5, rect: null,
  iter: 0, maxIter: 40000, speed: 1, splats: 0, training: false,
  prepAt: 0, fired: null, flash: null, replayAt: null,
  detailTab: 'marks',
};

let vp, dev, chart, dvp, dchart;

boot();

// ── boot ────────────────────────────────────────────────────────────────────
function boot() {
  const sel = $('scene-pick');
  PRESETS.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `${p.name} — ${p.count} frames`;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => open(PRESETS.find((p) => p.id === sel.value)));

  vp = new Viewport($('cv'));
  dev = new Developer();

  $('btn-go').addEventListener('click', startPrep);
  $('btn-own').addEventListener('click', () =>
    flash('In the real thing this is where your own photos go. The demo ships the ready sets.', 5000));
  $('btn-details').addEventListener('click', openDetails);
  $('d-close').addEventListener('click', () => { $('details').hidden = true; });

  addEventListener('resize', () => { vp.resize(); chart?.resize(); dchart?.resize(); dvp?.resize(); });
  addEventListener('keydown', (e) => {
    if (!$('details').hidden) { if (e.key === 'Escape') $('details').hidden = true; return; }
    if (e.key === ' ' && S.state === 'train') { e.preventDefault(); toggleTrain(); }
    if (e.key === 'ArrowRight') select(S.sel + 1);
    if (e.key === 'ArrowLeft') select(S.sel - 1);
  });
  wireStage();

  window.__v2 = S;            // console access, same as v1
  open(PRESETS[0]);
  requestAnimationFrame(loop);
}

async function open(preset) {
  S.preset = preset;
  S.state = 'ready';
  S.scene = null;
  $('scene-pick').value = preset.id;
  $('start').hidden = true;
  $('controls').hidden = true;
  $('btn-details').disabled = true;
  $('strip').innerHTML = '';
  dock('');

  vp.resize();
  S.scene = await loadScene(preset);
  S.sel = 0; S.active = 0; S.iter = 0; S.training = false; S.locked = false;
  S.prepAt = 0; S.fired = new Set(); S.replayAt = null;
  S.splats = Math.round(preset.stats.splats * .34);
  vp.lock = null; vp.enabled = true;
  vp.setScene(S.scene);
  buildStrip();

  $('start-title').textContent = `${S.scene.cams.length} photographs, no 3D yet`;
  $('start-sub').textContent = preset.blurb;
  $('start').hidden = false;
  bmp(S.scene.cams[0].url);
}

// ── prep ────────────────────────────────────────────────────────────────────
function startPrep() {
  $('start').hidden = true;
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
  lockTo(S.sel);
  $('controls').hidden = false;
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
  S.locked = false;
  vp.lock = null; vp.enabled = true;
  $('stage').dataset.cursor = 'grab';
  vp.frameScene();
  vp.dist = S.scene.radius * 2.2;
  $('btn-details').disabled = false;
  renderControls();
  dock('done');
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

function renderControls() {
  const c = $('controls');
  c.innerHTML = '';
  if (S.state !== 'train' && S.state !== 'done') { c.hidden = true; return; }
  c.hidden = false;
  c.appendChild(seg([[false, 'Model'], [true, `Frame ${S.sel + 1}`]], S.locked,
    (v) => (v ? lockTo(S.sel) : unlock())));
  if (S.locked) {
    c.appendChild(seg([['render', 'Render'], ['loupe', 'Loupe'], ['swipe', 'Swipe'], ['error', 'Error']],
      S.compare, (v) => {
        S.compare = v;
        $('stage').dataset.cursor = v === 'loupe' ? 'loupe' : 'default';
        renderControls();
      }));
  }
}

function lockTo(i) {
  const cam = S.scene.cams[i];
  if (!cam.R) { flash('That frame was never placed — there is no viewpoint to render from.'); return; }
  S.sel = i; S.locked = true;
  vp.lock = cam; vp.enabled = false;
  bmp(cam.url).then((b) => { if (b && S.scene.cams[S.sel].url === cam.url) dev.setBitmap(b, cam.url); });
  S.loupe.x = $('stage').clientWidth / 2;
  S.loupe.y = $('stage').clientHeight / 2;
  $('stage').dataset.cursor = S.compare === 'loupe' ? 'loupe' : 'default';
  renderControls(); paintStrip();
}

function unlock() {
  S.locked = false;
  vp.lock = null; vp.enabled = true;
  vp.syncTo(S.scene.cams[S.sel]);
  $('stage').dataset.cursor = 'grab';
  renderControls();
}

function select(i) {
  if (!S.scene) return;
  S.sel = (i + S.scene.cams.length) % S.scene.cams.length;
  $('strip-scroll')?.children[S.sel]?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  if (S.locked) lockTo(S.sel);
  paintStrip(); renderControls();
  if (!$('details').hidden) renderDetails();
}

function wireStage() {
  const st = $('stage');
  st.addEventListener('pointermove', (e) => {
    if (!S.locked) return;
    const r = st.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (S.compare === 'loupe') { S.loupe.x = x; S.loupe.y = y; }
    if (S.compare === 'swipe' && S.rect) S.swipe = clamp((x - S.rect.x) / S.rect.w, 0, 1);
  });
  st.addEventListener('wheel', (e) => {
    if (!S.locked || S.compare !== 'loupe') return;
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
    b.innerHTML = `<div class="ph"></div><span class="frame-n">${i + 1}</span>
      <span class="frame-tag" hidden></span><div class="frame-bar"><i></i></div>`;
    b.addEventListener('click', () => { select(i); if (S.state === 'train' || S.state === 'done') lockTo(i); });
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
    bar.style.background = c.state === 'holdout' ? '#63cfc0' : '#f2a03f';
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
          <span class="tmeta-2">of ${fmt(S.maxIter)} cycles · <span id="t-splats">—</span> blobs</span>
        </div>
      </div>
      <div class="chartwrap"><canvas id="chart"></canvas><div class="chart-tip" id="chart-tip" hidden></div></div>
      <div class="tscores">
        <div class="score" data-tone="amber"><div class="score-v" id="t-ptrain">—</div><div class="score-k">trained dB</div></div>
        <div class="score" data-tone="teal"><div class="score-v" id="t-phold">—</div><div class="score-k">hidden dB</div></div>
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

  const st = S.preset.stats;
  d.innerHTML = `
    <h2>Done</h2>
    <p><b class="mono">${S.preset.psnr.hold.toFixed(1)} dB</b> on the photograph it never saw ·
       ${fmt(st.splats)} blobs · ${(st.splats * 44 / 1e6).toFixed(1)} MB</p>
    <span class="grow"></span>
    <div class="dock-actions">
      <button class="btn btn-quiet" id="r-hold">Compare with the hidden photo</button>
      <button class="btn btn-quiet" id="r-replay">Replay</button>
      <button class="btn btn-amber" id="r-export">Export .ply</button>
    </div>`;
  $('r-hold').addEventListener('click', () => {
    const h = S.scene.holdout >= 0 ? S.scene.holdout : S.sel;
    S.compare = 'swipe';
    select(h); lockTo(h);
  });
  $('r-replay').addEventListener('click', replay);
  $('r-export').addEventListener('click', () =>
    flash(`A .ply of ${fmt(st.splats)} blobs would land in your downloads.`, 4000));
}

function chartTip(h) {
  const tip = $('chart-tip');
  if (!tip) return;
  if (!h) { tip.hidden = true; return; }
  tip.hidden = false;
  tip.style.left = `${h.xPct}%`;
  tip.style.top = '4px';
  tip.innerHTML = `${fmt(h.iter)} · <b style="color:#f2a03f">${h.train.toFixed(1)}</b>` +
    (h.hold != null ? ` / <b style="color:#63cfc0">${h.hold.toFixed(1)}</b> dB` : '') +
    (h.event ? `<br><span style="color:#a3958a">${h.event}</span>` : '');
}

function replay() {
  if (!S.locked) lockTo(S.sel);
  S.compare = 'render';
  renderControls();
  const t0 = performance.now();
  const tick = () => {
    const u = (performance.now() - t0) / 5000;
    S.replayAt = Math.min(1, u);
    if (u < 1) requestAnimationFrame(tick);
    else setTimeout(() => { S.replayAt = null; }, 800);
  };
  tick();
}

// ── flash ───────────────────────────────────────────────────────────────────
function flash(msg, ms = 2800) {
  S.flash = { msg, until: performance.now() + ms };
}

function renderHud() {
  const chips = [];
  if (S.state === 'train') {
    chips.push(`<span class="chip" data-tone="amber">training on <b>frame ${S.active + 1}</b></span>`);
    chips.push(`<span class="chip"><b>${fmt(S.splats)}</b> blobs</span>`);
  }
  if (S.state === 'done' && !S.locked) {
    chips.push(`<span class="chip" data-tone="teal">drag to look around</span>`);
  }
  if (S.flash) chips.push(`<span class="chip" data-tone="amber">${S.flash.msg}</span>`);
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
        flash(e.kind === 'grow' ? `${e.label} → ${fmt(S.splats)} blobs` : e.label, 2400);
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
  return `${fmt(s.points)} points → ${fmt(lerp(s.points, s.splats * .34, st.u))} blobs`;
}

// ── drawing ─────────────────────────────────────────────────────────────────
function draw() {
  const cv = $('cv');
  const r = cv.getBoundingClientRect();
  if (Math.abs(r.width * (vp.dpr || 1) - cv.width) > 2 || Math.abs(r.height * (vp.dpr || 1) - cv.height) > 2) vp.resize();
  const ctx = vp.ctx, w = vp.w, h = vp.h, dpr = vp.dpr || 1;
  const prog = S.replayAt != null ? S.replayAt
    : S.state === 'done' ? 1 : Math.pow(S.iter / S.maxIter, .62);

  if (S.state === 'ready') { photoStage(ctx, w, h, dpr, 0); return; }

  if (S.state === 'prep') {
    const st = prepStep();
    if (!st) return;
    if (st.kind === 'marks') return photoStage(ctx, w, h, dpr, st.u);
    if (st.kind === 'matches') return pairStage(ctx, w, h, dpr, st.u);
    return vp.draw({
      mode: st.kind === 'seed' ? 'blobs' : 'points',
      progress: st.kind === 'seed' ? st.u * .05 : 0,
      cams: S.scene.cams, showCams: true, showPath: true,
      reveal: st.kind === 'cameras' ? Math.round(st.u * S.preset.stats.cams) : undefined,
      active: -1, sel: S.sel,
    });
  }

  if (S.locked) {
    if (!dev.ready) { ctx.fillStyle = '#0a0807'; ctx.fillRect(0, 0, w, h); return; }
    ctx.save();
    ctx.scale(dpr, dpr);
    S.rect = dev.render(ctx, w / dpr, h / dpr, {
      progress: prog, mode: S.compare, loupe: S.loupe, swipe: S.swipe,
    });
    ctx.restore();
    return;
  }

  vp.draw({
    mode: 'blobs', progress: prog,
    cams: S.scene.cams,
    showCams: S.state === 'train', showPath: S.state === 'train',
    active: S.training ? S.active : -1, sel: S.sel,
    dimOthers: S.training,
  });
}

function photoStage(ctx, w, h, dpr, reveal) {
  ctx.fillStyle = '#0a0807';
  ctx.fillRect(0, 0, w, h);
  const img = readyBmp(S.scene.cams[S.sel].url);
  if (!img) return;
  const r = fitRect(img.width, img.height, w / dpr, h / dpr, 10);
  ctx.save(); ctx.scale(dpr, dpr);
  ctx.globalAlpha = S.state === 'ready' ? .55 : 1;   // the start card sits on top
  ctx.drawImage(img, r.x, r.y, r.w, r.h);
  ctx.globalAlpha = 1;
  if (reveal > 0) drawMarks(ctx, img, r, `k${S.sel}`, reveal);
  ctx.restore();
}

function pairStage(ctx, w, h, dpr, reveal) {
  ctx.fillStyle = '#0a0807';
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
  ctx.drawImage(a, r1.x, r1.y, r1.w, r1.h);
  ctx.drawImage(b, r2.x, r2.y, r2.w, r2.h);
  drawMatches(ctx, a, r1, r2, `k${S.sel}`, reveal);
  ctx.fillStyle = '#a3958a';
  ctx.font = '500 10px "Spline Sans Mono", monospace';
  ctx.fillText(`FRAME ${S.sel + 1}`, r1.x + 4, r1.y - 6);
  ctx.fillText(`FRAME ${j + 1}`, r2.x + 4, r2.y - 6);
  ctx.restore();
}

// ── details sheet ───────────────────────────────────────────────────────────
const DTABS = [['marks', 'Landmarks'], ['matches', 'Matching'], ['cams', 'Cameras']];

function openDetails() {
  $('details').hidden = false;
  renderDetails();
  if (!dchart) dchart = new Chart($('d-chart'), {});
  dchart.resize();
  fillCurve(dchart, 1);
}

function renderDetails() {
  const st = S.preset.stats, n = S.scene.cams.length;
  $('d-sub').textContent =
    `${S.preset.name} · ${n} photographs · ${st.cams} placed · ${fmt(st.points)} points · ${fmt(st.splats)} blobs`;

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
      cap: 'Teal survived the geometry test. Red was thrown out.',
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
        stat('Survived the test', '91%', 'teal'),
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
        'so the blobs do not start from nothing.',
      ],
      rows: [
        stat('Placed', `${st.cams} <small>/ ${n}</small>`, st.cams === n ? 'teal' : 'red'),
        stat('Points', fmt(st.points)),
        stat('Reprojection error', `${st.rms} <small>px</small>`, st.rms < 1 ? 'teal' : 'red'),
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
    <p>Each cycle renders the blobs from one photo's viewpoint, compares the result with that
       photograph, and nudges every blob a little to shrink the difference. Nothing here knows
       what a ${S.preset.name.toLowerCase()} is.</p>
    <p>${HELP.hold}</p>
    <div class="grp">
      ${stat('Cycles', fmt(S.maxIter))}
      ${stat('On trained photos', `${S.preset.psnr.train.toFixed(1)} <small>dB</small>`, 'amber')}
      ${stat('On the hidden photo', `${S.preset.psnr.hold.toFixed(1)} <small>dB</small>`, 'teal')}
      ${stat('Gap', `${gap >= 0 ? '' : '−'}${Math.abs(gap).toFixed(1)} <small>dB</small>`,
             Math.abs(gap) < 1.5 ? 'teal' : 'red')}
      ${stat('Blobs', fmt(st.splats))}
      ${stat('Exported file', `${(st.splats * 44 / 1e6).toFixed(1)} <small>MB</small>`)}
    </div>`;

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
  ctx.fillStyle = '#0a0807'; ctx.fillRect(0, 0, w, h);
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
  ctx.fillStyle = '#0a0807'; ctx.fillRect(0, 0, w, h);
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
