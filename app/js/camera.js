// camera.js — record a capture walk with the device camera, in the app.
//
// getUserMedia (environment camera, 1080p-ish) -> MediaRecorder -> a video
// blob that feeds the same sharp-frame extraction as an uploaded file.
//
// Auto-exposure drift is poison for splat training (the same wall changes
// brightness between frames and the optimiser blames geometry), so once the
// preview has settled we LOCK exposure and white balance where the platform
// allows it (Android Chrome exposes exposureMode/whiteBalanceMode constraints;
// iOS Safari does not — reported in the UI either way).

function pickMime() {
  const cands = [
    'video/mp4;codecs=avc1', 'video/mp4',
    'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
  ];
  for (const m of cands) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export function cameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder && pickMime());
}

/** Try to freeze exposure + white balance at their current auto values.
 *  Returns a short human-readable summary of what could be locked. */
async function lockExposure(track) {
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  const locked = [];
  const wants = [];
  if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('manual')) {
    const cur = track.getSettings().exposureTime;
    const c = { exposureMode: 'manual' };
    if (cur && caps.exposureTime) c.exposureTime = cur;
    wants.push([c, 'exposure']);
  }
  if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes('manual')) {
    const cur = track.getSettings().colorTemperature;
    const c = { whiteBalanceMode: 'manual' };
    if (cur && caps.colorTemperature) c.colorTemperature = cur;
    wants.push([c, 'white balance']);
  }
  for (const [c, name] of wants) {
    try {
      await track.applyConstraints({ advanced: [c] });
      locked.push(name);
    } catch { /* the capability lied — leave it on auto */ }
  }
  return locked.length ? `${locked.join(' + ')} locked` : 'auto exposure (lock not supported here)';
}

/**
 * Full-screen recorder. Resolves to a video File (or null on cancel).
 * onDone(file) is invoked after teardown so the caller can run extraction.
 */
export async function recordCaptureVideo() {
  const mime = pickMime();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 }, height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
  });
  const track = stream.getVideoTracks()[0];

  const ui = document.createElement('div');
  ui.className = 'camrec';
  ui.innerHTML = `
    <video id="cam-view" autoplay muted playsinline></video>
    <div class="camrec-top"><span class="chip" id="cam-status">settling …</span></div>
    <div class="camrec-hint">Move <b>sideways</b>, slowly. Keep the subject in frame — a wide arc beats a spin.</div>
    <div class="camrec-row">
      <button class="btn btn-quiet" id="cam-cancel">Cancel</button>
      <button class="camrec-btn" id="cam-rec" aria-label="Record"></button>
      <span class="camrec-time" id="cam-time">0:00</span>
    </div>`;
  document.body.appendChild(ui);
  const view = ui.querySelector('#cam-view');
  view.srcObject = stream;

  return new Promise((resolve) => {
    let rec = null, chunks = [], t0 = 0, timer = 0;
    const teardown = () => {
      clearInterval(timer);
      track.stop();
      stream.getTracks().forEach((t) => t.stop());
      ui.remove();
    };

    // let auto-exposure settle on the scene for a moment, then freeze it
    setTimeout(async () => {
      const what = await lockExposure(track);
      const st = ui.querySelector('#cam-status');
      if (st) st.textContent = what;
    }, 1200);

    ui.querySelector('#cam-cancel').addEventListener('click', () => {
      if (rec && rec.state !== 'inactive') rec.stop();
      teardown();
      resolve(null);
    });

    ui.querySelector('#cam-rec').addEventListener('click', function () {
      if (!rec) {
        rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16e6 });
        chunks = [];
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        rec.onstop = () => {
          const type = mime.split(';')[0];
          const ext = type.includes('mp4') ? 'mp4' : 'webm';
          teardown();
          resolve(new File([new Blob(chunks, { type })], `capture.${ext}`, { type }));
        };
        rec.start(1000);
        t0 = performance.now();
        this.dataset.on = '1';
        timer = setInterval(() => {
          const s = Math.floor((performance.now() - t0) / 1000);
          const el = ui.querySelector('#cam-time');
          if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        }, 500);
      } else if (rec.state !== 'inactive') {
        rec.stop();
      }
    });
  });
}
