// faceseed.js — a dense, uniform seed on the face for the main run.
//
// The sparse cloud puts a few hundred points on a face; growth has to find the
// rest. We know it is a face: the landmarks stage triangulated its 478 points
// in the scene, and MediaPipe's tessellation joins them into a mesh. Sample
// that mesh uniformly by area, colour each sample from the most frontal crop,
// and hand the samples to the seed next to the sparse cloud — the person
// starts dense where it is judged (the user's experiment, 2026-09-14: the same
// seed trained alone on the face crops gave a clean face in 8k iterations).
const VISION_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';

const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const norm = (v) => Math.hypot(v[0], v[1], v[2]);

/** @returns {Promise<Array<{X:number[], rgb:number[]}>>} seed points in the PLY frame (rgb 0..1) */
export async function faceSeedPoints(session, files, lm, { count = 20000, log = () => {} } = {}) {
  const face = lm && lm.face; const crops = (lm && lm.cropCams) || [];
  if (!face || !face.points || face.points.length < 100 || !crops.length) { log('face seed: no face — skipped'); return []; }
  const byId = new Map(face.ids.map((id, i) => [id, face.points[i]]));
  const vision = await import(/* @vite-ignore */ `${VISION_CDN}/vision_bundle.mjs`);
  const edges = vision.FaceLandmarker.FACE_LANDMARKS_TESSELATION; const adj = new Map();
  for (const e of edges) { if (!adj.has(e.start)) adj.set(e.start, new Set()); if (!adj.has(e.end)) adj.set(e.end, new Set()); adj.get(e.start).add(e.end); adj.get(e.end).add(e.start); }
  const tris = [];
  for (const e of edges) { const a = Math.min(e.start, e.end), b = Math.max(e.start, e.end); for (const c of adj.get(a)) if (c > b && adj.get(b).has(c) && byId.has(a) && byId.has(b) && byId.has(c)) tris.push([a, b, c]); }
  if (!tris.length) return [];
  const areas = tris.map(([a, b, c]) => 0.5 * norm(cross(sub(byId.get(b), byId.get(a)), sub(byId.get(c), byId.get(a)))));
  const total = areas.reduce((s, v) => s + v, 0); const cum = []; let acc = 0; for (const a of areas) { acc += a; cum.push(acc); }
  // colours from the most frontal crop, through its frame's pose at native scale
  const frontal = crops.slice().sort((a, b) => b.facePx - a.facePx)[0];
  const byName = new Map(files.map((f) => [f.name, f]));
  const body = session.recon.cams.find((c) => session.frames[c.imgIdx].name === frontal.name);
  let px = null, nat = 1;
  const file = byName.get(frontal.name);
  if (body && file) {
    const bmp = await createImageBitmap(file.source !== undefined ? file.source : file); nat = bmp.width / session.frames[body.imgIdx].fw;
    const cv = new OffscreenCanvas(frontal.side, frontal.side); const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, frontal.x0, frontal.y0, frontal.side, frontal.side, 0, 0, frontal.side, frontal.side); bmp.close();
    px = g.getImageData(0, 0, frontal.side, frontal.side).data;
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = Math.random() * total; let ti = cum.findIndex((v) => v >= r); if (ti < 0) ti = tris.length - 1;
    const [a, b, c] = tris[ti]; const A = byId.get(a), B = byId.get(b), C = byId.get(c);
    let u = Math.random(), v = Math.random(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const X = [A[0] + u * (B[0] - A[0]) + v * (C[0] - A[0]), A[1] + u * (B[1] - A[1]) + v * (C[1] - A[1]), A[2] + u * (B[2] - A[2]) + v * (C[2] - A[2])];
    let rgb = [0.6, 0.45, 0.4];
    if (px) {
      const R = body.R, t = body.t; const x = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0], y = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1], z = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
      if (z > 0) {
        const uu = Math.round(body.f * nat * x / z + body.cx * nat - frontal.x0), vv = Math.round((body.fy ?? body.f) * nat * y / z + body.cy * nat - frontal.y0);
        if (uu >= 0 && vv >= 0 && uu < frontal.side && vv < frontal.side) { const o = (vv * frontal.side + uu) * 4; rgb = [px[o] / 255, px[o + 1] / 255, px[o + 2] / 255]; }
      }
    }
    out.push({ X, rgb, faceSeed: true });   // flagged: the isolate stage's hull bounds must not see them
  }
  log(`face seed: ${out.length} points on ${tris.length} face triangles (area ${total.toFixed(3)} units²), colours from ${frontal.name}`);
  return out;
}
