// viewport.js — the camera, and everything drawn AROUND the model.
//
// The model itself is rendered by the splat.js trainer (WebGPU) into an
// offscreen canvas the app blits underneath; this module owns the one camera
// (free orbit, or locked to a photograph's pose), draws the sparse-point view
// used during the solve, and overlays camera frustums + the capture path with
// the exact same projection the trainer used — so the two layers register.
//
// Adapted from the mockup's painter viewport; the fake splat rasterizer is
// gone, and the orbit understands COLMAP-style worlds where +Y points DOWN
// (upSign = -1) without touching the data.

/** world position of a camera from its world-to-camera pose */
export const camCentre = ({ R, t }) => [
  -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
  -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
  -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
];

export class Viewport {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.scene = null;          // { xyz, rgb, center, radius }
    this.lock = null;           // a camera whose pose the view sits on
    this.yaw = 0.6; this.pitch = 0.22; this.dist = 8; this.target = [0, 0, 0];
    this.upSign = 1;            // +1: world +Y is up; -1: COLMAP (+Y down)
    this.dirty = true;
    this.w = 1; this.h = 1;
    this.enabled = true;
    this.freeF = null;          // focal carried over when leaving a frame pose
    this.onLeave = null;        // called when a drag pulls off a frame pose
    this._bind();
  }

  _bind() {
    const cv = this.cv;
    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      if (this.lock) this.onLeave?.();
      drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 || e.button === 1 };
      try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
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
        this.target[1] += dy * s * this.upSign;
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
      this.dist = Math.max(0.05, Math.min(400, this.dist * Math.exp(e.deltaY * 0.0011)));
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

  /** scene = { xyz: Float32Array, rgb: Uint8Array|Float, center, radius } */
  setScene(scene) {
    this.scene = scene;
    this.n = scene.xyz ? scene.xyz.length / 3 : 0;
    this.frameScene();
  }

  /** derive up from the cameras: each one's world up is minus its second row */
  detectUp(cams) {
    let y = 0;
    for (const c of cams) { if (c.R) y += -c.R[4]; }
    this.upSign = y >= 0 ? 1 : -1;
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
    const d = (this.scene ? this.scene.radius : 4) * 0.9;
    this.target = [C[0] + fwd[0] * d, C[1] + fwd[1] * d, C[2] + fwd[2] * d];
    this.dist = d;
    this.yaw = Math.atan2(-fwd[0], -fwd[2]);
    this.pitch = Math.asin(Math.max(-1, Math.min(1, this.upSign * fwd[1])));
    this.dirty = true;
  }

  /** current free-orbit pose in the trainer's camera shape */
  freePose() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const u = this.upSign;
    const fwd = [-sy * cp, u * sp, -cy * cp];
    const pos = [
      this.target[0] - fwd[0] * this.dist,
      this.target[1] - fwd[1] * this.dist,
      this.target[2] - fwd[2] * this.dist,
    ];
    const right = [cy, 0, -sy];
    // camera +y (image down) must point to world-down for either convention
    const cr = [
      fwd[1] * right[2] - fwd[2] * right[1],
      fwd[2] * right[0] - fwd[0] * right[2],
      fwd[0] * right[1] - fwd[1] * right[0],
    ];
    const down = u > 0 ? cr : [-cr[0], -cr[1], -cr[2]];
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

  /** the pose the stage renders with (canvas-resolution intrinsics) */
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

  /**
   * @param {object} o
   *   modelCanvas  the trainer's rendered frame (drawn as the base layer)
   *   points       true: draw the sparse cloud instead (during the solve)
   *   cams / showCams / reveal / active / sel / skip / faint / dimOthers /
   *   showPath     frustum overlays, as in the mockup
   */
  draw(o = {}) {
    const { ctx, w, h } = this;
    const P = this.viewPose();
    if (o.modelCanvas) {
      ctx.fillStyle = '#070909';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(o.modelCanvas, 0, 0, w, h);
    } else if (o.points && this.scene && this.scene.xyz) {
      this._points(P);
    } else {
      ctx.fillStyle = '#070909';
      ctx.fillRect(0, 0, w, h);
    }
    if (o.showCams && o.cams) this._drawCams(o, P);
    this.dirty = false;
    return P;
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
    if (o.faint) ctx.globalAlpha = 0.4;
    const s = (this.scene ? this.scene.radius : 4) * 0.075;
    const list = o.cams;
    const upto = o.reveal ?? list.length;
    const path = [];
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
