// scene.js — assembles the thing the mockup shows: frame list, camera poses,
// a sparse point cloud, and the per-frame numbers the UI browses.
//
// MOCKUP NOTE: where a scene has poses and a cloud sitting on disk we use them,
// purely so the 3D stage lines up with the actual photographs. Nothing in the UI
// offers to import poses — v1 is photos in, splat out, all in the browser.

// resolved from this module, so every mockup version reaches the same data dir
// no matter how deep its own page sits
export const DATA = new URL('../../data/', import.meta.url).href;

const rng = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** world-to-camera rotation for a camera at `pos` looking at `at` (OpenCV axes) */
function lookAt(pos, at) {
  const z = norm(sub(at, pos));
  const r = norm(cross(z, [0, 1, 0]));
  const d = cross(z, r);
  const R = [r[0], r[1], r[2], d[0], d[1], d[2], z[0], z[1], z[2]];
  const t = [
    -(R[0] * pos[0] + R[1] * pos[1] + R[2] * pos[2]),
    -(R[3] * pos[0] + R[4] * pos[1] + R[5] * pos[2]),
    -(R[6] * pos[0] + R[7] * pos[1] + R[8] * pos[2]),
  ];
  return { R, t };
}

export function camPosition({ R, t }) {
  return [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
}

function frameNames(p) {
  const out = [];
  for (let i = 0; i < p.count; i++) {
    const n = p.start + i;
    out.push(p.pattern.replace(/\{i:(\d+)\}/, (_, w) => String(n).padStart(+w, '0')));
  }
  return out;
}

async function json(url) {
  const txt = await (await fetch(url)).text();
  return JSON.parse(txt.replace(/^﻿/, ''));
}

/** Procedural stand-in cloud + path for scenes with nothing staged on disk. */
function simulate(preset) {
  const R0 = rng(preset.id.length * 7717 + preset.count);
  const W = preset.imgW || 1280, H = preset.imgH || 800;
  const F = 0.85 * Math.max(W, H);
  const N = Math.min(14000, Math.max(4000, preset.stats.points));
  // a point on the surface of a box — landmarks sit on surfaces, never inside them
  const onBox = (c, s) => {
    const f = (R0() * 6) | 0, u = R0() - .5, v = R0() - .5;
    const p = [u, v, u];
    const ax = f >> 1, sg = (f & 1) ? .5 : -.5;
    const out = [c[0] + p[0] * s[0], c[1] + p[1] * s[1], c[2] + p[2] * s[2]];
    out[ax] = c[ax] + sg * s[ax];
    if (ax !== 0) out[0] = c[0] + (R0() - .5) * s[0];
    if (ax !== 1) out[1] = c[1] + (R0() - .5) * s[1];
    if (ax !== 2) out[2] = c[2] + (R0() - .5) * s[2];
    return out;
  };
  const xyz = new Float32Array(N * 3);
  const rgb = new Uint8Array(N * 3);
  const palette = {
    walk:   [[92, 104, 66], [128, 116, 86], [64, 60, 52], [150, 148, 140]],
    arc:    [[168, 150, 128], [120, 110, 104], [190, 176, 150], [86, 80, 74]],
    sphere: [[96, 116, 62], [140, 126, 88], [72, 84, 54], [168, 164, 152]],
  }[preset.simPath] || [[140, 130, 120]];

  for (let i = 0; i < N; i++) {
    let x, y, z;
    if (preset.simPath === 'walk') {          // ground, a wall, and a few objects
      const u = R0(), s = (R0() - .5) * 12;
      if (u < .5) { x = (R0() - .5) * 7; y = -1.4 + R0() * .05; z = s; }
      else if (u < .72) { x = 3.3 + (R0() - .5) * .08; y = -1.4 + R0() * 2.4; z = s; }
      else if (u < .8) { x = (R0() - .5) * 7; y = -1.4 + R0() * 2.4; z = 6 - R0() * .08; }
      else {
        const boxes = [[[-1.6, -.85, -2.2], [1.5, 1.1, 1.4]], [[1.1, -1, 1.6], [1.2, .8, 2.2]],
                       [[-2.2, -.6, 2.8], [1.1, 1.6, 1.1]]];
        const b = boxes[(R0() * 3) | 0];
        [x, y, z] = onBox(b[0], b[1]);
      }
    } else if (preset.simPath === 'arc') {    // room corner
      const u = R0();
      if (u < .35) { x = (R0() - .5) * 5; y = -1.2 + R0() * .1; z = (R0() - .5) * 5; }
      else if (u < .7) { x = -2.4 + R0() * .1; y = -1.2 + R0() * 2.6; z = (R0() - .5) * 5; }
      else { x = (R0() - .5) * 5; y = -1.2 + R0() * 2.6; z = -2.4 + R0() * .1; }
    } else {                                   // outdoor: ground disc + a mound
      const a = R0() * Math.PI * 2, r = Math.sqrt(R0()) * 7;
      x = Math.cos(a) * r; z = Math.sin(a) * r;
      y = -1.3 + Math.exp(-(r * r) / 6) * (1.4 + R0() * .5) + R0() * .16;
    }
    xyz[i * 3] = x; xyz[i * 3 + 1] = y; xyz[i * 3 + 2] = z;
    const c = palette[(R0() * palette.length) | 0];
    const j = .8 + R0() * .5;
    rgb[i * 3] = Math.min(255, c[0] * j);
    rgb[i * 3 + 1] = Math.min(255, c[1] * j);
    rgb[i * 3 + 2] = Math.min(255, c[2] * j);
  }

  const poses = [];
  for (let i = 0; i < preset.count; i++) {
    const u = i / Math.max(1, preset.count - 1);
    let pos, at;
    if (preset.simPath === 'walk') {
      pos = [(R0() - .5) * .2, -.1 + (R0() - .5) * .06, -5.5 + u * 11];
      at = [1.2 + (R0() - .5) * .4, -.5, pos[2] + 2.2];
    } else if (preset.simPath === 'arc') {
      const a = -2.1 + u * 1.9;
      pos = [Math.cos(a) * 3.4, .35 + Math.sin(u * 6) * .12, Math.sin(a) * 3.4];
      at = [-.6, -.5, -.6];
    } else {
      const a = u * Math.PI * 1.7;
      pos = [Math.cos(a) * 6.2, .9 + Math.sin(u * 4) * .5, Math.sin(a) * 6.2];
      at = [0, -.6, 0];
    }
    poses.push({ ...lookAt(pos, at), f: F, cx: W / 2, cy: H / 2, w: W, h: H });
  }
  return { xyz, rgb, poses };
}

/**
 * @returns {Promise<{frames, cams, xyz, rgb, center, radius, holdout}>}
 */
export async function loadScene(preset) {
  // a set is either staged under /data, or a handful of files the visitor just
  // dropped in — from here on the two are the same thing
  const names = preset.own ? preset.own.map((f) => f.name)
    : preset.files ? (await json(`${DATA}${preset.dir}/${preset.files}`)).slice(0, preset.count)
    : frameNames(preset);
  const urlOf = (name, i) => (preset.own ? preset.own[i].url : `${DATA}${preset.dir}/${name}`);

  let xyz, rgb, poses;   // reassigned when the far background is trimmed

  if (preset.mockPoses === 'file') {
    const [cam, pts] = await Promise.all([
      json(`${DATA}${preset.dir}/gt_cameras.json`),
      json(`${DATA}${preset.dir}/gt_points.json`),
    ]);
    const step = Math.max(1, Math.floor(pts.length / 26000));
    const kept = pts.filter((_, i) => i % step === 0);
    xyz = new Float32Array(kept.length * 3);
    rgb = new Uint8Array(kept.length * 3);
    kept.forEach((p, i) => {
      xyz[i * 3] = p[0]; xyz[i * 3 + 1] = p[1]; xyz[i * 3 + 2] = p[2];
      rgb[i * 3] = p[3]; rgb[i * 3 + 1] = p[4]; rgb[i * 3 + 2] = p[5];
    });
    poses = names.map((n) => {
      const p = cam.poses[n];
      return p && { R: p.R, t: p.t, f: (cam.fx + cam.fy) / 2, cx: cam.cx, cy: cam.cy, w: cam.w, h: cam.h };
    });
  } else {
    ({ xyz, rgb, poses } = simulate(preset));
  }

  // Which way is up? A COLMAP-style world has +Y pointing DOWN, the viewer treats
  // +Y as up, and the scene arrives on its head. The cameras know the answer: the
  // world-space up of each one is minus its second row. If they disagree with the
  // viewer, rotate the whole scene 180° about X — a real rotation, so nothing
  // mirrors, and R·F applied to the poses leaves every projection untouched.
  {
    const placed = poses.filter(Boolean);
    let upY = 0;
    for (const p of placed) upY -= p.R[4];
    if (placed.length && upY < 0) {
      for (let i = 0; i < xyz.length; i += 3) { xyz[i + 1] = -xyz[i + 1]; xyz[i + 2] = -xyz[i + 2]; }
      for (const p of placed) {
        const R = p.R;
        R[1] = -R[1]; R[4] = -R[4]; R[7] = -R[7];   // negate the y column
        R[2] = -R[2]; R[5] = -R[5]; R[8] = -R[8];   // negate the z column
      }
    }
  }

  // Extent comes from where the photographer stood, not from the point cloud:
  // outdoor sets carry background points hundreds of metres away that would
  // otherwise frame the whole view around empty sky.
  const centres = poses.filter(Boolean).map(camPosition);
  let center, radius;
  if (centres.length >= 2) {
    center = [0, 1, 2].map((k) => centres.reduce((s, c) => s + c[k], 0) / centres.length);
    const d = centres.map((c) => Math.hypot(c[0] - center[0], c[1] - center[1], c[2] - center[2]));
    radius = Math.max(0.4, Math.max(...d));
  } else {
    const cx = [], cy = [], cz = [];
    for (let i = 0; i < xyz.length; i += 3) { cx.push(xyz[i]); cy.push(xyz[i + 1]); cz.push(xyz[i + 2]); }
    const med = (a) => { a.sort((p, q2) => p - q2); return a[a.length >> 1]; };
    center = [med(cx), med(cy), med(cz)];
    radius = 4;
  }

  // drop the far background so the cloud reads as the scene that was captured
  {
    const lim = (radius * 2.4) ** 2;
    const kx = new Float32Array(xyz.length), kc = new Uint8Array(rgb.length);
    let n = 0;
    for (let i = 0; i < xyz.length; i += 3) {
      const dx = xyz[i] - center[0], dy = xyz[i + 1] - center[1], dz = xyz[i + 2] - center[2];
      if (dx * dx + dy * dy + dz * dz > lim) continue;
      kx[n] = xyz[i]; kx[n + 1] = xyz[i + 1]; kx[n + 2] = xyz[i + 2];
      kc[n] = rgb[i]; kc[n + 1] = rgb[i + 1]; kc[n + 2] = rgb[i + 2];
      n += 3;
    }
    if (n > 600) { xyz = kx.subarray(0, n); rgb = kc.subarray(0, n); }
  }

  // and then aim at what was photographed, not at the middle of the camera arc
  {
    const cx = [], cy = [], cz = [];
    for (let i = 0; i < xyz.length; i += 3) { cx.push(xyz[i]); cy.push(xyz[i + 1]); cz.push(xyz[i + 2]); }
    const med = (a) => { a.sort((p, q2) => p - q2); return a[a.length >> 1]; };
    if (cx.length > 200) center = [med(cx), med(cy), med(cz)];
  }

  // Seed the model the way the trainer does: one splat per landmark plus a few
  // jittered clones, so surfaces have something to be built out of. Each splat
  // also carries a random direction — the displacement it starts training with
  // and walks off as the optimiser settles it.
  const splats = (() => {
    const n0 = xyz.length / 3;
    const clones = Math.max(1, Math.min(5, Math.round(90000 / Math.max(1, n0))));
    const n = n0 * clones;
    const sxyz = new Float32Array(n * 3);
    const srgb = new Uint8Array(n * 3);
    const sjit = new Float32Array(n * 3);
    const spread = radius * 0.011;
    const R2 = rng(4177 + n0);
    let o = 0;
    for (let i = 0; i < n0; i++) {
      const i3 = i * 3;
      for (let c = 0; c < clones; c++) {
        const d = c === 0 ? 0 : spread;              // the original sits put
        sxyz[o] = xyz[i3] + (R2() - .5) * d;
        sxyz[o + 1] = xyz[i3 + 1] + (R2() - .5) * d;
        sxyz[o + 2] = xyz[i3 + 2] + (R2() - .5) * d;
        srgb[o] = rgb[i3]; srgb[o + 1] = rgb[i3 + 1]; srgb[o + 2] = rgb[i3 + 2];
        sjit[o] = (R2() - .5) * 2;
        sjit[o + 1] = (R2() - .5) * 2;
        sjit[o + 2] = (R2() - .5) * 2;
        o += 3;
      }
    }
    return { sxyz, srgb, sjit, sn: n };
  })();

  // per-frame numbers the inspector browses
  const R1 = rng(9973 + preset.count);
  const placedCount = preset.stats.cams;
  const cams = names.map((name, i) => {
    const pose = poses[i];
    const placed = !!pose && i < placedCount;
    const sharp = .45 + R1() * .55;
    return {
      i, name, url: urlOf(name, i),
      ...(pose || { R: null, t: null, f: 900, cx: 640, cy: 400, w: preset.imgW || 1280, h: preset.imgH || 800 }),
      state: !placed ? 'unplaced' : (sharp < .5 ? 'blurry' : 'placed'),
      feats: Math.round(1400 + R1() * 900),
      matched: Math.round(380 + R1() * 520),
      err: +(preset.stats.rms * (.7 + R1() * .7)).toFixed(2),
      sharp: +sharp.toFixed(2),
      psnr: 0,
    };
  });

  // one frame is held out of training entirely — the honest score comes from it
  const holdout = cams.findIndex((c, i) => c.state === 'placed' && i > placedCount * .45);
  if (holdout >= 0) cams[holdout].state = 'holdout';

  return { preset, frames: names, cams, xyz, rgb, ...splats, center, radius, holdout };
}
