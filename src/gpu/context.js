// gpu/context.js — one WebGPU device for the whole pipeline.
//
// The trainer and the SIFT matcher share it (two devices double descriptor
// VRAM and can never share buffers), and a host that already owns a device —
// e.g. a PlayCanvas app — can hand it in instead.

/**
 * @typedef {object} GpuContext
 * @property {GPUDevice} device
 * @property {GPUAdapter|null} adapter   null when the device was handed in
 * @property {boolean} owned             whether dispose() destroys the device
 * @property {() => void} dispose
 */

/**
 * @param {{ device?: GPUDevice, powerPreference?: GPUPowerPreference }} [opts]
 * @returns {Promise<GpuContext>}
 */
export async function createGpu(opts = {}) {
  if (opts.device) {
    return { device: opts.device, adapter: null, owned: false, dispose() {} };
  }
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error('WebGPU not available in this environment');
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: opts.powerPreference || 'high-performance',
  });
  if (!adapter) throw new Error('no WebGPU adapter');
  // full-res training-target buffers can exceed the 128MB default binding
  // limit — ask for up to 1GB where the adapter allows it
  const want = 1 << 30;
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, want),
      maxBufferSize: Math.min(adapter.limits.maxBufferSize, want),
    },
  });
  return { device, adapter, owned: true, dispose() { device.destroy(); } };
}
