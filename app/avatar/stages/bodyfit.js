// bodyfit.js — a fitted body model as the binding surface (the avatar
// service), with the rig mesh as the fallback.
//
// The service is the one step a browser cannot do: Anny (torch) fitted to
// the landmarks and the splat, one outer surface, head registered to the
// face. Until it is deployed (orchestrator: POST /avatar/fit), this stage
// records the fallback and the bind stage uses the rig mesh — the avatar
// still ships, the legs leak a little (3 % vs 0.3 % weight on the wrong leg).
export const id = 'bodyfit';
export const needs = ['landmarks'];

const SERVICE = (typeof location !== 'undefined' && new URLSearchParams(location.search).get('avatarfit')) || null;

export async function run(ctx, manifest, hooks) {
  const lm = manifest.stages.landmarks;
  if (!SERVICE) return { path: 'rigmesh', note: 'rig mesh (body-model service not deployed)' };
  hooks.progress?.(0, 1, 'fitting the body model …');
  const body = { markers: lm.markers, landmarks: lm.landmarks, face: lm.face, floorY: lm.floorY, fit: lm.fit };
  const r = await fetch(SERVICE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`avatar service ${r.status}`);
  const out = await r.json();
  if (!out.surface || !out.fit) throw new Error('avatar service returned no surface');
  ctx.surface = out.surface; ctx.fit = out.fit;
  return { path: 'anny', note: 'fitted body model', service: SERVICE };
}
