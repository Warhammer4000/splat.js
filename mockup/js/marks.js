// marks.js — landmark and match overlays, drawn from where the picture actually
// has texture. Shared by both mockup versions.

const cache = new Map();

/** the N most distinctive spots in an image, as normalised coordinates */
export function keypoints(img, key, n = 320) {
  const ck = `${key}:${n}`;
  if (cache.has(ck)) return cache.get(ck);
  const gw = 72, gh = Math.max(2, Math.round(gw * img.height / img.width));
  const c = document.createElement('canvas');
  c.width = gw; c.height = gh;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, gw, gh);
  const d = x.getImageData(0, 0, gw, gh).data;
  const lum = (i) => (d[i * 4] * .3 + d[i * 4 + 1] * .6 + d[i * 4 + 2] * .1);
  const cells = [];
  for (let y = 1; y < gh - 1; y++) for (let xx = 1; xx < gw - 1; xx++) {
    const i = y * gw + xx;
    const gx = lum(i + 1) - lum(i - 1), gy = lum(i + gw) - lum(i - gw);
    cells.push({ x: xx / gw, y: y / gh, m: Math.hypot(gx, gy), a: Math.atan2(gy, gx) });
  }
  cells.sort((a, b) => b.m - a.m);
  const out = cells.slice(0, n).map((c2, i) => ({
    x: c2.x + ((i * 37) % 11 / 11 - .5) / gw,
    y: c2.y + ((i * 53) % 7 / 7 - .5) / gh,
    r: 2.2 + Math.min(6, c2.m / 22),
    a: c2.a,
  }));
  cache.set(ck, out);
  return out;
}

/** @param reveal 0..1 — how much of the detection pass has run */
export function drawMarks(ctx, img, r, key, reveal = 1) {
  const kp = keypoints(img, key);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(47,212,193,.75)';
  kp.forEach((p, i) => {
    if (i / kp.length > reveal) return;
    const x = r.x + p.x * r.w, y = r.y + p.y * r.h;
    ctx.beginPath(); ctx.arc(x, y, p.r, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(p.a) * p.r, y + Math.sin(p.a) * p.r);
    ctx.stroke();
  });
  return kp.length;
}

/** matches between two neighbouring frames: a smooth shift, plus a few rejects */
export function drawMatches(ctx, img, r1, r2, key, reveal = 1) {
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const kp = keypoints(img, key).filter((_, n) => n % 3 === 0).slice(0, 26);
  ctx.lineWidth = 1;
  let ok = 0;
  kp.forEach((p, n) => {
    if (n / kp.length > reveal) return;
    const x1 = r1.x + p.x * r1.w, y1 = r1.y + p.y * r1.h;
    const bad = n % 11 === 4;
    if (!bad) ok++;
    const dx = bad ? (((n * 61) % 100) / 100 - .5) * .7 : .035 + Math.sin(p.y * 3) * .012;
    const dy = bad ? (((n * 37) % 100) / 100 - .5) * .5 : Math.sin(p.x * 4) * .008;
    const x2 = r2.x + clamp(p.x - dx) * r2.w, y2 = r2.y + clamp(p.y + dy) * r2.h;
    ctx.strokeStyle = bad ? 'rgba(226,102,79,.85)' : 'rgba(242,160,63,.55)';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.fillStyle = bad ? 'rgba(226,102,79,.9)' : 'rgba(242,160,63,.9)';
    ctx.beginPath(); ctx.arc(x1, y1, 2, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(x2, y2, 2, 0, 7); ctx.fill();
  });
  return ok;
}
