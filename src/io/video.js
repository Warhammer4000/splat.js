// io/video.js — turn a video file into training photographs, in the browser.
//
// Users film places; they rarely have photo sets. v2 (2026-09-08) follows what
// the 3DGS dataset tools converged on (Reflct Sharp Frames, SLAM keyframing):
//
//   decode   EVERY frame through WebCodecs (Mediabunny demux + VideoDecoder,
//            hardware, exact timestamps, rotation metadata honoured) — not
//            "whatever a 3x playback happened to present"
//   score    sharp-frames' resolution-normalised hybrid focus metric on a
//            512-px grayscale: Gaussian 5x5 denoise, then Laplacian variance
//            and Tenengrad (mean Sobel energy), log-combined 50/50; plus
//            luminance mean / clipped fraction (exposure outliers) and a
//            motion proxy (projection cross-correlation shift vs the previous
//            frame) so a paused camera does not yield 40 identical frames
//   select   local outlier removal (a frame that dips below its neighbours is
//            motion blur — a global threshold would just prefer textured
//            frames), then MOTION windows: a window closes when the camera has
//            moved ~20 % of the frame width (~80 % overlap, the Reflct guide),
//            bounded to [0.15 s, 1.0 s]; the sharpest survivor of each window
//            is kept; a device cap widens windows rather than dropping the
//            sharpest
//   capture  decode only the winners again at full resolution (no seeking,
//            no duplicate decodes) and encode JPEG q0.95
//
// Falls back to the <video>/requestVideoFrameCallback scan when WebCodecs or
// the codec is unavailable (same scorer and selector, ~10 samples/s).
//
// Mediabunny (MPL-2.0, Vanilagy) is vendored as src/vendor/mediabunny.min.mjs
// and imported lazily — the app should not pay 660 KB for photo sets.

/**
 * @typedef {object} VideoExtractOptions
 * @property {number} [maxFrames]          device cap; default 300 desktop / 140 mobile
 * @property {number} [minFrames=24]
 * @property {number} [overlap=0.8]        target overlap between kept frames (motion budget = 1 - overlap of the width)
 * @property {number} [minGapSec=0.15]     a window never closes faster than this
 * @property {number} [maxGapSec=1.0]      nor later (a paused camera still yields frames, sparsely)
 * @property {number} [outlierWindow=15]   local window for blur-dip removal (frames)
 * @property {number} [outlierSensitivity=0.6]  0 = off; a frame is dropped when its focus < (1 - s·0.5) × neighbour median
 * @property {number} [jpegQuality=0.95]
 * @property {'auto'|'webcodecs'|'element'} [engine='auto']
 * @property {(e: {stage: 'scan'|'capture', done: number, total: number}) => void} [onProgress]
 * @property {(msg: string) => void} [log]
 */

const ANALYSIS_LONG_EDGE = 512;
const MOTION_EDGE = 256;
const MOTION_BLOCKS = 4;      // 4x4 block flow: forward motion shows as radial block shifts, a pan as a common one

// ---------------------------------------------------------------- scoring

/** 5x5 Gaussian (sigma 1) on a grayscale float buffer, separable. */
function gauss5(src, w, h, tmp, dst) {
  const k = [0.0614, 0.2448, 0.3877, 0.2448, 0.0614]; // sigma 1.0, normalised
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        s += k[i + 2] * src[row + xx];
      }
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        s += k[i + 2] * tmp[yy * w + x];
      }
      dst[y * w + x] = s;
    }
  }
}

/** sharp-frames `normalized_laplacian_tenengrad_v1` on a denoised gray buffer
 *  (values 0..255): expm1(0.5·log1p(LaplacianVar) + 0.5·log1p(mean Sobel²)). */
function focusScore(g, w, h) {
  let lsum = 0, lsq = 0, ten = 0;
  const n = (w - 2) * (h - 2);
  for (let y = 1; y < h - 1; y++) {
    const r = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = r + x;
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      lsum += lap; lsq += lap * lap;
      const gx = (g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - 1] + g[i + w - 1]);
      const gy = (g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - w] + g[i - w + 1]);
      ten += gx * gx + gy * gy;
    }
  }
  const lmean = lsum / n;
  const lapVar = Math.max(0, lsq / n - lmean * lmean);
  const tenengrad = ten / n;
  return { focus: Math.expm1(0.5 * Math.log1p(lapVar) + 0.5 * Math.log1p(tenengrad)), lapVar, tenengrad };
}

/** Exposure statistics on the gray buffer: mean and clipped fraction. */
function exposure(g, n) {
  let sum = 0, clipped = 0;
  for (let i = 0; i < n; i++) { const v = g[i]; sum += v; if (v <= 4 || v >= 251) clipped++; }
  return { lum: sum / n / 255, clip: clipped / n };
}

/** Sub-pixel shift between two 1-D projections (SSE search ± maxShift, parabolic refinement). */
function projShift(a, b, n, maxShift) {
  const errs = new Float64Array(2 * maxShift + 1);
  let bestS = 0, bestE = Infinity;
  for (let s = -maxShift; s <= maxShift; s++) {
    let e = 0, c = 0;
    for (let i = Math.max(0, -s); i < Math.min(n, n - s); i++) { const d = a[i] - b[i + s]; e += d * d; c++; }
    e /= Math.max(1, c);
    errs[s + maxShift] = e;
    if (e < bestE) { bestE = e; bestS = s; }
  }
  const k = bestS + maxShift;
  if (k > 0 && k < 2 * maxShift) {
    const em = errs[k - 1], e0 = errs[k], ep = errs[k + 1];
    const den = em - 2 * e0 + ep;
    if (den > 1e-9) return bestS + 0.5 * (em - ep) / den;
  }
  return bestS;
}

/** Camera motion between consecutive small gray frames as a fraction of the
 *  width: median magnitude of per-block projection shifts on a 4x4 grid
 *  (sub-pixel). A pan moves every block the same way, walking forward moves
 *  them radially — both count; a paused camera measures ~0. At 30 fps and
 *  256 px this resolves the 0.3–1 px/frame of a walking capture. */
function motionShift(prev, cur, w, h, maxShift = 12) {
  const bw = Math.floor(w / MOTION_BLOCKS), bh = Math.floor(h / MOTION_BLOCKS);
  const mags = [];
  const px = new Float64Array(bw), cx = new Float64Array(bw), py = new Float64Array(bh), cy = new Float64Array(bh);
  for (let by = 0; by < MOTION_BLOCKS; by++) for (let bx = 0; bx < MOTION_BLOCKS; bx++) {
    px.fill(0); cx.fill(0); py.fill(0); cy.fill(0);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const i = (by * bh + y) * w + bx * bw + x;
      px[x] += prev[i]; cx[x] += cur[i]; py[y] += prev[i]; cy[y] += cur[i];
    }
    const dx = projShift(px, cx, bw, maxShift), dy = projShift(py, cy, bh, maxShift);
    mags.push(Math.hypot(dx, dy));
  }
  mags.sort((a, b) => a - b);
  return mags[mags.length >> 1] / w;
}

/** Analyse one drawn frame: fills `gray` from the canvas, returns the record. */
function makeAnalyzer(sw, sh) {
  const n = sw * sh;
  const gray = new Float32Array(n), tmp = new Float32Array(n), den = new Float32Array(n);
  const mw = MOTION_EDGE, mh = Math.max(2, Math.round(mw * sh / sw));
  let prevSmall = null;
  const small = new Float32Array(mw * mh);
  return {
    analyze(ctx, t) {
      const d = ctx.getImageData(0, 0, sw, sh).data;
      for (let i = 0; i < n; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
      gauss5(gray, sw, sh, tmp, den);
      const f = focusScore(den, sw, sh);
      const e = exposure(gray, n);
      // motion proxy on a 128-px box-downsample of the denoised gray
      const fx = sw / mw, fy = sh / mh;
      for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
        const sx = Math.min(sw - 1, Math.floor(x * fx)), sy = Math.min(sh - 1, Math.floor(y * fy));
        small[y * mw + x] = den[sy * sw + sx];
      }
      const motion = prevSmall ? motionShift(prevSmall, small, mw, mh) : 0;
      prevSmall = prevSmall || new Float32Array(mw * mh);
      prevSmall.set(small);
      return { t, focus: f.focus, lapVar: f.lapVar, tenengrad: f.tenengrad, lum: e.lum, clip: e.clip, motion };
    },
  };
}

// -------------------------------------------------------------- selection

/** Mark blur dips: a frame whose focus falls below (1 - 0.5·s) × the median of
 *  its neighbours (window w) is an outlier. Mirrors sharp-frames' intent:
 *  compare to neighbours, never to a global threshold. */
function markOutliers(frames, win = 15, s = 0.6) {
  const half = Math.max(2, win >> 1);
  const n = frames.length;
  for (let i = 0; i < n; i++) {
    if (s <= 0) { frames[i].blur = false; continue; }
    const nb = [];
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) if (j !== i) nb.push(frames[j].focus);
    if (nb.length < 4) { frames[i].blur = false; continue; }
    nb.sort((a, b) => a - b);
    const med = nb[nb.length >> 1];
    frames[i].blur = frames[i].focus < (1 - 0.5 * s) * med;
  }
  return frames;
}

/** Motion windows: accumulate the motion proxy; close a window when the camera
 *  moved `budget` of the frame width (or maxGap elapsed), never before minGap.
 *  Keep the sharpest non-blurred frame of each window. */
function selectByMotion(frames, { budget, minGap, maxGap }) {
  const picks = [];
  let start = 0, acc = 0;
  const flush = (end) => {
    let best = -1;
    for (let i = start; i <= end; i++) {
      if (frames[i].blur) continue;
      if (best < 0 || frames[i].focus > frames[best].focus) best = i;
    }
    if (best < 0) { // every frame in the window was a blur dip — take the least bad
      for (let i = start; i <= end; i++) if (best < 0 || frames[i].focus > frames[best].focus) best = i;
    }
    if (best >= 0) picks.push(best);
  };
  for (let i = 1; i < frames.length; i++) {
    acc += frames[i].motion;
    const dt = frames[i].t - frames[start].t;
    if ((acc >= budget && dt >= minGap) || dt >= maxGap) { flush(i); start = i + 1; acc = 0; }
  }
  if (start < frames.length) flush(frames.length - 1);
  return picks;
}

/** Full selection with the device cap / floor applied by rescaling the budget. */
export function selectFrames(frames, opts = {}) {
  const maxFrames = opts.maxFrames ?? defaultMaxFrames();
  const minFrames = opts.minFrames ?? 24;
  const minGap = opts.minGapSec ?? 0.15, maxGap = opts.maxGapSec ?? 1.0;
  markOutliers(frames, opts.outlierWindow ?? 15, opts.outlierSensitivity ?? 0.6);
  let budget = 1 - (opts.overlap ?? 0.8);
  let picks = selectByMotion(frames, { budget, minGap, maxGap });
  // too many: widen the motion budget (fewer, better-spread windows)
  for (let k = 0; k < 12 && picks.length > maxFrames; k++) {
    budget *= 1.25;
    picks = selectByMotion(frames, { budget, minGap, maxGap });
  }
  // still too many (a fast pan against a hard cap): keep the sharpest with even spacing
  if (picks.length > maxFrames) {
    const stride = picks.length / maxFrames;
    picks = Array.from({ length: maxFrames }, (_, i) => picks[Math.floor(i * stride)]);
  }
  // too few (a slow/static video): shrink the budget and the time floor
  for (let k = 0; k < 8 && picks.length < Math.min(minFrames, frames.length) ; k++) {
    budget *= 0.7;
    picks = selectByMotion(frames, { budget, minGap: Math.max(0.1, minGap * 0.7 ** (k + 1)), maxGap: maxGap * 0.7 ** (k + 1) });
  }
  const set = new Set(picks);
  for (let i = 0; i < frames.length; i++) frames[i].picked = set.has(i);
  return { picks, budget };
}

function defaultMaxFrames() {
  const mobile = (navigator.userAgentData && navigator.userAgentData.mobile) ||
    /Android|iPhone|iPad/i.test(navigator.userAgent || '');
  return mobile ? 140 : 300;
}

// ---------------------------------------------------------------- decode

const until = (el, ev, err = 'error') => new Promise((res, rej) => {
  const ok = () => { cleanup(); res(); };
  const bad = (e) => { cleanup(); rej(new Error(`video ${err}: ${(e && e.message) || 'decode failed'}`)); };
  const cleanup = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
  el.addEventListener(ev, ok, { once: true });
  el.addEventListener('error', bad, { once: true });
});

function mkCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  return cv;
}

function toBlob(cv, quality) {
  if (cv.convertToBlob) return cv.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((res, rej) => cv.toBlob(
    (b) => (b ? res(b) : rej(new Error('jpeg encode failed'))), 'image/jpeg', quality));
}

const analysisSize = (w, h) => {
  const s = ANALYSIS_LONG_EDGE / Math.max(w, h);
  return [Math.max(2, Math.round(w * s)), Math.max(2, Math.round(h * s))];
};

let MBmod = null;
async function mediabunny() {
  if (!MBmod) MBmod = await import('../vendor/mediabunny.min.mjs');
  return MBmod;
}

/** WebCodecs path: every frame scored, winners re-decoded at full size. */
async function extractWebCodecs(file, opts, log, onProgress) {
  const MB = await mediabunny();
  const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(file) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('no video track');
  if (!(await track.canDecode())) throw new Error('codec not decodable here');
  const [W, H] = [await track.getDisplayWidth(), await track.getDisplayHeight()];
  const rotation = await track.getRotation();
  const duration = await track.computeDuration();
  const stats = await track.computePacketStats(Infinity).catch(() => null);
  const total = stats ? stats.packetCount : Math.round(duration * 30);
  const fps = stats ? stats.averagePacketRate : null;
  let colour = '';
  try { const cs = await track.getColorSpace(); if (cs && cs.transfer) colour = ` ${cs.transfer}${cs.primaries ? '/' + cs.primaries : ''}`; } catch {}
  log(`video: ${W}x${H}${rotation ? ` (rotated ${rotation}°)` : ''}, ${duration.toFixed(1)}s, ${total} frames${fps ? ` @ ${fps.toFixed(2)} fps` : ''}${colour}`);

  // ---- pass 1: score every frame on the 512-px analysis canvas ----
  const [sw, sh] = analysisSize(W, H);
  const an = makeAnalyzer(sw, sh);
  const frames = [];
  const scanSink = new MB.CanvasSink(track, { width: sw, height: sh, fit: 'fill', poolSize: 2 });
  let done = 0;
  for await (const wrapped of scanSink.canvases()) {
    const ctx = wrapped.canvas.getContext('2d', { willReadFrequently: true });
    frames.push(an.analyze(ctx, wrapped.timestamp));
    done++;
    if (done % 8 === 0) onProgress({ stage: 'scan', done: Math.min(done, total), total });
    if (done % 64 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  onProgress({ stage: 'scan', done: frames.length, total: frames.length });
  if (frames.length < 2) throw new Error('could not decode frames from this video');

  // ---- selection ----
  const { picks, budget } = selectFrames(frames, opts);
  const blurred = frames.filter((f) => f.blur).length;
  log(`scored ${frames.length} frames (${blurred} blur dips); kept ${picks.length} — motion budget ${(budget * 100).toFixed(0)} % of the width, focus median ${median(frames.map((f) => f.focus)).toFixed(0)}`);

  // ---- pass 2: full-resolution capture of the winners ----
  const times = picks.map((i) => frames[i].t);
  const capSink = new MB.CanvasSink(track, { width: W, height: H, fit: 'fill', poolSize: 1 });
  const out = [];
  let k = 0;
  for await (const wrapped of capSink.canvasesAtTimestamps(times)) {
    if (!wrapped) { k++; continue; }
    const blob = await toBlob(wrapped.canvas, opts.jpegQuality ?? 0.95);
    out.push({ source: blob, name: `frame_${String(out.length + 1).padStart(5, '0')}.jpg`, t: wrapped.timestamp });
    k++;
    onProgress({ stage: 'capture', done: k, total: times.length });
  }
  return { frames: out, duration, sampled: frames.length, videoW: W, videoH: H, fps, rotation, engine: 'webcodecs', analysis: frames };
}

/** Fallback: <video> element scan at ~10 samples/s, same scorer/selector. */
async function extractElement(file, opts, log, onProgress) {
  const sps = 10;
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = url;
  try {
    await until(video, 'loadedmetadata');
    if (!isFinite(video.duration)) {
      video.currentTime = 1e9; await until(video, 'seeked');
      video.currentTime = 0; await until(video, 'seeked');
    }
    const duration = video.duration;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !isFinite(duration) || duration <= 0) throw new Error('video has no decodable track');
    log(`video (element path): ${vw}x${vh}, ${duration.toFixed(1)}s`);
    const [sw, sh] = analysisSize(vw, vh);
    const scanCv = mkCanvas(sw, sh);
    const scanCtx = scanCv.getContext('2d', { willReadFrequently: true });
    const an = makeAnalyzer(sw, sh);
    const frames = [];
    const totalSamples = Math.max(2, Math.floor(duration * sps));
    const scoreNow = (t) => { scanCtx.drawImage(video, 0, 0, sw, sh); frames.push(an.analyze(scanCtx, t)); };
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.playbackRate = 3;
      let lastT = -1, finished = false;
      const onFrame = (_now, meta) => {
        if (finished) return;
        const t = meta.mediaTime;
        if (t - lastT >= 1 / sps - 1e-3) { lastT = t; scoreNow(t); onProgress({ stage: 'scan', done: Math.min(frames.length, totalSamples), total: totalSamples }); }
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
      await video.play();
      await until(video, 'ended', 'playback error');
      finished = true; video.pause();
    } else {
      for (let k = 0; k < totalSamples; k++) {
        video.currentTime = Math.min(duration - 0.001, k / sps);
        await until(video, 'seeked');
        scoreNow(video.currentTime);
        onProgress({ stage: 'scan', done: k + 1, total: totalSamples });
      }
    }
    if (frames.length < 2) throw new Error('could not decode frames from this video');
    const { picks, budget } = selectFrames(frames, opts);
    log(`scored ${frames.length} samples; kept ${picks.length} (motion budget ${(budget * 100).toFixed(0)} %)`);
    const capCv = mkCanvas(vw, vh);
    const capCtx = capCv.getContext('2d');
    const out = [];
    for (let i = 0; i < picks.length; i++) {
      video.currentTime = frames[picks[i]].t;
      await until(video, 'seeked');
      capCtx.drawImage(video, 0, 0, vw, vh);
      const blob = await toBlob(capCv, opts.jpegQuality ?? 0.95);
      out.push({ source: blob, name: `frame_${String(i + 1).padStart(5, '0')}.jpg`, t: frames[picks[i]].t });
      onProgress({ stage: 'capture', done: i + 1, total: picks.length });
    }
    return { frames: out, duration, sampled: frames.length, videoW: vw, videoH: vh, fps: null, rotation: 0, engine: 'element', analysis: frames };
  } finally {
    video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
  }
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

/**
 * @param {File|Blob} file
 * @param {VideoExtractOptions} [opts]
 * @returns {Promise<{frames: Array<{source: Blob, name: string, t: number}>, duration: number,
 *   sampled: number, videoW: number, videoH: number, fps: number|null, rotation: number,
 *   engine: 'webcodecs'|'element', analysis: Array<object>}>}
 */
export async function extractSharpFrames(file, opts = {}) {
  const log = opts.log || (() => {});
  const onProgress = opts.onProgress || (() => {});
  const engine = opts.engine || 'auto';
  if (engine !== 'element' && typeof VideoDecoder !== 'undefined') {
    try {
      return await extractWebCodecs(file, opts, log, onProgress);
    } catch (e) {
      if (engine === 'webcodecs') throw e;
      log(`WebCodecs path unavailable (${e.message}) — using the <video> element`);
    }
  }
  return extractElement(file, opts, log, onProgress);
}

/** Quick sniff: is this file a video the pipeline should extract from? */
export function isVideoFile(f) {
  return /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name || '');
}
