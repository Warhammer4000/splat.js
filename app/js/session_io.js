// session_io.js — save a trained run, load it back, share it as a link.
//
// Two artifacts, packed into one session zip next to the web-ready SOG:
//
//   recon.json — cameras at feature scale, frame metadata, a downsampled
//     sparse cloud, the source file list: everything the app needs to
//     PRESENT a model (capture-path tour, frustums, orbit pivot) without
//     re-solving, and to refetch the images for a training resume.
//   state.bin  — the trainer's raw float parameters and SH coefficients:
//     a bit-exact resume, no opacity baking, no SOG quantization.
//
// ?model=<url> accepts a session .zip, a .ply, or a .sog (decoded via the
// vendored splat-transform); &recon=<url> adds presentation state to bare
// model files. Bare exports carry baked opacities — fine for viewing, and
// re-exports pass them through unchanged.

import { zipStore } from './zip.js';
import { loadST } from './sog.js';

const STRIDE = 16;
const SH_C0 = 0.28209479177387814;

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

/** Presentation + resume metadata for the current run. */
export function buildReconJson(S) {
  const ses = S.session;
  const recon = ses.recon;
  const r6 = (a) => Array.from(a, (v) => +v.toPrecision(7));
  const pts = recon.points || [];
  const step = Math.max(1, Math.ceil(pts.length / 4000));
  const cloud = { xyz: [], rgb: [] };
  for (let i = 0; i < pts.length; i += step) {
    cloud.xyz.push(+pts[i].X[0].toPrecision(5), +pts[i].X[1].toPrecision(5), +pts[i].X[2].toPrecision(5));
    const c = pts[i].rgb;
    cloud.rgb.push(Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255));
  }
  return {
    version: 1,
    app: 'splat.js',
    name: S.preset && S.preset.name || 'splat',
    iter: ses.trainer.iter,
    splats: ses.trainer.n,
    shK: ses.trainer.shK,
    sceneRadius: ses.model.radius,
    center: ses.model.center ? r6(ses.model.center) : null,
    k1: recon.k1, k2: recon.k2,
    cams: recon.cams.map((c) => ({
      imgIdx: c.imgIdx, name: ses.frames[c.imgIdx].name,
      R: r6(c.R), t: r6(c.t), f: +c.f.toPrecision(7),
      cx: c.cx, cy: c.cy,
    })),
    frames: ses.frames.map((f) => ({ name: f.name, fw: f.fw, fh: f.fh, tw: f.tw, th: f.th })),
    source: {
      preset: S.preset && !String(S.preset.id).startsWith('__') ? S.preset.id : null,
      names: (S.loadedFiles || []).map((f) => f.name),
      // absolute URLs where the images live (preset runs resolve against the
      // deployment's data root — own captures have no URL and stay names-only)
      urls: (S.loadedFiles || []).map((f) => f.url ? new URL(f.url, location.href).href : null),
    },
    stats: {
      minutes: S.minutes || 0,
      psnrTrain: S.psnrTrain ?? null,
      psnrHold: S.psnrHold ?? null,
      psnrTest: S.psnrTest ? { psnr: S.psnrTest.psnr, frames: S.psnrTest.frames.length } : null,
      // the training curve, decimated to ~400 points
      chart: decimate(ses.lossHistory || [], 400).map(([i, p]) => [i, +p.toFixed(3)]),
      holds: (S.holdHist || []).map(([i, p]) => [i, +p.toFixed(3)]),
    },
    cloud,
  };
}

const decimate = (arr, max) => {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[Math.floor(i)]);
  return out;
};

/** The trainer's exact float state as one binary blob. */
export async function packState(ses) {
  const { data, n, sh, shK } = await ses.exportRawState();
  const head = new TextEncoder().encode(JSON.stringify({
    magic: 'splatjs-state', version: 1, n, shK, iter: ses.trainer.iter,
  }));
  const params = new Uint8Array(data.buffer, data.byteOffset, n * STRIDE * 4);
  const shBytes = sh ? new Uint8Array(sh.buffer, sh.byteOffset, n * shK * 3 * 4) : new Uint8Array(0);
  const out = new Uint8Array(4 + head.length + params.length + shBytes.length);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  out.set(params, 4 + head.length);
  out.set(shBytes, 4 + head.length + params.length);
  return out;
}

/** model.sog + recon.json + state.bin -> one resumable zip. */
export async function buildSessionZip(S, sogBlob) {
  const recon = buildReconJson(S);
  const state = await packState(S.session);
  return zipStore([
    { name: 'model.sog', data: new Uint8Array(await sogBlob.arrayBuffer()) },
    { name: 'recon.json', data: new TextEncoder().encode(JSON.stringify(recon)) },
    { name: 'state.bin', data: state },
  ]);
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

/** STORED-entry zip reader (the writer next door emits nothing else). */
export function unzipStore(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map();
  let o = 0;
  while (o + 30 <= bytes.length && dv.getUint32(o, true) === 0x04034b50) {
    const method = dv.getUint16(o + 8, true);
    const size = dv.getUint32(o + 18, true);
    const nameLen = dv.getUint16(o + 26, true);
    const extraLen = dv.getUint16(o + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(o + 30, o + 30 + nameLen));
    const start = o + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error(`zip entry ${name} is compressed — not a splat.js session zip`);
    out.set(name, bytes.subarray(start, start + size));
    o = start + size;
  }
  return out;
}

export function parseState(bytes) {
  const headLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headLen)));
  if (head.magic !== 'splatjs-state') throw new Error('not a splat.js state blob');
  let o = 4 + headLen;
  const params = new Float32Array(head.n * STRIDE);
  new Uint8Array(params.buffer).set(bytes.subarray(o, o + params.byteLength));
  o += params.byteLength;
  let sh = null;
  if (head.shK) {
    sh = new Float32Array(head.n * head.shK * 3);
    new Uint8Array(sh.buffer).set(bytes.subarray(o, o + sh.byteLength));
  }
  return { gaussians: { data: params, n: head.n, sh, shK: head.shK }, iter: head.iter };
}

/** Standard 3DGS PLY -> the trainer's raw layout (exact inverse of the
 *  exporter's activations; opacities stay as stored — baked is fine to view
 *  and passes through re-exports unchanged). */
export function parsePlyGaussians(bytes) {
  const headText = new TextDecoder().decode(bytes.subarray(0, 4096));
  const end = headText.indexOf('end_header\n');
  if (end < 0 || !headText.startsWith('ply')) throw new Error('not a PLY file');
  const bodyAt = end + 'end_header\n'.length;
  let n = 0;
  const props = [];
  for (const l of headText.slice(0, end).split('\n')) {
    const mv = l.match(/^element vertex (\d+)/);
    if (mv) n = +mv[1];
    const mp = l.match(/^property float (\S+)/);
    if (mp) props.push(mp[1]);
  }
  const idx = Object.fromEntries(props.map((p, i) => [p, i]));
  const need = ['x', 'y', 'z', 'f_dc_0', 'opacity', 'scale_0', 'rot_0'];
  for (const k of need) if (idx[k] == null) throw new Error(`PLY has no ${k} — not a 3DGS splat file`);
  const K = props.filter((p) => p.startsWith('f_rest_')).length / 3;
  const stride = props.length;
  // slice: the body must land 4-aligned for the Float32Array view (a PLY
  // header has arbitrary length, and zip entries sit at arbitrary offsets)
  const body = bytes.slice(bodyAt, bodyAt + n * stride * 4);
  const src = new Float32Array(body.buffer, 0, n * stride);
  const data = new Float32Array(n * STRIDE);
  const sh = K ? new Float32Array(n * K * 3) : null;
  const logit = (v) => {
    const c = Math.min(1 - 1e-5, Math.max(1e-5, v));
    return Math.log(c / (1 - c));
  };
  for (let i = 0; i < n; i++) {
    const s = i * stride, d = i * STRIDE;
    data[d] = src[s + idx.x]; data[d + 1] = src[s + idx.y]; data[d + 2] = src[s + idx.z];
    data[d + 3] = src[s + idx.scale_0]; data[d + 4] = src[s + idx.scale_1]; data[d + 5] = src[s + idx.scale_2];
    data[d + 6] = src[s + idx.rot_0]; data[d + 7] = src[s + idx.rot_1];
    data[d + 8] = src[s + idx.rot_2]; data[d + 9] = src[s + idx.rot_3];
    data[d + 10] = logit(src[s + idx.f_dc_0] * SH_C0 + 0.5);
    data[d + 11] = logit(src[s + idx.f_dc_1] * SH_C0 + 0.5);
    data[d + 12] = logit(src[s + idx.f_dc_2] * SH_C0 + 0.5);
    data[d + 13] = src[s + idx.opacity];
    for (let k = 0; k < 3 * K; k++) sh[i * 3 * K + k] = src[s + idx[`f_rest_${k}`]];
  }
  return { data, n, sh, shK: K };
}

/** .sog bytes -> gaussians, via the vendored splat-transform (sog -> ply in
 *  memory -> parse). */
export async function sogToGaussians(bytes) {
  const st = await loadST();
  const rfs = new st.MemoryReadFileSystem();
  rfs.set('model.sog', bytes);
  const [source] = await st.readFile({ filename: 'model.sog', inputFormat: 'sog', fileSystem: rfs });
  const out = new st.MemoryFileSystem();
  const pool = st.createChunkDataPool();
  try {
    await st.writeSource({ filename: 'model.ply', outputFormat: 'ply', source, pool, options: {} }, out);
  } finally {
    source.close?.();
  }
  const ply = out.results.get('model.ply');
  if (!ply) throw new Error('SOG decode produced no PLY');
  return parsePlyGaussians(ply);
}

/** Fetch + identify + decode a ?model= target.
 *  Returns { gaussians, reconJson|null, state:{iter}|null }. */
export async function fetchModel(modelUrl, reconUrl) {
  const resp = await fetch(modelUrl);
  if (!resp.ok) throw new Error(`model fetch failed (${resp.status})`);
  return decodeModel(new Uint8Array(await resp.arrayBuffer()), reconUrl);
}

/** Same, from bytes already in hand (a dropped file). */
export async function decodeModel(bytes, reconUrl) {
  let gaussians = null, reconJson = null, state = null;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // PK: either our session zip — or a bare SOG bundle, which is a zip too
    let entries = null;
    try { entries = unzipStore(bytes); } catch { /* compressed: not ours */ }
    if (entries && entries.has('recon.json')) {
      reconJson = JSON.parse(new TextDecoder().decode(entries.get('recon.json')));
    }
    if (entries && entries.has('state.bin')) {
      const st = parseState(entries.get('state.bin'));
      gaussians = st.gaussians;
      state = { iter: st.iter };
    } else if (entries && entries.has('model.sog')) {
      gaussians = await sogToGaussians(entries.get('model.sog'));
    } else if (entries && entries.has('model.ply')) {
      gaussians = parsePlyGaussians(entries.get('model.ply'));
    } else {
      gaussians = await sogToGaussians(bytes);
    }
  } else if (headTextIs(bytes, 'ply')) {
    gaussians = parsePlyGaussians(bytes);
  } else {
    gaussians = await sogToGaussians(bytes);
  }
  if (!gaussians) throw new Error('nothing loadable in the model file');
  if (!reconJson && reconUrl) {
    const r = await fetch(reconUrl);
    if (r.ok) reconJson = await r.json();
  }
  return { gaussians, reconJson, state };
}

const headTextIs = (bytes, tag) =>
  new TextDecoder().decode(bytes.subarray(0, tag.length)) === tag;
