// viewport.js — the 3D stage. A small painter's-algorithm renderer on a 2D canvas:
// enough to show a sparse cloud, a blob field that sharpens, and where every
// photograph was taken. Real poses in, real projection out — so the locked view
// lines up with the photograph it is being compared against.

const SPRITE = 34;
const LEVELS = 5;               // per channel -> 125 pre-tinted blob sprites

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
    this.enabled = true;          // off while the stage shows a locked comparison
    this.onInteract = null;
    this._bind();
  }

  // ── input ────────────────────────────────────────────────────────────────
  _bind() {
    const cv = this.cv;
    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 || e.button === 1 };
      cv.setPointerCapture(e.pointerId);
      if (this.onInteract) this.onInteract();
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
        this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dy * 0.005));
      }
      this.dirty = true;
    });
    const end = () => { drag = null; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.dist = Math.max(0.4, Math.min(200, this.dist * Math.exp(e.deltaY * 0.0011)));
      this.dirty = true;
      if (this.onInteract) this.onInteract();
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
    this.order = null;
    this.frameScene();
  }

  frameScene() {
    if (!this.scene) return;
    this.target = [...this.scene.center];
    this.dist = this.scene.radius * 2.5;
    this.yaw = 0.7; this.pitch = 0.42;
    this.dirty = true;
  }

  /** orbit around a training camera's position without snapping to its pose */
  syncTo(cam) {
    const s = this.scene;
    const R = cam.R, t = cam.t;
    const C = [
      -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
      -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
      -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
    ];
    const fwd = [R[6], R[7], R[8]];
    const d = s.radius * 0.9;
    this.target = [C[0] + fwd[0] * d, C[1] + fwd[1] * d, C[2] + fwd[2] * d];
    this.dist = d;
    this.yaw = Math.atan2(-fwd[0], -fwd[2]);
    this.pitch = Math.asin(Math.max(-1, Math.min(1, -fwd[1])));
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
    return { R, t, f: Math.min(this.w, this.h) * 0.86, cx: this.w / 2, cy: this.h / 2 };
  }

  viewPose() {
    if (!this.lock) return this.freePose();
    const c = this.lock;
    const s = Math.min(this.w / c.w, this.h / c.h);
    return {
      R: c.R, t: c.t, f: c.f * s,
      cx: this.w / 2 + (c.cx - c.w / 2) * s,
      cy: this.h / 2 + (c.cy - c.h / 2) * s,
      letterbox: [c.w * s, c.h * s],
    };
  }

  // ── drawing ──────────────────────────────────────────────────────────────

  /**
   * @param {object} o
   *   mode      'points' | 'blobs'
   *   progress  0..1 training progress (blob size / density / opacity)
   *   cams      camera list to draw (or null)
   *   reveal    draw only the first N cameras (registration animation)
   *   active    index of the camera being trained on right now
   *   sel       index of the selected camera
   *   showCams  bool
   *   showPath  bool
   *   fade      0..1 global fade of the cloud
   */
  draw(o = {}) {
    const { ctx, w, h } = this;
    ctx.fillStyle = '#0a0807';
    ctx.fillRect(0, 0, w, h);
    if (!this.scene) return;

    const P = this.viewPose();
    const { R, t, f, cx, cy } = P;
    const dpr = this.dpr || 1;

    if (P.letterbox) {                       // show the photo's exact frame
      ctx.save();
      ctx.beginPath();
      ctx.rect((w - P.letterbox[0]) / 2, (h - P.letterbox[1]) / 2, P.letterbox[0], P.letterbox[1]);
      ctx.clip();
    }

    const { xyz, rgb } = this.scene;
    const mode = o.mode || 'points';
    const prog = o.progress ?? 0;

    // how many points to draw, and how big
    const budget = mode === 'blobs' ? 16000 : 22000;
    const step = Math.max(1, Math.floor(this.n / budget));
    const count = Math.floor(this.n / step);
    if (!this.depth || this.depth.length !== count) {
      this.depth = new Float32Array(count);
      this.sx = new Float32Array(count);
      this.sy = new Float32Array(count);
      this.idx = new Uint32Array(count);
    }
    const { depth, sx, sy, idx } = this;

    let vis = 0;
    for (let k = 0; k < count; k++) {
      const i = k * step, o3 = i * 3;
      const X = xyz[o3], Y = xyz[o3 + 1], Z = xyz[o3 + 2];
      const zc = R[6] * X + R[7] * Y + R[8] * Z + t[2];
      if (zc <= 0.05) continue;
      const xc = R[0] * X + R[1] * Y + R[2] * Z + t[0];
      const yc = R[3] * X + R[4] * Y + R[5] * Z + t[1];
      const px = f * xc / zc + cx, py = f * yc / zc + cy;
      if (px < -60 || py < -60 || px > w + 60 || py > h + 60) continue;
      idx[vis] = i; depth[vis] = zc; sx[vis] = px; sy[vis] = py; vis++;
    }

    if (mode === 'blobs') {
      if (!this.sprites) this.sprites = buildSprites();
      const ord = Array.from({ length: vis }, (_, i) => i).sort((a, b) => depth[b] - depth[a]);
      // blobs start fat and translucent, end small and solid — the visual signature
      // of a splat model resolving
      // back-to-front alpha compositing, the same order a real splat renderer
      // sorts in — additive blending would just blow out wherever blobs pile up
      const rw = this.scene.radius * (0.016 * (1 - prog) + 0.008);
      const a = 0.40 + 0.42 * prog;
      for (let n = 0; n < vis; n++) {
        const k = ord[n], i = idx[k];
        const rpx = Math.max(1.6 * dpr, rw * f / depth[k]);
        const c3 = i * 3;
        const q = (Math.min(4, rgb[c3] * LEVELS >> 8) * LEVELS + Math.min(4, rgb[c3 + 1] * LEVELS >> 8)) * LEVELS
                + Math.min(4, rgb[c3 + 2] * LEVELS >> 8);
        ctx.globalAlpha = a * (o.fade ?? 1);
        ctx.drawImage(this.sprites[q], sx[k] - rpx, sy[k] - rpx, rpx * 2, rpx * 2);
      }
      ctx.globalAlpha = 1;
    } else {
      const s = Math.max(1, 1.35 * dpr);
      ctx.globalAlpha = (o.fade ?? 1) * 0.92;
      for (let n = 0; n < vis; n++) {
        const i = idx[n], c3 = i * 3;
        ctx.fillStyle = `rgb(${rgb[c3]},${rgb[c3 + 1]},${rgb[c3 + 2]})`;
        ctx.fillRect(sx[n] - s / 2, sy[n] - s / 2, s, s);
      }
      ctx.globalAlpha = 1;
    }

    if (o.showCams && o.cams) this._drawCams(o, P);

    if (P.letterbox) ctx.restore();
    this.dirty = false;
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
    const s = this.scene.radius * 0.075;
    const list = o.cams;
    const upto = o.reveal ?? list.length;
    const path = [];

    // dense video sets would draw 100+ overlapping pyramids; thin them out and
    // let the dashed path carry the shape of the walk instead
    const stride = Math.max(1, Math.ceil(list.length / 30));

    for (let i = 0; i < list.length && i < upto; i++) {
      const c = list[i];
      if (!c.R || c.state === 'unplaced') continue;
      const keep = i % stride === 0 || i === o.active || i === o.sel || c.state === 'holdout';
      if (!keep) { const p = this._project(P, ...camCentre(c)); if (p) path.push(p); continue; }
      if (this.lock && i === o.active && o.hideActive) continue;

      const R = c.R, t = c.t;
      const C = [
        -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
        -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
        -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
      ];
      const pc = this._project(P, C[0], C[1], C[2]);
      if (pc) path.push(pc);

      const isActive = i === o.active, isSel = i === o.sel;
      let col = 'rgba(163,149,138,.42)', lw = 1 * dpr;
      if (c.state === 'holdout') col = 'rgba(99,207,192,.75)';
      if (isSel) { col = 'rgba(239,231,218,.95)'; lw = 1.4 * dpr; }
      if (isActive) { col = 'rgba(242,160,63,1)'; lw = 1.8 * dpr; }
      if (!isActive && !isSel && o.dimOthers) col = 'rgba(163,149,138,.2)';

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
        ctx.fillStyle = 'rgba(242,160,63,.13)';
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
      ctx.strokeStyle = 'rgba(242,160,63,.22)';
      ctx.lineWidth = 1 * dpr;
      ctx.setLineDash([3 * dpr, 4 * dpr]);
      ctx.beginPath();
      path.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}
