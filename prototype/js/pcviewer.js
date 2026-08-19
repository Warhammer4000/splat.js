// pcviewer.js — sorted, standard-3DGS rendering of the trained splat via the
// PlayCanvas engine (the same renderer family the arrival.space client uses).
//
// The trainer state is exported to an in-memory PLY (identical to the file
// export) and loaded as a gsplat asset, so this view shows exactly what the
// exported splat looks like in a real sorted alpha-compositing renderer —
// unlike the trainer's own order-independent view.

import { gaussiansToPly } from './ply.js';

export class PCViewer {
  static async create(canvas) {
    const pc = await import('../lib/playcanvas.min.mjs');
    const v = new PCViewer();
    v.pc = pc;
    v.canvas = canvas;
    v.gen = 0;

    const app = new pc.Application(canvas, {
      graphicsDeviceOptions: { antialias: false },
    });
    app.setCanvasFillMode(pc.FILLMODE_NONE);
    app.setCanvasResolution(pc.RESOLUTION_FIXED, canvas.width, canvas.height);
    app.start();
    v.app = app;

    const cam = new pc.Entity('cam');
    cam.addComponent('camera', {
      clearColor: new pc.Color(0, 0, 0, 1),
      fov: 50,
    });
    // keep the engine's default color pipeline (sRGB gamma, linear tonemap) —
    // it matches external PlayCanvas/SuperSplat viewers, verified against the
    // exported PLY; overriding gamma makes the view too dark
    app.root.addChild(cam);
    v.cam = cam;

    // y-up orbit state (the splat entity is rotated 180deg on X, converting
    // the SfM world from OpenCV y-down to PlayCanvas y-up)
    v.center = new pc.Vec3(0, 0, 0);
    v.dist = 5;
    v.yaw = 0;
    v.pitch = 0.35;
    v._bindControls();
    v._updateCamera();
    return v;
  }

  _bindControls() {
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
        const s = this.dist / 500;
        const right = this.cam.right, up = this.cam.up;
        this.center.x -= (right.x * dx - up.x * dy) * s;
        this.center.y -= (right.y * dx - up.y * dy) * s;
        this.center.z -= (right.z * dx - up.z * dy) * s;
      } else {
        this.yaw -= dx * 0.006;
        this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dy * 0.006));
      }
      this._updateCamera();
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = Math.max(this.minDist || 0.01, this.dist * Math.exp(e.deltaY * 0.0012));
      this._updateCamera();
    }, { passive: false });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _updateCamera() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.cam.setPosition(
      this.center.x + this.dist * cp * Math.sin(this.yaw),
      this.center.y + this.dist * sp,
      this.center.z + this.dist * cp * Math.cos(this.yaw));
    this.cam.lookAt(this.center);
  }

  /** Draw wireframe frustums for the training cameras (every frame via the
   *  engine's immediate-line API). cams: trainer camMeta ({R,t,f,cx,cy,w,h});
   *  depth: frustum pyramid depth in world units. */
  setCameras(cams, depth) {
    const pc = this.pc;
    const pts = [];
    const flip = (p) => new pc.Vec3(p[0], -p[1], -p[2]); // y-down world -> y-up
    for (const cam of cams) {
      const { R, t } = cam;
      const C = [
        -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
        -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
        -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
      ];
      const corner = (px, py) => {
        // image-plane corner at cam depth `depth`, transformed to world
        const dc = [((px - cam.cx) / cam.f) * depth, ((py - cam.cy) / cam.f) * depth, depth];
        return flip([
          C[0] + R[0] * dc[0] + R[3] * dc[1] + R[6] * dc[2],
          C[1] + R[1] * dc[0] + R[4] * dc[1] + R[7] * dc[2],
          C[2] + R[2] * dc[0] + R[5] * dc[1] + R[8] * dc[2],
        ]);
      };
      const apex = flip(C);
      const cs = [corner(0, 0), corner(cam.w, 0), corner(cam.w, cam.h), corner(0, cam.h)];
      for (let k = 0; k < 4; k++) {
        pts.push(apex, cs[k]);                 // pyramid edges
        pts.push(cs[k], cs[(k + 1) % 4]);      // image-plane rectangle
      }
      // small "up" tick on the top edge so orientation is readable
      pts.push(cs[0], corner(cam.w / 2, -cam.h * 0.25));
      pts.push(cs[1], corner(cam.w / 2, -cam.h * 0.25));
    }
    this.frustumPts = pts;
    this.frustumCols = pts.map(() => new pc.Color(1.0, 0.75, 0.15, 1));
    if (!this._frustumHook) {
      this._frustumHook = true;
      this.app.on('update', () => {
        if (this.frustumPts && this.showCameras !== false)
          this.app.drawLines(this.frustumPts, this.frustumCols);
      });
    }
  }

  /** Load/replace the splat from raw trainer parameters (stride-8 layout). */
  async setSplat(data, n, opts = {}) {
    const pc = this.pc;
    const blob = gaussiansToPly(data, n);
    const url = URL.createObjectURL(blob);
    const name = `splat-${++this.gen}.ply`;
    const asset = new pc.Asset(name, 'gsplat', { url, filename: name });
    await new Promise((resolve, reject) => {
      asset.on('load', resolve);
      asset.on('error', (err) => reject(new Error(`gsplat load failed: ${err}`)));
      this.app.assets.add(asset);
      this.app.assets.load(asset);
    });

    if (this.entity) this.entity.destroy();
    if (this.prevAsset) {
      this.app.assets.remove(this.prevAsset);
      this.prevAsset.unload();
    }
    if (this.prevUrl) URL.revokeObjectURL(this.prevUrl);
    this.prevAsset = asset;
    this.prevUrl = url;

    this.entity = new pc.Entity('splat');
    this.entity.addComponent('gsplat', { asset });
    this.entity.setEulerAngles(180, 0, 0); // OpenCV y-down world -> y-up
    this.app.root.addChild(this.entity);

    if (opts.fov) this.cam.camera.fov = opts.fov;
    if (opts.radius) {
      this.cam.camera.nearClip = opts.radius * 0.005;
      this.cam.camera.farClip = opts.radius * 100;
      this.minDist = opts.radius * 0.02;
      if (!this.framed) {
        this.dist = opts.radius * 0.9;
        if (opts.cam0) {
          // start the orbit at training camera 0's pose (flipped to y-up)
          const { R, t } = opts.cam0;
          const eye = [
            -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
            +(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
            +(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
          ];
          const dir = [R[6], -R[7], -R[8]]; // viewing direction, flipped
          this.pitch = Math.asin(Math.max(-1, Math.min(1, -dir[1])));
          this.yaw = Math.atan2(-dir[0], -dir[2]);
          this.center.set(
            eye[0] + dir[0] * this.dist,
            eye[1] + dir[1] * this.dist,
            eye[2] + dir[2] * this.dist);
        } else if (opts.center) {
          // same 180deg-X transform as the entity
          this.center.set(opts.center[0], -opts.center[1], -opts.center[2]);
        }
        this._updateCamera();
        this.framed = true;
      }
    }
    return n;
  }
}
