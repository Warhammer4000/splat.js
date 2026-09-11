// hull.js — a visual hull carved from the subject masks, used as a hard
// "nothing may exist here" volume during refinement.
//
// Why a volume and not a loss: supervising rendered opacity (shaders.js covW)
// only governs what GROWS. It cannot remove a Gaussian that has already
// saturated, because dalpha/d(logit opacity) = o(1-o)(...) vanishes as o -> 1
// — a converged opaque splat sits in the sigmoid's dead zone and no opacity
// gradient reaches it again. Density control is the other half of every masked
// -3DGS recipe, and this is the cheapest correct form of it: carve the space
// the silhouettes agree is empty, then let refine() treat anything inside that
// space as dead capacity and relocate it onto the subject.
//
// Carving is conservative on purpose. A voxel only loses a vote from a view
// that sees it AND calls it KNOWN-empty (the TGT_EMPTY sentinel); the matte's
// soft edge votes neither way, and a voxel outside a view's frame is not
// evidence of anything.

/**
 * @param {object} recon   solved reconstruction (cams + subject points)
 * @param {Array} frames   decoded frames; rgb carries the mask sentinels
 * @param {object} [opts]
 * @param {number} [opts.res=128]     voxels along the longest axis
 * @param {number} [opts.margin=0.15] bbox padding, as a fraction of its size
 * @param {number} [opts.keep=0.85]   min fraction of seeing views that must
 *   NOT call the voxel empty. Below 1 so one bad matte cannot punch a hole.
 * @param {number} [opts.minViews=8]  a voxel seen by fewer views is left alive
 *   (not enough evidence to carve it away)
 * @param {number} [opts.kMad=4]      half-extent of the carving box, in median
 *   absolute deviations of the subject cloud
 * @returns {object|null} hull, or null when the frames carry no masks
 */
export function buildVisualHull(recon, frames, opts = {}) {
  const { res = 128, margin = 0.15, keep = 0.85, minViews = 8, kMad = 4 } = opts;
  if (!frames.some((f) => f.emptyFrac > 0)) return null;
  const pts = recon.points;
  if (!pts || pts.length < 8) return null;

  // Bounds from the mask-filtered cloud — but percentiles are NOT robust
  // enough here. A silhouette test cannot remove a point that lies along the
  // viewing ray THROUGH the subject in every view, so the filtered cloud still
  // has a long tail of far stragglers: on the Lisa orbit the 1-99 percentile
  // box came out 20 x 9 x 24 units, and the person was 0.1% of it. Median
  // +/- k*MAD finds the actual body (0.56 x 1.75 x 0.55 there).
  const med = [0, 0, 0], mad = [0, 0, 0];
  const lo = [0, 0, 0], hi = [0, 0, 0];
  const mid = (arr) => { const a = Float64Array.from(arr).sort(); return a[a.length >> 1]; };
  for (let a = 0; a < 3; a++) {
    med[a] = mid(pts.map((p) => p.X[a]));
    mad[a] = mid(pts.map((p) => Math.abs(p.X[a] - med[a]))) || 1e-3;
    const half = kMad * mad[a] * (1 + margin);
    lo[a] = med[a] - half; hi[a] = med[a] + half;
  }
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const cell = span / res;
  const dim = [
    Math.max(1, Math.ceil((hi[0] - lo[0]) / cell)),
    Math.max(1, Math.ceil((hi[1] - lo[1]) / cell)),
    Math.max(1, Math.ceil((hi[2] - lo[2]) / cell)),
  ];
  const nvox = dim[0] * dim[1] * dim[2];
  const alive = new Uint8Array(nvox).fill(1);
  const seen = new Int16Array(nvox);
  const miss = new Int16Array(nvox);
  // Early-out bound. Carving mid-loop on the RATIO is wrong — the counts are
  // partial, so a voxel that draws two empty votes in its first eight views
  // dies even though it would finish at 2/186. (It did: the first build came
  // out 0.1% solid.) This bound is sound instead: once the misses alone exceed
  // what the FULL camera set could ever forgive, no remaining view can save it.
  const killAt = (1 - keep) * recon.cams.length;

  for (const c of recon.cams) {
    const im = frames[c.imgIdx];
    if (!im || !(im.emptyFrac > 0)) continue;
    const sx = im.tw / im.fw, sy = im.th / im.fh;
    const { R, t } = c;
    const fy = c.fy ?? c.f;
    let v = 0;
    for (let iz = 0; iz < dim[2]; iz++) {
      const Z = lo[2] + (iz + 0.5) * cell;
      for (let iy = 0; iy < dim[1]; iy++) {
        const Y = lo[1] + (iy + 0.5) * cell;
        for (let ix = 0; ix < dim[0]; ix++, v++) {
          if (!alive[v]) continue;
          const X = lo[0] + (ix + 0.5) * cell;
          const zc = R[6] * X + R[7] * Y + R[8] * Z + t[2];
          if (zc <= 1e-6) continue;
          const u = (c.f * (R[0] * X + R[1] * Y + R[2] * Z + t[0]) / zc + c.cx) * sx;
          const w = (fy * (R[3] * X + R[4] * Y + R[5] * Z + t[1]) / zc + c.cy) * sy;
          if (u < 0 || w < 0 || u >= im.tw || w >= im.th) continue; // not evidence
          seen[v]++;
          // TGT_EMPTY (-2) is the only carving vote; the soft-edge band (-1)
          // abstains, so a fuzzy matte cannot erode the subject.
          if (im.rgb[((w | 0) * im.tw + (u | 0)) * 3] < -1.5) {
            miss[v]++;
            if (miss[v] > killAt) alive[v] = 0;
          }
        }
      }
    }
  }

  let live = 0;
  for (let i = 0; i < nvox; i++) {
    // a voxel too rarely seen never had enough evidence: leave it alive
    if (alive[i] && seen[i] >= minViews && miss[i] > (1 - keep) * seen[i]) alive[i] = 0;
    if (alive[i]) live++;
  }
  return { lo, cell, dim, alive, nvox, live, fill: live / nvox };
}

/** (x, y, z) -> is this point inside the carved volume? Outside the grid
 *  counts as OUTSIDE: the box was padded around the subject already. */
export function makeHullTest(hull) {
  const { lo, cell, dim, alive } = hull;
  const [dx, dy, dz] = dim;
  return (x, y, z) => {
    const ix = ((x - lo[0]) / cell) | 0;
    if (ix < 0 || ix >= dx) return false;
    const iy = ((y - lo[1]) / cell) | 0;
    if (iy < 0 || iy >= dy) return false;
    const iz = ((z - lo[2]) / cell) | 0;
    if (iz < 0 || iz >= dz) return false;
    return alive[(iz * dy + iy) * dx + ix] === 1;
  };
}

/** (x, y, z, r) -> should this splat be treated as dead capacity?
 *
 *  A point test is not enough: the thing that actually paints a halo is a
 *  splat CENTRED on the subject whose skirt reaches far outside it, and that
 *  passes any centre test. So probe the extent too — six axis samples at r —
 *  and call the splat dead when its centre is outside, or when most of its
 *  body is. Mostly, not entirely: a legitimate surface splat always pokes a
 *  little way out of the hull. */
export function makeSplatTest(hull, opts = {}) {
  const { sigma = 2, maxOut = 4 } = opts;
  const inside = makeHullTest(hull);
  return (x, y, z, rmax) => {
    if (!inside(x, y, z)) return true;
    const r = sigma * rmax;
    if (r < hull.cell) return false;            // smaller than a voxel: centre says it all
    let out = 0;
    if (!inside(x + r, y, z)) out++;
    if (!inside(x - r, y, z)) out++;
    if (!inside(x, y + r, z)) out++;
    if (!inside(x, y - r, z)) out++;
    if (!inside(x, y, z + r)) out++;
    if (!inside(x, y, z - r)) out++;
    return out >= maxOut;
  };
}
