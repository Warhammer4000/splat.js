// main.js — the DEV harness UI on top of the splat.js library (src/).
// images -> SfM -> Gaussian init -> WebGPU training -> viewer/export.
//
// This page deliberately uses the layer-1 API (runSfM/GSTrainer directly)
// and keeps the window.__sfmOpts / __trainerOpts / __featMaxDim /
// __trainMaxDim bridges so console-driven experiments and the measurement
// automation keep working. The library itself reads none of them.

import {
  decodeFrames, processSource, adaptiveTrainCap,
  runSfM, initGaussians, GSTrainer,
  bakeOpacityCompensation, undistortFrames, camPosition,
} from '../../../src/index.js';
import { downloadPly } from './download.js';
import { generateSyntheticDataset } from '../../../src/synthetic.js';
import { OrbitCamera } from './viewer.js';
import { PCViewer } from './pcviewer.js';

// experiment overrides (set from the console / automation)
const frameOpts = () => ({
  featMaxDim: window.__featMaxDim || undefined,
  trainMaxDim: window.__trainMaxDim || undefined,
});

const $ = (id) => document.getElementById(id);
const logEl = $('log');

function log(msg) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  console.log('[3dgs]', msg);
}

const state = {
  images: [],
  sfm: null,
  gaussians: null,
  trainer: null,
  orbit: null,
  training: false,
  previewCam: 0,
  viewCtx: null,
  previewCtx: null,
  lossHistory: [],
};

// ---------------------------------------------------------------------------
// image loading
// ---------------------------------------------------------------------------

function showThumbs() {
  const c = $('thumbs');
  c.innerHTML = '';
  for (const im of state.images) {
    // frame thumbs are OffscreenCanvas (the library is DOM-free) — blit them
    const cv = document.createElement('canvas');
    cv.width = im.thumb.width; cv.height = im.thumb.height;
    cv.getContext('2d').drawImage(im.thumb, 0, 0);
    cv.title = im.name;
    c.appendChild(cv);
  }
  $('stat-images').textContent = state.images.length;
  $('btn-sfm').disabled = state.images.length < 2;
}

async function addFiles(files) {
  const imgs = await decodeFrames(files, { log, ...frameOpts() });
  state.images.push(...imgs);
  log(`loaded ${imgs.length} images (${state.images.length} total)`);
  showThumbs();
}

$('file-input').addEventListener('change', (e) => addFiles([...e.target.files]));
const drop = $('dropzone');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  addFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')));
});

function runDemo() {
  log('generating synthetic dataset (12 views of a textured room corner) ...');
  setTimeout(() => {
    state.images = generateSyntheticDataset(12);
    showThumbs();
    log('synthetic dataset ready');
  }, 20);
}

// sample-scene dropdown driven by ../data/index.json
// scene: { name, dir, stride, max, pattern+start+end | files }
async function loadScene(sc) {
  log(`fetching ${sc.name} (stride ${sc.stride}, max ${sc.max}) ...`);
  let names = [];
  if (sc.files) {
    const all = await (await fetch(`../../data/${sc.dir}/${sc.files}`)).json();
    for (let i = 0; i < all.length; i += sc.stride) names.push(all[i]);
  } else {
    for (let i = sc.start; i <= sc.end; i += sc.stride) {
      names.push(sc.pattern.replace(/\{i:(\d+)\}/, (_, w) => String(i).padStart(+w, '0')));
    }
  }
  names = names.slice(0, sc.max);
  const imgs = [];
  for (const name of names) {
    try {
      const resp = await fetch(`../../data/${sc.dir}/${name}`);
      if (!resp.ok) break;
      const bmp = await createImageBitmap(await resp.blob());
      // train at the provided resolution, shrunk only if the full set would
      // blow the GPU target budget (decided once, from the first image)
      if (!imgs.trainCap) {
        imgs.trainCap = window.__trainMaxDim ||
          adaptiveTrainCap(names.length, bmp.width, bmp.height);
        log(`training resolution: ${imgs.trainCap}px max dim (${names.length} images)`);
      }
      imgs.push(processSource(bmp, bmp.width, bmp.height, name, imgs.trainCap, frameOpts()));
      bmp.close();
    } catch { break; }
  }
  if (!imgs.length) { log('could not fetch dataset (serve from the Browser_3DGS root)'); return; }
  state.images = imgs;
  state.scene = sc;
  $('btn-gtposes').disabled = !sc.gt;
  showThumbs();
  log(`${sc.name} loaded: ${imgs.length} frames`);
}

// Skip SfM entirely: load the dataset's COLMAP ground-truth cameras + sparse
// cloud (data/<dir>/gt_cameras.json + gt_points.json, staged from sparse/0).
// Gives the accuracy CEILING of the trainer with perfect geometry.
$('btn-gtposes').addEventListener('click', async () => {
  try {
    $('btn-gtposes').disabled = true;
    const sc = state.scene;
    log('loading ground-truth cameras + points (COLMAP) ...');
    const gt = await (await fetch(`../../data/${sc.dir}/gt_cameras.json`)).json();
    const gtPts = await (await fetch(`../../data/${sc.dir}/gt_points.json`)).json();
    const f0 = Math.sqrt(gt.fx * gt.fy); // single-f model: split fx/fy difference
    const cams = [];
    state.images.forEach((im, idx) => {
      const p = gt.poses[im.name];
      if (!p) return;
      cams.push({ imgIdx: idx, R: p.R, t: p.t, f: f0 * (im.fw / gt.w), cx: im.fw / 2, cy: im.fh / 2 });
    });
    if (cams.length < 2) { log('no GT poses match the loaded image names'); return; }
    // decimate by stride (not top-N) so the init cloud keeps spatial coverage
    const step = Math.max(1, Math.floor(gtPts.length / 10000));
    const points = gtPts.filter((_, i) => i % step === 0)
      .map((p) => ({ X: [p[0], p[1], p[2]], rgb: [p[3] / 255, p[4] / 255, p[5] / 255], nObs: 3 }));
    state.sfm = { cams, points, medErr: 0, fScale: 1, k1: 0, k2: 0, fFeat: cams[0].f, rmsBA: null, gt: true };
    log(`ground-truth geometry loaded: ${cams.length} cameras, ${points.length} points`);
    $('stat-cams').textContent = cams.length;
    $('stat-points').textContent = points.length;
    $('btn-init').disabled = false;
  } catch (e) {
    log(`GT load FAILED: ${e.message}`);
    console.error(e);
  } finally {
    $('btn-gtposes').disabled = !(state.scene && state.scene.gt);
  }
});

(async () => {
  const sel = $('dataset-select');
  let scenes = [];
  try {
    scenes = await (await fetch('../../data/index.json')).json();
    for (const sc of scenes) {
      const o = document.createElement('option');
      o.value = sc.name;
      o.textContent = sc.name;
      sel.appendChild(o);
    }
  } catch {
    log('no ../data/index.json — only the generated scene is available');
  }
  sel.addEventListener('change', () => {
    const v = sel.value;
    if (!v) return;
    if (v === '__demo') { runDemo(); return; }
    const sc = scenes.find((s) => s.name === v);
    if (sc) loadScene(sc);
  });
})();

// ---------------------------------------------------------------------------
// SfM
// ---------------------------------------------------------------------------

$('btn-sfm').addEventListener('click', async () => {
  $('btn-sfm').disabled = true;
  try {
    const t0 = performance.now();
    state.sfm = await runSfM(state.images, log,
      (imgIdx, x, y) => state.images[imgIdx].sampleColor(x, y),
      { graph: (state.scene && state.scene.graph) || undefined, // scene may declare; else feature-based default
        ...(window.__sfmOpts || {}), // console experiment channel (dev harness only)
        debug: (d) => { window.__sfmDebug = d; } });
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    log(`SfM took ${dt}s`);
    if (undistortFrames(state.images, state.sfm)) {
      log(`undistorted training images (k1 ${state.sfm.k1.toFixed(4)}, k2 ${state.sfm.k2.toFixed(4)})`);
    }
    $('stat-cams').textContent = state.sfm.cams.length;
    $('stat-points').textContent = state.sfm.points.length;
    $('btn-init').disabled = false;
  } catch (e) {
    log(`SfM FAILED: ${e.message}`);
    console.error(e);
    $('btn-sfm').disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Gaussian init + trainer setup
// ---------------------------------------------------------------------------

$('btn-init').addEventListener('click', async () => {
  $('btn-init').disabled = true;
  try {
    // init target (grows further during training via MCMC-lite refinement);
    // moderate default — capacity A/B on synthetic showed 163k splats cost
    // 1.9dB holdout vs 50k while gaining only 0.8dB train
    const target = (window.__trainerOpts && window.__trainerOpts.initTarget) || 60000;
    const clones = Math.min(24, Math.max(2, Math.round(target / state.sfm.points.length) - 1));
    state.gaussians = initGaussians(state.sfm.points, clones);
    log(`initialized ${state.gaussians.n} Gaussians ` +
        `(scene radius ${state.gaussians.radius.toFixed(2)})`);
    $('stat-gauss').textContent = state.gaussians.n;

    // window.__trainerOpts allows console-driven experiments (e.g. A/B of
    // regularizer settings): set it before clicking "Init Gaussians"
    if (!state.trainer) state.trainer = await GSTrainer.create(window.__trainerOpts || {});
    const trainer = state.trainer;

    // training-resolution intrinsics
    const cams = state.sfm.cams.map((c) => {
      const im = state.images[c.imgIdx];
      const s = im.tw / im.fw;
      return { ...c, f: c.f * s, cx: im.tw / 2, cy: im.th / 2, w: im.tw, h: im.th };
    });
    const viewCv = $('view-canvas');
    trainer.setup(state.gaussians, cams, state.images,
      viewCv.width, viewCv.height, state.gaussians.radius);

    // canvases
    state.viewCtx = viewCv.getContext('webgpu');
    state.viewCtx.configure({ device: trainer.device, format: trainer.canvasFormat, alphaMode: 'opaque' });
    state.orbit = new OrbitCamera(viewCv, state.gaussians.center, state.gaussians.radius);
    setPreviewCam(0);

    // blur-aware training: the blurriest frames stay registered (SfM chain
    // connectivity + poses) but are excluded from the training loss so the
    // model doesn't learn their motion blur
    const sh = state.trainer.camMeta.map((m) => state.images[m.imgIdx].sharpness);
    const med = [...sh].sort((a, b) => a - b)[sh.length >> 1];
    state.trainer.excluded = new Set();
    state.trainer.camMeta.forEach((m, i) => {
      if (sh[i] < med * 0.45) state.trainer.excluded.add(i);
    });
    if (state.trainer.excluded.size) {
      log(`excluding ${state.trainer.excluded.size} blurry cameras from the training loss ` +
          `(sharpness < 45% of median; poses kept)`);
    }

    $('btn-train').disabled = false;
    $('btn-export').disabled = false;
    $('btn-cam').disabled = false;
    $('btn-pcsync').disabled = false;
    log('WebGPU trainer ready — press Start training');
    scheduleFrame();
  } catch (e) {
    log(`init FAILED: ${e.message}`);
    console.error(e);
    $('btn-init').disabled = false;
  }
});

function setPreviewCam(ci) {
  const trainer = state.trainer;
  state.previewCam = ci % trainer.camMeta.length;
  const meta = trainer.camMeta[state.previewCam];
  const im = state.images[meta.imgIdx];
  const pc = $('preview-canvas');
  pc.width = meta.w; pc.height = meta.h;
  state.previewCtx = pc.getContext('webgpu');
  state.previewCtx.configure({ device: trainer.device, format: trainer.canvasFormat, alphaMode: 'opaque' });
  // target image
  const tc = $('target-canvas');
  tc.width = im.tw; tc.height = im.th;
  const id = new ImageData(im.tw, im.th);
  for (let i = 0; i < im.tw * im.th; i++) {
    id.data[i * 4] = im.rgb[i * 3] * 255;
    id.data[i * 4 + 1] = im.rgb[i * 3 + 1] * 255;
    id.data[i * 4 + 2] = im.rgb[i * 3 + 2] * 255;
    id.data[i * 4 + 3] = 255;
  }
  tc.getContext('2d').putImageData(id, 0, 0);
  $('stat-prevcam').textContent = `${state.previewCam} (img ${meta.imgIdx})`;
}

$('btn-cam').addEventListener('click', () => setPreviewCam(state.previewCam + 1));

// ---------------------------------------------------------------------------
// snap the interactive view to the exact preview training camera
// (same pose, intrinsics, and resolution as the training preview)
// ---------------------------------------------------------------------------

function configureViewCanvas(w, h) {
  const cv = $('view-canvas');
  cv.width = w; cv.height = h;
  state.viewCtx = cv.getContext('webgpu');
  state.viewCtx.configure({
    device: state.trainer.device, format: state.trainer.canvasFormat, alphaMode: 'opaque',
  });
}

$('btn-snap').addEventListener('click', () => {
  if (!state.trainer || !state.trainer.camMeta) return;
  const meta = state.trainer.camMeta[state.previewCam];
  configureViewCanvas(meta.w, meta.h);
  state.snapCam = meta;
  state.orbit.dirty = true;
  log(`viewer snapped to training camera ${state.previewCam} — drag to unsnap (novel views reveal the overfit)`);
});

function unsnap() {
  if (!state.snapCam) return;
  const meta = state.snapCam;
  state.snapCam = null;
  configureViewCanvas(640, 480);
  // continue orbiting from (approximately) the snapped pose, pivoting around
  // nearby content rather than the (possibly distant) scene centroid so small
  // drags stay small baselines
  state.orbit.syncTo(meta, state.gaussians.radius * 0.25);
}
$('view-canvas').addEventListener('pointerdown', unsnap);
$('view-canvas').addEventListener('wheel', unsnap, { passive: true });

// ---------------------------------------------------------------------------
// training / render loop
// ---------------------------------------------------------------------------

$('btn-train').addEventListener('click', () => {
  state.training = !state.training;
  $('btn-train').textContent = state.training ? 'Pause training' : 'Start training';
  if (state.training) log('training started');
});

let lastStats = performance.now();
let itersAtStats = 0;
let frameCount = 0;

async function frameLoop() {
  const trainer = state.trainer;
  if (!trainer || !trainer.camMeta) return;
  frameCount++;

  if (state.training) {
    // auto-stop; the trainer scales its schedules (pos-lr decay, growth stop)
    // to this same horizon via opts.maxIters
    const maxIters = (window.__trainerOpts && window.__trainerOpts.maxIters) || 60000;
    if (trainer.iter >= maxIters) {
      state.training = false;
      $('btn-train').textContent = 'Start training';
      log(`training complete at ${trainer.iter} iterations (auto-stop; ` +
          `override with window.__trainerOpts = { maxIters: ... })`);
    }
  }

  if (state.training) {
    // batch enough iterations per frame to keep the GPU busy (raw kernel
    // throughput is ~2x what 5/frame achieves); UI stays at ~60fps since
    // each frame awaits the queue anyway
    for (let k = 0; k < 15; k++) trainer.stepOnce();
    $('stat-iter').textContent = trainer.iter;

    // periodic refinement: relocate dead splats + grow capacity (MCMC-lite)
    if (trainer.iter > 1500 && trainer.iter - trainer.lastRefine >= 2500) {
      trainer.lastRefine = trainer.iter;
      trainer.refine().then((r) => {
        if (r.moved || r.grown) {
          const tiles = r.overflow ? `, TILE OVERFLOW in ${r.overflow} tiles (max ${r.maxTile})` : '';
          log(`refine @${trainer.iter}: relocated ${r.moved}, grew +${r.grown} -> ${r.n} splats${tiles}`);
          $('stat-gauss').textContent = r.n;
        }
      });
    }

    if (trainer.iter % 60 < 5 && frameCount % 4 === 0) {
      trainer.renderTrainCam(state.previewCam, state.previewCtx);
    }
    const now = performance.now();
    if (now - lastStats > 2000) {
      const its = ((trainer.iter - itersAtStats) / (now - lastStats) * 1000).toFixed(1);
      $('stat-ips').textContent = its;
      itersAtStats = trainer.iter;
      lastStats = now;
      trainer.readLoss().then((mse) => {
        if (mse != null && mse > 0) {
          const psnr = (-10 * Math.log10(mse)).toFixed(2);
          $('stat-psnr').textContent = psnr;
          state.lossHistory.push([trainer.iter, mse]);
        }
      });
    }
  } else if (state.previewCtx && frameCount % 30 === 0) {
    trainer.renderTrainCam(state.previewCam, state.previewCtx);
  }

  // interactive viewer (render when orbiting, or periodically while training)
  if (state.orbit && (state.orbit.dirty || (state.training && frameCount % 6 === 0))) {
    if (state.snapCam) {
      trainer.renderView(state.snapCam, state.viewCtx, 0, state.snapCam.offset);
    } else {
      trainer.renderView(state.orbit.pose(), state.viewCtx);
    }
    state.orbit.dirty = false;
  }

  // pace against GPU queue so we don't flood it
  await trainer.device.queue.onSubmittedWorkDone();
  scheduleFrame();
}

// Keep training at full speed when the browser throttles rAF — which happens
// for hidden tabs AND occluded windows (document.hidden can stay false for
// the latter). Worker messages are never throttled, so a worker tick acts as
// a watchdog: whenever a scheduled frame hasn't fired within 150ms while
// training, it drives the loop directly.
const tickWorker = (() => {
  try {
    const src = 'setInterval(() => postMessage(0), 33);';
    return new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  } catch { return null; }
})();
let framePending = false;
let frameScheduledAt = 0;
function runFrame() {
  if (!framePending) return; // rAF and watchdog can both arrive; run once
  framePending = false;
  frameLoop();
}
if (tickWorker) {
  tickWorker.onmessage = () => {
    if (framePending && state.training && performance.now() - frameScheduledAt > 150) runFrame();
  };
}
function scheduleFrame() {
  framePending = true;
  frameScheduledAt = performance.now();
  requestAnimationFrame(runFrame);
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

$('btn-pcsync').addEventListener('click', async () => {
  try {
    $('btn-pcsync').disabled = true;
    if (!state.pcv) {
      log('starting PlayCanvas engine ...');
      state.pcv = await PCViewer.create($('pc-canvas'));
    }
    const { data, n, sh, shK } = await state.trainer.readGaussians();
    const meta = state.trainer.camMeta[0];
    const camPos = Float32Array.from(state.trainer.camMeta.flatMap(camPosition));
    const baked = bakeOpacityCompensation(data, n, meta.f, camPos);
    await state.pcv.setSplat(baked, n, {
      fov: 2 * Math.atan(meta.h / (2 * meta.f)) * 180 / Math.PI,
      center: state.gaussians.center,
      radius: state.gaussians.radius,
      cam0: meta,
      sh, shK,
    });
    state.pcv.setCameras(state.trainer.camMeta, state.gaussians.radius * 0.027);
    state.pcv.showCameras = state.showCams !== false;
    log(`PlayCanvas view synced: ${n} splats at iteration ${state.trainer.iter} (sorted standard rendering)`);
  } catch (e) {
    log(`PlayCanvas sync FAILED: ${e.message}`);
    console.error(e);
  } finally {
    $('btn-pcsync').disabled = false;
  }
});

$('btn-frustums').addEventListener('click', () => {
  state.showCams = state.showCams === false;   // undefined/true -> false -> true ...
  if (state.pcv) state.pcv.showCameras = state.showCams;
  $('btn-frustums').textContent = state.showCams ? 'hide cameras' : 'show cameras';
});

$('btn-export').addEventListener('click', async () => {
  const { data, n, sh, shK } = await state.trainer.readGaussians();
  const meta = state.trainer.camMeta[0];
  const camPos = Float32Array.from(state.trainer.camMeta.flatMap(camPosition));
  const baked = bakeOpacityCompensation(data, n, meta.f, camPos);
  downloadPly(baked, n, 'browser_3dgs.ply', sh, shK);
  log(`exported ${n} Gaussians to PLY (iteration ${state.trainer.iter}, ` +
      `SH degree ${state.trainer.shDeg}, opacity compensation baked)`);
});

// ---------------------------------------------------------------------------

window.__app = state; // console/debug access

if (!navigator.gpu) {
  log('WARNING: WebGPU is not available — SfM will work, training will not. Use Chrome/Edge.');
} else {
  log('ready — load images (or use a test dataset), then run the pipeline left to right');
}
