// viewport.js — the 3D stage, and the only renderer in the app.
//
// A painter's-algorithm splat renderer on a 2D canvas: project, bucket-sort by
// depth, composite soft sprites back to front. It draws the same picture whether
// the camera sits on a photograph's pose or floats free, which is what lets a
// photograph be laid over it and wiped away again.
//
// Quality is a function of training progress, the way the real model's is:
// capacity grows, positions settle, colours resolve, splats shrink and firm up.

const SPRITE = 34;
const LEVELS = 5;               // per channel -> 125 pre-tinted sprites

const DRAW_MOVING = 18000;      // while the camera moves, keep it interactive
const DRAW_SETTLED = 46000;     // once it stops, one full-quality pass

/** world position of a camera from its world-to-camera pose */
const camCentre = ({ R, t }) => [
  -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
  -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
  -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
];

function buildSprites() {
  const out = [];
  for (let r = 0; r < LEVELS; r++) for (let g = 0; g < LEVELS; g++) for (let b = 0; b < LEVELS; b++) {
    const c = document.createElement('canvas');
    c.width = c.height = SPRITE;
    const x = c.getContext('2d');
    const gr = x.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
    const col = `${Math.round(r * 255 / (LEVELS - 1))},${Math.round(g * 255 / (LEVELS - 1))},${Math.round(b * 255 / (LEVELS - 1))}`;
    gr.addColorStop(0, `rgba(${col},1)`);
    gr.addColorStop(.45, `rgba(${col},.62)`);
    gr.addColorStop(1, `rgba(${col},0)`);
    x.fillStyle = gr;
    x.fillRect(0, 0, SPRITE, SPRITE);
    out.push(c);
  }
  return out;
}

export class Viewport {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.sprites = null;
    this.scene = null;
    this.lock = null;
    this.yaw = 0.6; this.pitch = 0.22; this.dist = 8; this.target = [0, 0, 0];
    this.dirty = true;
    this.w = 1; this.h = 1;
    this.enabled = true;
    this.freeF = null;            // focal carried over when leaving a frame pose
    this.onLeave = null;          // called when a drag pulls off a frame pose
    this._cloud = document.createElement('canvas');
    this._bind();
  }

  // ── input ────────────────────────────────────────────────────────────────
  _bind() {
    const cv = this.cv;
    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      // dragging off a frame is not a mode change, it is just movement
      if (this.lock) this.onLeave?.();
      drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 || e.button === 1 };
      try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic events have no capture */ }
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) {
        const s = this.dist * 0.0016;
        const c = Math.cos(this.yaw), n = Math.sin(this.yaw);
        this.target[0] -= (dx * c) * s;
        this.target[2] -= (dx * n) * s;
        this.target[1] += dy * s;
      } else {
        this.yaw -= dx * 0.006;
        this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - dy * 0.005));
      }
      this.dirty = true;
    });
    const end = () => { drag = null; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('wheel', (e) => {
      if (!this.enabled || this.lock) return;   // on a frame the wheel sizes the loupe
      e.preventDefault();
      this.dist = Math.max(0.4, Math.min(200, this.dist * Math.exp(e.deltaY * 0.0011)));
      this.dirty = true;
    }, { passive: false });
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (w !== this.cv.width || h !== this.cv.height) { this.cv.width = w; this.cv.height = h; }
    this.w = w; this.h = h; this.dpr = dpr;
    this.dirty = true;
  }

  setScene(scene) {
    this.scene = scene;
    this.n = scene.xyz.length / 3;
    this._cloudKey = null;
    this.frameScene();
  }

  frameScene() {
    if (!this.scene) return;
    this.target = [...this.scene.center];
    this.dist = this.scene.radius * 2.5;
    this.yaw = 0.7; this.pitch = -0.32;   // a little above the scene, looking down
    this.dirty = true;
  }

  /** orbit around a training camera's position without snapping to its pose */
  syncTo(cam) {
    const C = camCentre(cam);
    const fwd = [cam.R[6], cam.R[7], cam.R[8]];
    const d = this.scene.radius * 0.9;
    this.target = [C[0] + fwd[0] * d, C[1] + fwd[1] * d, C[2] + fwd[2] * d];
    this.dist = d;
    this.yaw = Math.atan2(-fwd[0], -fwd[2]);
    this.pitch = Math.asin(Math.max(-1, Math.min(1, fwd[1])));
    this.dirty = true;
  }

  /** current free-orbit pose in the same shape as a training camera */
  freePose() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const fwd = [-sy * cp, sp, -cy * cp];               // camera looks along +z_cam
    const pos = [
      this.target[0] - fwd[0] * this.dist,
      this.target[1] - fwd[1] * this.dist,
      this.target[2] - fwd[2] * this.dist,
    ];
    const right = [cy, 0, -sy];
    const down = [
      fwd[1] * right[2] - fwd[2] * right[1],
      fwd[2] * right[0] - fwd[0] * right[2],
      fwd[0] * right[1] - fwd[1] * right[0],
    ];
    const R = [right[0], right[1], right[2], down[0], down[1], down[2], fwd[0], fwd[1], fwd[2]];
    const t = [
      -(R[0] * pos[0] + R[1] * pos[1] + R[2] * pos[2]),
      -(R[3] * pos[0] + R[4] * pos[1] + R[5] * pos[2]),
      -(R[6] * pos[0] + R[7] * pos[1] + R[8] * pos[2]),
    ];
    return {
      R, t, cx: this.w / 2, cy: this.h / 2,
      f: this.freeF || Math.min(this.w, this.h) * 0.86,
    };
  }

  viewPose() {
    if (!this.lock) return this.freePose();
    const c = this.lock;
    const s = Math.min(this.w / c.w, this.h / c.h);
    return {
      R: c.R, t: c.t, f: c.f * s,
      cx: this.w / 2 + (c.cx - c.w / 2) * s,
      cy: this.h / 2 + (c.cy - c.h / 2) * s,
    };
  }

  // ── drawing ──────────────────────────────────────────────────────────────

  /**
   * @param {object} o
   *   mode      'points' (the sparse solve) | 'splats' (the model)
   *   progress  0..1 training progress: capacity, sharpness, colour, opacity
   *   cams      camera list to draw (or null)
   *   reveal    draw only the first N cameras (registration animation)
   *   active    index of the camera being trained on right now
   *   sel       index of the selected camera
   *   skip      index whose frustum to omit (the one being looked through)
   *   faint     draw the frustums as context rather than as subject
   */
  draw(o = {}) {
    const { ctx, w, h } = this;
    if (!this.scene) { ctx.fillStyle = '#070909'; ctx.fillRect(0, 0, w, h); return; }

    const P = this.viewPose();
    if ((o.mode || 'points') === 'points') this._points(P);
    else this._splats(P, o.progress ?? 0);

    if (o.showCams && o.cams) this._drawCams(o, P);
    this.dirty = false;
  }

  /** the sparse solve: one dot per triangulated landmark, no model yet */
  _points(P) {
    const { ctx, w, h } = this;
    ctx.fillStyle = '#070909';
    ctx.fillRect(0, 0, w, h);
    const { xyz, rgb } = this.scene;
    const { R, t, f, cx, cy } = P;
    const s = Math.max(1, 1.35 * (this.dpr || 1));
    const step = Math.max(1, Math.floor(this.n / 22000));
    for (let i = 0; i < this.n; i += step) {
      const o3 = i * 3;
      const X = xyz[o3], Y = xyz[o3 + 1], Z = xyz[o3 + 2];
      const zc = R[6] * X + R[7] * Y + R[8] * Z + t[2];
      if (zc <= 0.05) continue;
      const px = f * (R[0] * X + R[1] * Y + R[2] * Z + t[0]) / zc + cx;
      const py = f * (R[3] * X + R[4] * Y + R[5] * Z + t[1]) / zc + cy;
      if (px < 0 || py < 0 || px > w || py > h) continue;
      ctx.fillStyle = `rgb(${rgb[o3]},${rgb[o3 + 1]},${rgb[o3 + 2]})`;
      ctx.fillRect(px - s / 2, py - s / 2, s, s);
    }
  }

  /**
   * The model. Re-rasterised only when the camera or the training state moves,
   * and at reduced capacity while the camera is actually moving — the same
   * progressive trick every splat viewer uses.
   */
  _splats(P, prog) {
    const key = this._key(P, prog);
    const now = performance.now();
    if (key !== this._lastKey) { this._lastKey = key; this._keyAt = now; this._hiDone = false; }
    const settled = now - this._keyAt > 150;

    if (key !== this._cloudKey || (settled && !this._hiDone)) {
      this._raster(P, prog, settled ? DRAW_SETTLED : DRAW_MOVING);
      this._cloudKey = key;
      if (settled) this._hiDone = true;
    }
    this.ctx.drawImage(this._cloud, 0, 0);
  }

  _key(P, prog) {
    const q = (v) => Math.round(v * 800);
    return `${q(P.f)},${q(P.cx)},${q(P.cy)},${P.R.map(q)},${P.t.map(q)}` +
           `|${Math.round(prog * 90)}|${this.w}x${this.h}`;
  }

  _raster(P, prog, budget) {
    if (!this.sprites) this.sprites = buildSprites();
    const w = this.w, h = this.h;
    if (this._cloud.width !== w || this._cloud.height !== h) {
      this._cloud.width = w; this._cloud.height = h;
    }
    const ctx = this._cloud.getContext('2d');
    ctx.fillStyle = '#070909';
    ctx.fillRect(0, 0, w, h);

    const S = this.scene;
    const xyz = S.sxyz, rgb = S.srgb, jit = S.sjit, N = S.sn;
    const { R, t, f, cx, cy } = P;

    // capacity grows the way the optimiser grows it; what gets drawn is a stride
    // through the set, so growth reads as the scene filling in
    const grown = 0.28 + 0.72 * Math.min(1, prog / .62);
    const step = Math.max(1, Math.ceil(N / Math.min(N * grown, budget)));
    const count = Math.ceil(N / step);

    if (!this._depth || this._depth.length < count) {
      this._depth = new Float32Array(count);
      this._sx = new Float32Array(count);
      this._sy = new Float32Array(count);
      this._sr = new Float32Array(count);
      this._sq = new Uint16Array(count);
      this._bucket = new Uint16Array(count);
      this._order = new Uint32Array(count);
    }
    const depth = this._depth, sx = this._sx, sy = this._sy, sr = this._sr, sq = this._sq;

    // early: fat, translucent, mislocated, washed out. late: small, firm, exact.
    const wobble = S.radius * .05 * (1 - prog) * (1 - prog);
    const rw = S.radius * (0.016 * (1 - prog) + 0.0075);
    const alpha = 0.34 + 0.5 * prog;
    const wash = (1 - prog) * 0.7;               // colour has not resolved yet
    const cull = prog > .45;                     // dead splats get recycled away
    const minR = 1.1 * (this.dpr || 1);
    const L = LEVELS - 1;

    let vis = 0, zmin = 1e30, zmax = -1e30;
    for (let i = 0; i < N; i += step) {
      const o3 = i * 3;
      const jx = jit[o3], jy = jit[o3 + 1], jz = jit[o3 + 2];
      if (cull && jx * jx + jy * jy + jz * jz > 2.2) continue;   // a floater, relocated
      const X = xyz[o3] + jx * wobble, Y = xyz[o3 + 1] + jy * wobble, Z = xyz[o3 + 2] + jz * wobble;
      const zc = R[6] * X + R[7] * Y + R[8] * Z + t[2];
      if (zc <= 0.05) continue;
      const px = f * (R[0] * X + R[1] * Y + R[2] * Z + t[0]) / zc + cx;
      const py = f * (R[3] * X + R[4] * Y + R[5] * Z + t[1]) / zc + cy;
      const rad = Math.max(minR, rw * f / zc);
      if (px < -rad || py < -rad || px > w + rad || py > h + rad) continue;

      const r0 = rgb[o3], g0 = rgb[o3 + 1], b0 = rgb[o3 + 2];
      const lum = (r0 * 77 + g0 * 150 + b0 * 29) >> 8;
      const cr = r0 + (lum - r0) * wash, cg = g0 + (lum - g0) * wash, cb = b0 + (lum - b0) * wash;
      sq[vis] = (Math.min(L, cr * LEVELS >> 8) * LEVELS + Math.min(L, cg * LEVELS >> 8)) * LEVELS
              + Math.min(L, cb * LEVELS >> 8);
      depth[vis] = zc; sx[vis] = px; sy[vis] = py; sr[vis] = rad;
      if (zc < zmin) zmin = zc;
      if (zc > zmax) zmax = zc;
      vis++;
    }
    if (!vis) return;

    // bucket sort, back to front — a comparison sort of 40k entries would cost
    // more than the rasterisation itself
    const NB = 1024;
    if (!this._cnt) this._cnt = new Uint32Array(NB + 1);
    const cnt = this._cnt, bucket = this._bucket, order = this._order;
    cnt.fill(0);
    const span = Math.max(1e-6, zmax - zmin);
    for (let k = 0; k < vis; k++) {
      const b = NB - 1 - Math.min(NB - 1, ((depth[k] - zmin) / span * (NB - 1)) | 0);
      bucket[k] = b; cnt[b + 1]++;
    }
    for (let b = 0; b < NB; b++) cnt[b + 1] += cnt[b];
    for (let k = 0; k < vis; k++) order[cnt[bucket[k]]++] = k;

    const sp = this.sprites;
    ctx.globalAlpha = alpha;
    for (let n = 0; n < vis; n++) {
      const k = order[n], rad = sr[k];
      ctx.drawImage(sp[sq[k]], sx[k] - rad, sy[k] - rad, rad * 2, rad * 2);
    }
    ctx.globalAlpha = 1;
  }

  _project(P, X, Y, Z) {
    const { R, t, f, cx, cy } = P;
    const zc = R[6] * X + R[7] * Y + R[8] * Z + t[2];
    if (zc <= 0.02) return null;
    return [
      f * (R[0] * X + R[1] * Y + R[2] * Z + t[0]) / zc + cx,
      f * (R[3] * X + R[4] * Y + R[5] * Z + t[1]) / zc + cy,
    ];
  }

  _drawCams(o, P) {
    const ctx = this.ctx, dpr = this.dpr || 1;
    // faint: these are context, not subject
    if (o.faint) ctx.globalAlpha = 0.4;
    const s = this.scene.radius * 0.075;
    const list = o.cams;
    const upto = o.reveal ?? list.length;
    const path = [];

    // dense video sets would draw 100+ overlapping pyramids; thin them out and
    // let the dashed path carry the shape of the walk instead
    const stride = Math.max(1, Math.ceil(list.length / 30));

    for (let i = 0; i < list.length && i < upto; i++) {
      const c = list[i];
      if (!c.R || c.state === 'unplaced' || i === o.skip) continue;
      const keep = i % stride === 0 || i === o.active || i === o.sel || c.state === 'holdout';
      if (!keep) { const p = this._project(P, ...camCentre(c)); if (p) path.push(p); continue; }

      const R = c.R;
      const C = camCentre(c);
      const pc = this._project(P, C[0], C[1], C[2]);
      if (pc) path.push(pc);

      const isActive = i === o.active, isSel = i === o.sel;
      let col = 'rgba(147,161,160,.42)', lw = 1 * dpr;
      if (c.state === 'holdout') col = 'rgba(242,160,63,.75)';
      if (isSel) { col = 'rgba(230,236,235,.95)'; lw = 1.4 * dpr; }
      if (isActive) { col = 'rgba(47,212,193,1)'; lw = 1.8 * dpr; }
      if (!isActive && !isSel && o.dimOthers) col = 'rgba(147,161,160,.2)';

      // frustum corners at distance s
      const k = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([ax, ay]) => {
        const dx = (ax * c.w / 2 - c.cx) / c.f * s, dy = (ay * c.h / 2 - c.cy) / c.f * s, dz = s;
        return this._project(P,
          C[0] + R[0] * dx + R[3] * dy + R[6] * dz,
          C[1] + R[1] * dx + R[4] * dy + R[7] * dz,
          C[2] + R[2] * dx + R[5] * dy + R[8] * dz);
      });
      if (!pc || k.some((p) => !p)) continue;

      if (isActive) {
        ctx.fillStyle = 'rgba(47,212,193,.13)';
        ctx.beginPath();
        ctx.moveTo(k[0][0], k[0][1]);
        for (let j = 1; j < 4; j++) ctx.lineTo(k[j][0], k[j][1]);
        ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = col; ctx.lineWidth = lw;
      ctx.beginPath();
      for (let j = 0; j < 4; j++) {
        ctx.moveTo(pc[0], pc[1]); ctx.lineTo(k[j][0], k[j][1]);
        ctx.moveTo(k[j][0], k[j][1]); ctx.lineTo(k[(j + 1) % 4][0], k[(j + 1) % 4][1]);
      }
      ctx.stroke();
    }

    if (o.showPath && path.length > 1) {
      ctx.strokeStyle = 'rgba(47,212,193,.22)';
      ctx.lineWidth = 1 * dpr;
      ctx.setLineDash([3 * dpr, 4 * dpr]);
      ctx.beginPath();
      path.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }
}
