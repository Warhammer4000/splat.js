// download.js — browser download helper (DOM lives in the UI, not the library).
import { gaussiansToPly } from '../../../src/io/ply.js';

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function downloadPly(data, n, filename = 'splat.ply', sh = null, shK = 0) {
  downloadBlob(gaussiansToPly(data, n, sh, shK), filename);
}
