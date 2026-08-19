// viewer.js — orbit camera controls for the interactive splat view.
// Produces {R, t, f, cx, cy, w, h} poses in the SfM world frame
// (camera convention: x right, y down, z forward).

export class OrbitCamera {
  constructor(canvas, center, radius) {
    this.canvas = canvas;
    this.center = center.slice();
    this.dist = radius * 2.2;
    this.minDist = radius * 0.05;
    this.yaw = 0;
    this.pitch = 0.15;
    this.f = canvas.width * 0.9;
    this.dirty = true;
    this._bind();
  }

  _bind() {
    const cv = this.canvas;
    let dragging = false, panning = false, lx = 0, ly = 0;
    cv.addEventListener('pointerdown', (e) => {
      dragging = true;
      panning = e.button === 2 || e.shiftKey;
      lx = e.clientX; ly = e.clientY;
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointerup', () => { dragging = false; });
    cv.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      if (panning) {
        const s = this.dist / this.f * 1.2;
        const { xc, yc } = this._axes();
        for (let i = 0; i < 3; i++)
          this.center[i] -= (xc[i] * dx + yc[i] * dy) * s;
      } else {
        this.yaw -= dx * 0.006;
        this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dy * 0.006));
      }
      this.dirty = true;
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = Math.max(this.minDist, this.dist * Math.exp(e.deltaY * 0.0012));
      this.dirty = true;
    }, { passive: false });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _axes() {
    // orbit position on a sphere; world up is -y (y points down)
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const eye = [
      this.center[0] + this.dist * cp * sy,
      this.center[1] - this.dist * sp,
      this.center[2] - this.dist * cp * cy,
    ];
    const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const cross = (a, b) => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]];
    const zc = norm([this.center[0] - eye[0], this.center[1] - eye[1], this.center[2] - eye[2]]);
    const xc = norm(cross(zc, [0, -1, 0]));
    const yc = cross(zc, xc);
    return { eye, xc, yc, zc };
  }

  /** Move the orbit parameters as close as possible to an exact camera pose
   *  (orbit has no roll, so this is approximate — used after un-snapping). */
  syncTo(cam, dist) {
    const R = cam.R, t = cam.t;
    const eye = [
      -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
      -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
      -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
    ];
    const zc = [R[6], R[7], R[8]]; // viewing direction (cam z in world)
    this.pitch = Math.asin(Math.max(-1, Math.min(1, zc[1])));
    this.yaw = Math.atan2(-zc[0], zc[2]);
    this.dist = dist;
    this.center = [eye[0] + zc[0] * dist, eye[1] + zc[1] * dist, eye[2] + zc[2] * dist];
    this.dirty = true;
  }

  pose() {
    const { eye, xc, yc, zc } = this._axes();
    const R = [xc[0], xc[1], xc[2], yc[0], yc[1], yc[2], zc[0], zc[1], zc[2]];
    const t = [
      -(R[0] * eye[0] + R[1] * eye[1] + R[2] * eye[2]),
      -(R[3] * eye[0] + R[4] * eye[1] + R[5] * eye[2]),
      -(R[6] * eye[0] + R[7] * eye[1] + R[8] * eye[2]),
    ];
    return {
      R, t, f: this.f,
      cx: this.canvas.width / 2, cy: this.canvas.height / 2,
      w: this.canvas.width, h: this.canvas.height,
    };
  }
}
