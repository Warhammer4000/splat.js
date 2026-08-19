// imageio.js — load & downscale input images.
// Produces per image:
//   feature-scale grayscale (for SfM) and training-scale RGB (for 3DGS loss).

// 960 (was 640): SfM feature localization is the pose-precision ceiling, and
// poses feed training at native (~960-980px) resolution. Measured on camping
// vs the server-COLMAP reference: 0.44% -> 0.27% ATE with the tail drift
// halved. Costs ~2x SIFT extraction (worker pool absorbs most of it).
export const FEAT_MAX_DIM = 960;
export const TRAIN_MAX_DIM = 1600; // hard ceiling; actual res = native, memory permitting
// GPU budget for the training-target buffer (all images, RGB float32).
// The trainer requests a 1GB storage-binding limit; leave headroom for
// splats/entries/grads.
const TARGET_BUDGET_BYTES = 700e6;
// training-resolution override for experiments (set BEFORE loading images):
//   window.__trainMaxDim = 300
const trainMaxDim = () =>
  (typeof window !== 'undefined' && window.__trainMaxDim) || TRAIN_MAX_DIM;

/** Train at the PROVIDED resolution up to TRAIN_MAX_DIM, shrunk only if the
 *  whole image set would blow the GPU target budget. Call once per dataset
 *  (needs the image count and one representative size); pass the result to
 *  processSource. An explicit window.__trainMaxDim wins unconditionally. */
export function adaptiveTrainCap(nImages, w, h) {
  if (typeof window !== 'undefined' && window.__trainMaxDim) return window.__trainMaxDim;
  const native = Math.max(w, h);
  const full = Math.min(native, TRAIN_MAX_DIM);
  const [fw, fh] = fitDims(w, h, full);
  const bytes = nImages * fw * fh * 12; // 3 channels x float32
  if (bytes <= TARGET_BUDGET_BYTES) return full;
  const s = Math.sqrt(TARGET_BUDGET_BYTES / bytes);
  return Math.max(320, Math.floor(full * s));
}

function fitDims(w, h, maxDim) {
  const s = Math.min(1, maxDim / Math.max(w, h));
  return [Math.max(2, Math.round(w * s)), Math.max(2, Math.round(h * s))];
}

/** High-quality downscale: iterative halving until within 2x of the target,
 *  then a final filtered draw. A single drawImage at large factors decimates
 *  (effectively point-samples), leaving aliasing in the training targets and
 *  the SfM grayscale. */
function drawScaled(src, srcW, srcH, w, h) {
  let cur = src, cw = srcW, ch = srcH;
  while (cw >= 2 * w && ch >= 2 * h) {
    const nw = Math.max(w, Math.round(cw / 2));
    const nh = Math.max(h, Math.round(ch / 2));
    const cv = document.createElement('canvas');
    cv.width = nw; cv.height = nh;
    const cctx = cv.getContext('2d');
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = 'high';
    cctx.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
    cur = cv; cw = nw; ch = nh;
  }
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, cw, ch, 0, 0, w, h);
  return ctx;
}

/** Single-step downscale (default bilinear). Deliberately used for the SfM
 *  grayscale: the residual high-frequency detail (incl. mild aliasing) is
 *  discriminative texture for corner detection and BRIEF — the smooth
 *  variant registers measurably fewer cameras. */
function drawScaledFast(src, w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  return ctx;
}

/** Process one drawable source (ImageBitmap or canvas) into the pipeline
 *  format. trainCap: per-dataset training resolution from adaptiveTrainCap()
 *  (falls back to the global cap when omitted). */
export function processSource(src, srcW, srcH, name, trainCap) {
  const featCap = (typeof window !== 'undefined' && window.__featMaxDim) || FEAT_MAX_DIM;
  const [fw, fh] = fitDims(srcW, srcH, featCap);
  const [tw, th] = fitDims(srcW, srcH, trainCap || trainMaxDim());

  const fctx = drawScaledFast(src, fw, fh);
  const fdata = fctx.getImageData(0, 0, fw, fh).data;
  const gray = new Float32Array(fw * fh);
  for (let i = 0; i < fw * fh; i++) {
    gray[i] = (0.299 * fdata[i * 4] + 0.587 * fdata[i * 4 + 1] + 0.114 * fdata[i * 4 + 2]) / 255;
  }

  // sharpness = Laplacian variance (motion-blur indicator; used to exclude
  // the blurriest frames from the training loss)
  let lapSum = 0, lapSq = 0;
  const nl = (fw - 2) * (fh - 2);
  for (let y = 1; y < fh - 1; y++) {
    for (let x = 1; x < fw - 1; x++) {
      const i = y * fw + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - fw] - gray[i + fw];
      lapSum += lap; lapSq += lap * lap;
    }
  }
  const lapMean = lapSum / nl;
  const sharpness = lapSq / nl - lapMean * lapMean;

  const tctx = drawScaled(src, srcW, srcH, tw, th);
  const tdata = tctx.getImageData(0, 0, tw, th).data;
  const rgb = new Float32Array(tw * th * 3);
  for (let i = 0; i < tw * th; i++) {
    rgb[i * 3] = tdata[i * 4] / 255;
    rgb[i * 3 + 1] = tdata[i * 4 + 1] / 255;
    rgb[i * 3 + 2] = tdata[i * 4 + 2] / 255;
  }

  // small thumbnail for the UI
  const [thw, thh] = fitDims(srcW, srcH, 96);
  const thumbCtx = drawScaled(src, srcW, srcH, thw, thh);

  return {
    name, fw, fh, gray, tw, th, rgb, sharpness,
    thumb: thumbCtx.canvas,
    /** sample training-res RGB at feature-scale pixel coords */
    sampleColor(x, y) {
      const sx = Math.min(tw - 1, Math.max(0, Math.round(x * tw / fw)));
      const sy = Math.min(th - 1, Math.max(0, Math.round(y * th / fh)));
      const i = (sy * tw + sx) * 3;
      return [rgb[i], rgb[i + 1], rgb[i + 2]];
    },
  };
}

/** Load user-selected image files. */
export async function loadImageFiles(files, log) {
  const out = [];
  let trainCap = 0;
  for (const file of files) {
    try {
      const bmp = await createImageBitmap(file);
      if (!trainCap) {
        trainCap = adaptiveTrainCap(files.length, bmp.width, bmp.height);
        log(`training resolution: ${trainCap}px max dim (${files.length} images)`);
      }
      out.push(processSource(bmp, bmp.width, bmp.height, file.name, trainCap));
      bmp.close();
    } catch (e) {
      log(`skipped ${file.name}: ${e.message}`);
    }
  }
  return out;
}
