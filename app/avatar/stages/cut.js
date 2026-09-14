// cut.js — isolate the person from the trained room.
//
// Avatar mode trains the whole scene (session opts.maskTraining false): the
// masked recipe — few seeds, a random background at the silhouette, alpha
// pressure — is what drove the needle look on skin (needle ratio 344 vs 15
// for the same clip trained as a room, lab-log 2026-09-14b). The mattes were
// kept on the frames for this stage: the sparse cloud through the mattes
// bounds the subject, the visual hull is carved from the silhouettes, and
// every splat whose centre or most of whose body lies outside the hull goes
// (gs/hull.js makeSplatTest — the same test the masked trainer used as
// dead capacity). The survivors are seeded into a fresh session on the same
// frames and cameras, which is what body fit, bind and publish export from.
//
// Known limits (the next steps): the hull is loose, so wall colour can ride
// along at the back of the head and a sliver of floor under the shoes — a
// per-splat vote over the views and a short masked polish are the cure.
import { createSession } from '../../../src/index.js';

export const id = 'cut';
export const needs = ['train'];
const STRIDE = 16;   // gs/init.js: pos3, logScale3, quat4, color3, opacity, ...

export async function run(ctx, manifest, hooks) {
  const src = ctx.session; const log = hooks.log || (() => {});
  hooks.progress?.(0, 4, 'reading the model …');
  const raw = await src.exportRawState();
  // 1. bounds + hull from the mattes (session.maskPoints / _buildHull mutate
  //    recon.points — training is over, the seed is not needed again)
  // the face-mesh seed points are not sparse-cloud evidence: with 20k of them on the
  // head the hull's median-and-MAD bounds shrank to the head (2026-09-14)
  src.recon.points = src.recon.points.filter((p) => !p.faceSeed);
  const before = src.recon.points.length;
  src.maskPoints(0.5);
  const hull = src._buildHull({});
  if (!hull || !src.splatTest) {
    log(`cut: no hull (${src.recon.points.length} of ${before} points on the subject) — the whole scene stays`);
    return { skipped: true, note: 'no hull — scene kept' };
  }
  hooks.progress?.(1, 4, 'cutting the person out …');
  // 2. the test on every splat: centre + extent (rmax = the longest axis)
  const dead = src.splatTest; const { data, n, sh, shK } = raw;
  const keep = new Uint8Array(n); let kept = 0;
  for (let i = 0; i < n; i++) {
    const b = i * STRIDE;
    const r = Math.exp(Math.max(data[b + 3], data[b + 4], data[b + 5]));
    if (!dead(data[b], data[b + 1], data[b + 2], r)) { keep[i] = 1; kept++; }
  }
  const data2 = new Float32Array(kept * STRIDE); const sh2 = sh ? new Float32Array(kept * shK * 3) : null;
  for (let i = 0, j = 0; i < n; i++) {
    if (!keep[i]) continue;
    data2.set(data.subarray(i * STRIDE, (i + 1) * STRIDE), j * STRIDE);
    if (sh2) sh2.set(sh.subarray(i * shK * 3, (i + 1) * shK * 3), j * shK * 3);
    j++;
  }
  log(`cut: hull ${hull.dim.join('x')} voxels of ${hull.cell.toFixed(3)}, ${(hull.fill * 100).toFixed(1)}% solid; ${kept.toLocaleString()} of ${n.toLocaleString()} splats are the person`);
  // 3. a fresh session on the same frames and cameras, seeded with the survivors
  hooks.progress?.(2, 4, 'loading the isolated model …');
  const { frames } = ctx; const byName = new Map(frames.map((f) => [f.name, f]));
  const entries = ctx.sessionEntries || src.recon.cams.map((c) => byName.get(src.frames[c.imgIdx].name)).filter(Boolean);
  const iter = src.trainer.iter;
  const ses = createSession({ ...src.opts, maxIters: iter, evalSplit: 0, holdout: -1, maskTraining: false });
  await ses.load(entries);
  const byName2 = new Map(ses.frames.map((f, i) => [f.name, i]));
  const cams = [];
  for (const c of src.recon.cams) {
    const i = byName2.get(src.frames[c.imgIdx].name); if (i == null) continue;
    const s = ses.frames[i].fw / src.frames[c.imgIdx].fw;
    cams.push({ ...c, imgIdx: i, f: c.f * s, ...(c.fy != null ? { fy: c.fy * s } : {}), cx: c.cx * s, cy: c.cy * s });
  }
  ses.useReconstruction({ ...src.recon, cams, points: src.recon.points });
  await ses.seedFrom({ data: data2, n: kept, sh: sh2, shK, dc: raw.dc }, { iter });
  hooks.progress?.(4, 4, 'isolated');
  ctx.session = ses; ctx.cutSession = ses; ctx.plyBlob = null; ctx.sogBlob = null;
  return { splats: kept, of: n, hull: { dim: hull.dim, cell: hull.cell, fill: hull.fill }, note: `${kept.toLocaleString()} of ${n.toLocaleString()} splats` };
}
