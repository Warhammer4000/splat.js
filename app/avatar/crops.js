// crops.js — native-resolution windows of the person as extra training cameras.
//
// The room trains at the tab's frame resolution (1263 px on a 65-frame 1080p
// clip, 706 px on a 208-frame 4K one); the person is a fifth of the frame.
// A crop camera is the same pose with the principal point moved by the
// window origin, so a window cut from the NATIVE frame renders as a narrow
// view of the same scene at full pixel density — the head crops of the
// face pass, generalised to the whole person and added BEFORE training
// (one run, no continuation, no growth window to fight; 2026-09-14).
//
// Per picked frame, from the matte's bounding box at native scale:
//   - person tiles: the padded box, split along its long side into windows
//     of at most `tileMax` px (each decodes at native scale, never shrunk)
//   - a head window: a square of 0.3 × box height around the matte's mass
//     in the top rows, sampled `headWeight` times (it is the face the
//     avatar is judged by)
// The crops are NOT undistorted (the solve undistorts the frames before
// this runs); at phone-lens k1 < 0.01 that is below the noise floor.
import { decodeFrames } from '../../src/io/frames.js';

const TILE_MAX = 1024;

async function matteBox(mask, W, H) {
  const mb = await createImageBitmap(mask);
  const w = mb.width, h = mb.height;
  const cv = new OffscreenCanvas(w, h); const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(mb, 0, 0); mb.close();
  const d = g.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1; const rowSum = new Float64Array(h), rowCnt = new Int32Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4] > 96) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; rowSum[y] += x; rowCnt[y]++; }
  }
  if (x1 < 0) return null;
  // head: the matte's mass in the top 18 % of the box
  const hy = y0 + Math.max(1, Math.round(0.18 * (y1 - y0))); let sx = 0, n = 0;
  for (let y = y0; y <= hy; y++) { sx += rowSum[y]; n += rowCnt[y]; }
  const sX = W / w, sY = H / h;
  return { x0: x0 * sX, y0: y0 * sY, x1: (x1 + 1) * sX, y1: (y1 + 1) * sY, headX: (n ? sx / n : (x0 + x1) / 2) * sX, headY: ((y0 + hy) / 2) * sY };
}

const clampWin = (x, y, s, W, H) => {
  const side = Math.min(s, W, H); const cx = Math.max(0, Math.min(W - side, Math.round(x))), cy = Math.max(0, Math.min(H - side, Math.round(y)));
  return { x0: cx, y0: cy, w: side, h: side };
};

async function cut(bmp, mask, win, name) {
  const cv = new OffscreenCanvas(win.w, win.h); cv.getContext('2d').drawImage(bmp, win.x0, win.y0, win.w, win.h, 0, 0, win.w, win.h);
  const source = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
  let m = null;
  if (mask) {
    const mb = await createImageBitmap(mask); const s = bmp.width / mb.width;
    const mc = new OffscreenCanvas(win.w, win.h); const g = mc.getContext('2d'); g.imageSmoothingEnabled = true;
    g.drawImage(mb, win.x0 / s, win.y0 / s, win.w / s, win.h / s, 0, 0, win.w, win.h); mb.close();
    m = await mc.convertToBlob({ type: 'image/png' });
  }
  return { source, mask: m, name };
}

/** Append person tiles and head windows to a SOLVED session (between solve and seed).
 *  @param {import('../../src/session.js').Session} session
 *  @param {Array<{name:string, source?:Blob, mask?:Blob}|File>} files  the picked frames with their mattes */
export async function addPersonCrops(session, files, { log = () => {}, headWeight = 2, tileMax = TILE_MAX, progress } = {}) {
  const byName = new Map(files.map((f) => [f.name, f]));
  const entries = [], wins = [];
  const bodyCams = session.recon.cams.slice();
  for (let ci = 0; ci < bodyCams.length; ci++) {
    const c = bodyCams[ci]; const fr = session.frames[c.imgIdx]; const file = byName.get(fr.name);
    const mask = file && file.mask; if (!mask) continue;
    const bmp = await createImageBitmap(file.source !== undefined ? file.source : file);
    const W = bmp.width, H = bmp.height;
    const box = await matteBox(mask, W, H);
    if (!box) { bmp.close(); continue; }
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0; const pad = 0.08 * Math.max(bw, bh);
    const X0 = Math.max(0, box.x0 - pad), Y0 = Math.max(0, box.y0 - pad), X1 = Math.min(W, box.x1 + pad), Y1 = Math.min(H, box.y1 + pad);
    // person tiles along the long side, 10 % overlap
    const long = Math.max(X1 - X0, Y1 - Y0); const nT = Math.max(1, Math.ceil(long / (tileMax * 0.9)));
    const vertical = (Y1 - Y0) >= (X1 - X0); const step = long / nT;
    for (let k = 0; k < nT; k++) {
      const a = (vertical ? Y0 : X0) + k * step, size = Math.min(step * 1.1, long);
      const win = vertical
        ? { x0: Math.round(X0), y0: Math.round(Math.min(a, Y1 - size)), w: Math.round(X1 - X0), h: Math.round(size) }
        : { x0: Math.round(Math.min(a, X1 - size)), y0: Math.round(Y0), w: Math.round(size), h: Math.round(Y1 - Y0) };
      if (win.w < 32 || win.h < 32) continue;
      entries.push(await cut(bmp, mask, win, `pcrop_${fr.name}_${k}`)); wins.push({ ci, win, weight: 1, W });
    }
    // the head window
    const side = Math.round(0.3 * bh);
    const hw = clampWin(box.headX - side / 2, box.headY - side / 2, side, W, H);
    if (hw.w >= 64) { entries.push(await cut(bmp, mask, hw, `hcrop_${fr.name}`)); wins.push({ ci, win: hw, weight: headWeight, W }); }
    bmp.close();
    progress?.(ci + 1, bodyCams.length, `cutting the person windows · ${ci + 1} / ${bodyCams.length}`);
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!entries.length) { log('crops: no mattes on the picked frames — none added'); return 0; }
  // the decoder takes its per-set cap from the FIRST image: largest window first,
  // so nothing is shrunk; no trainScale (the app's buffer factor would shrink them too)
  const order = entries.map((_, i) => i).sort((i, j) => Math.max(wins[j].win.w, wins[j].win.h) - Math.max(wins[i].win.w, wins[i].win.h));
  const sortedEntries = order.map((i) => entries[i]), sortedWins = order.map((i) => wins[i]);
  const frames = await decodeFrames(sortedEntries, { ...(session.opts.frames || {}), trainScale: undefined, trainMaxDim: tileMax, log });
  const base = session.frames.length; session.frames.push(...frames);
  let added = 0;
  for (let i = 0; i < frames.length; i++) {
    const { ci, win, weight, W } = sortedWins[i]; const c = bodyCams[ci]; const fr0 = session.frames[c.imgIdx]; const fr = frames[i];
    // the base camera at its frame's native scale (fw is the feature-scale width), moved into the window, then to the crop's own feature scale
    const scaleN = W / fr0.fw;
    const fN = c.f * scaleN, fyN = (c.fy != null ? c.fy : c.f) * scaleN, cxN = (c.cx != null ? c.cx : fr0.fw / 2) * scaleN - win.x0, cyN = (c.cy != null ? c.cy : fr0.fh / 2) * scaleN - win.y0;
    const sC = fr.fw / win.w;   // native crop px -> the crop frame's feature scale
    const cam = { R: c.R, t: c.t, imgIdx: base + i, f: fN * sC, fy: fyN * sC, cx: cxN * sC, cy: cyN * sC, crop: true };
    for (let k = 0; k < weight; k++) { session.recon.cams.push(cam); added++; }
  }
  log(`crops: ${frames.length} native windows on ${bodyCams.length} frames (${wins.filter((w) => w.weight === 1).length} person tiles, ${wins.filter((w) => w.weight > 1).length} head windows x${headWeight}) — ${added} extra camera samples`);
  return frames.length;
}
