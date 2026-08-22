// sog.js — in-browser SOG compression via @playcanvas/splat-transform
// (vendored ESM bundle in app/vendor: bundle + its webp wasm + its encode
// worker; ~5MB, loaded on demand the first time an export needs it).
//
// SOG is the web-delivery format: Morton-ordered, quantized, k-means SH
// palettes, WebP-packed — typically 10-20x smaller than the .ply.

let stP = null;
const loadST = () => stP ??= import('../vendor/splat-transform.bundle.mjs').then((st) => {
  st.WorkerQueue.workerUrl = new URL('../vendor/st-worker.mjs', import.meta.url).href;
  // the workers' own fallback resolves ../lib/webp.wasm (package layout);
  // point everyone at the vendored copy instead
  st.WebPCodec.wasmUrl = new URL('../vendor/webp.wasm', import.meta.url).href;
  return st;
});

/**
 * PLY bytes -> bundled .sog Blob.
 * onProgress({ label, frac }): the writer's own stage names (gather, cluster,
 * encode …); frac is 0..1 within the current stage, or null for unbarred
 * stages.
 */
export async function plyToSog(plyBytes, { iterations = 10, onProgress = () => {} } = {}) {
  const st = await loadST();
  st.logger.setRenderer({
    handle(e) {
      if (e.kind === 'barStart') onProgress({ label: e.name, frac: 0 });
      else if (e.kind === 'barTick') onProgress({ label: e.name, frac: e.total ? e.current / e.total : 0 });
      else if (e.kind === 'barEnd') onProgress({ label: e.name, frac: 1 });
      else if (e.kind === 'scopeStart') onProgress({ label: e.name, frac: null });
    },
  });
  const rfs = new st.MemoryReadFileSystem();
  rfs.set('model.ply', plyBytes instanceof Uint8Array ? plyBytes : new Uint8Array(plyBytes));
  const [source] = await st.readFile({ filename: 'model.ply', inputFormat: 'ply', fileSystem: rfs });
  const pool = st.createChunkDataPool();
  const out = new st.MemoryFileSystem();
  // GPU device for the SH clustering — the CPU fallback pins the main thread
  // for MINUTES on big models (measured: 566k splats did not finish in 8)
  let device = null;
  const createDevice = async () => {
    const cv = document.createElement('canvas');
    device = await st.createGraphicsDevice(cv, { deviceTypes: ['webgpu'] });
    return device;
  };
  try {
    await st.writeSource(
      { filename: 'model.sog', outputFormat: 'sog-bundle', source, pool, options: { iterations }, createDevice }, out);
  } finally {
    source.close?.();
    device?.destroy?.();
  }
  const bytes = out.results.get('model.sog');
  if (!bytes) throw new Error('SOG writer produced no output');
  return new Blob([bytes], { type: 'application/octet-stream' });
}
