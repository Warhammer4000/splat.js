// introcam.js — the space's intro flight, built from the solved camera path.
//
// A cutscene on arrival.space IS a Sequence serialised into a `.path` file and
// hung on the space as an entity (glbUrl = the .path, autoPlay on); the camera
// track lives under the well-known entity id `main-camera`. The benchmark
// scenes have carried such an intro since August — made by hand, once. This
// builds the same artefact from the run's own cameras, on every upload.
//
// Both conventions below were MEASURED against that working intro
// (ugc.arrival.space/splatjs/models/lab360_intro.path, fitted 2026-09-16)
// rather than assumed:
//   position  world = Rz(180) · C. A .sog user model is placed at the origin
//             with rotation z=180 — createUserModel's default for the
//             extension — so the capture frame turns with it. Fitted residual
//             0.13 in a scene of radius 12.9; the next-best candidate
//             transform was 1.12 out, so the flip is not a coincidence.
//   rotation  q = quat(Rz(180) · Rᵀ · diag(1, -1, -1)): the solver's camera
//             looks down +Z with +Y down, PlayCanvas's down -Z with +Y up.
//             Fitted median error 0.20° over the 57 authored keyframes.

import { api, uploadFile } from './arrival.js';
import { camCentre } from './viewport.js';

const FPS = 24;
const KEY_EVERY = 15;   // frames between keys — 0.6 s, the spacing that intro uses
const MAX_KEYS = 60;    // it carries 57; a long capture is resampled down to this

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The nodes the intro flies: co-located rig poses collapsed (a panorama
 *  contributes six orientations at one spot), then the longest unbroken
 *  stretch of the capture — the same rules the viewer's tour follows, so the
 *  space opens with the flight the creator already watched. */
function pathNodes(cams) {
  const reg = (cams || []).filter((c) => c && c.R && c.t);
  if (reg.length < 2) return [];
  const centres = reg.map(camCentre);
  // the median STEP of the capture, and a rig's six views of one spot are not
  // steps: counting those zeros drags the median to nothing and every real
  // stride then reads as a break (112 panoramas fell to a 5-node path)
  const gaps = [];
  for (let i = 1; i < centres.length; i++) {
    const d = dist(centres[i], centres[i - 1]);
    if (d > 1e-9) gaps.push(d);
  }
  gaps.sort((a, b) => a - b);
  const med = gaps[gaps.length >> 1] || 1e-3;

  const keep = [];
  for (let i = 0; i < reg.length; i++) {
    const last = keep[keep.length - 1];
    if (!last || dist(centres[i], camCentre(last)) > 0.15 * med) keep.push(reg[i]);
  }
  if (keep.length < 2) return [];

  const segs = [[keep[0]]];
  for (let i = 1; i < keep.length; i++) {
    if (dist(camCentre(keep[i]), camCentre(keep[i - 1])) > 4 * med) segs.push([]);
    segs[segs.length - 1].push(keep[i]);
  }
  const best = segs.reduce((a, b) => (b.length > a.length ? b : a), segs[0]);
  if (best.length < 2) return [];

  if (best.length <= MAX_KEYS) return best;
  const out = [];
  for (let i = 0; i < MAX_KEYS; i++) out.push(best[Math.round(i * (best.length - 1) / (MAX_KEYS - 1))]);
  return out;
}

/** Rotation matrix (row-major 9) -> quaternion {x,y,z,w}. */
function quatOf(m) {
  const tr = m[0] + m[4] + m[8];
  let s;
  if (tr > 0) {
    s = Math.sqrt(tr + 1) * 2;
    return { x: (m[7] - m[5]) / s, y: (m[2] - m[6]) / s, z: (m[3] - m[1]) / s, w: 0.25 * s };
  }
  if (m[0] > m[4] && m[0] > m[8]) {
    s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    return { x: 0.25 * s, y: (m[1] + m[3]) / s, z: (m[2] + m[6]) / s, w: (m[7] - m[5]) / s };
  }
  if (m[4] > m[8]) {
    s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    return { x: (m[1] + m[3]) / s, y: 0.25 * s, z: (m[5] + m[7]) / s, w: (m[2] - m[6]) / s };
  }
  s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
  return { x: (m[2] + m[6]) / s, y: (m[5] + m[7]) / s, z: 0.25 * s, w: (m[3] - m[1]) / s };
}

/** The camera's world pose in the SPACE, from its pose in the reconstruction. */
function worldPose({ R, t }) {
  const c = camCentre({ R, t });
  // Rz(180) · C — diag(-1, -1, 1)
  const position = { x: -c[0], y: -c[1], z: c[2] };
  // Rz(180) · Rᵀ · diag(1, -1, -1): both outer matrices are diagonal, so the
  // product is the transpose with its rows and columns signed
  const rt = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
  const rowS = [-1, -1, 1], colS = [1, -1, -1];
  const m = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] = rowS[i] * rt[i * 3 + j] * colS[j];
  return { position, rotation: quatOf(m) };
}

const track = (type, keyframes) => ({ type, keyframes });

/** The Sequence an intro cutscene is, or null when the capture has no path to
 *  fly (fewer than two distinct camera positions). */
export function buildIntroSequence(cams) {
  const nodes = pathNodes(cams);
  if (!nodes.length) return null;
  const pos = [], rot = [], scl = [];
  nodes.forEach((cam, i) => {
    const { position, rotation } = worldPose(cam);
    const frameNumber = i * KEY_EVERY;
    pos.push({ id: `keyframe-p${i}`, frameNumber, keyframeData: position });
    rot.push({ id: `keyframe-r${i}`, frameNumber, keyframeData: rotation });
    scl.push({ id: `keyframe-s${i}`, frameNumber, keyframeData: { x: 1, y: 1, z: 1 } });
  });
  return {
    id: 'splatjsintro',
    data: {
      fps: FPS,
      entities: {
        'main-camera': {
          position: track('vec3', pos),
          rotation: track('quat', rot),
          scale: track('vec3', scl),
          fov: track('number', []),
          brightness: track('number', []),
          contrast: track('number', []),
          saturation: track('number', []),
        },
      },
      markers: [],
    },
  };
}

/** Give a freshly created space its intro flight. Best-effort by contract: the
 *  caller's upload is finished and correct without it, so every failure here is
 *  reported and swallowed. Returns { entityId, keys, seconds } or null. */
export async function attachIntroCam(spaceId, cams, { token, slug = 'splat', onStatus = () => {} } = {}) {
  const seq = buildIntroSequence(cams);
  if (!seq) return null;
  const keys = seq.data.entities['main-camera'].position.keyframes.length;
  onStatus('Building the intro flight …');
  const blob = new Blob([JSON.stringify(seq)], { type: 'application/json' });
  const { resourceKey } = await uploadFile(blob, `${slug}_intro.path`, {
    token, contentType: 'application/json', onStatus,
  });
  // the id the platform's own migration uses, so a space never grows two
  const entityId = `user-model-introcam-${spaceId}`;
  await api(`/spaces/${encodeURIComponent(spaceId)}/entities`, token, {
    resource_key: resourceKey,
    entity_id: entityId,
    entity_data: { displayName: 'Intro flight', autoPlay: true, loop: false },
  });
  return { entityId, keys, seconds: +((keys - 1) * KEY_EVERY / FPS).toFixed(1) };
}
