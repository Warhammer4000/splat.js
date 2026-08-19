// deploy_nightly.mjs — publish the Splat.js app to nightly.arrival.space/splatjs/
//
//   node scripts/deploy_nightly.mjs [--no-data] [--dry-run]
//
// Assembles a self-contained dist (app + library + preset datasets), then
// uploads it with the AWS CLI to the nightly bucket (same credentials the
// client's syncBuildTool / cdn upload bats use):
//
//   s3://june.arrival.space/splatjs/  ->  https://nightly.arrival.space/splatjs/index.html
//
// Cache policy: index.html no-cache (deploys go live immediately, no
// CloudFront invalidation needed), code 5 minutes, dataset images a week.
// --no-data skips the ~200MB dataset sync (code-only redeploy).

import { spawnSync } from 'child_process';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist', 'splatjs');
const BUCKET = 's3://june.arrival.space/splatjs';
const URL = 'https://nightly.arrival.space/splatjs/index.html';

const argv = process.argv.slice(2);
const noData = argv.includes('--no-data');
const dryRun = argv.includes('--dry-run');

// ---- 1. assemble dist ----
rmSync(join(root, 'dist'), { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(root, 'app'), dist, { recursive: true });
cpSync(join(root, 'src'), join(dist, 'src'), { recursive: true });

// The app lives at the deploy ROOT (not /app/), so its two relative roots
// move. Imports resolve against the MODULE (js/app.js -> ../src/); fetch URLs
// resolve against the DOCUMENT (index.html -> ./data/).
for (const f of readdirSync(join(dist, 'js'))) {
  const p = join(dist, 'js', f);
  let s = readFileSync(p, 'utf8');
  s = s.replaceAll("'../../src/", "'../src/").replaceAll("'../data/", "'./data/");
  writeFileSync(p, s);
}

// preset datasets, trimmed to exactly what the app's presets fetch
const SETS = [
  { dir: 'synthetic', pattern: (i) => `synthetic_${String(i).padStart(2, '0')}.png`, start: 0, count: 12 },
  { dir: 'truck', pattern: (i) => `${String(i).padStart(6, '0')}.jpg`, start: 1, count: 42 },
  { dir: 'camping', pattern: (i) => `frame_${String(i).padStart(5, '0')}.jpg`, start: 1, count: 113 },
  { dir: 'train', pattern: (i) => `${String(i).padStart(5, '0')}.jpg`, start: 1, count: 84 },
];
let dataOk = true;
for (const s of SETS) {
  const out = join(dist, 'data', s.dir);
  mkdirSync(out, { recursive: true });
  for (let k = 0, i = s.start; k < s.count; k++, i++) {
    const src = join(root, 'data', s.dir, s.pattern(i));
    if (!existsSync(src)) { console.warn(`missing ${src} — preset ${s.dir} will be broken`); dataOk = false; break; }
    cpSync(src, join(out, s.pattern(i)));
  }
}

console.log(`dist assembled at ${dist}${dataOk ? '' : ' (with missing datasets!)'}`);
if (dryRun) process.exit(0);

// ---- 2. upload (aws CLI; per-cache-class passes like the cdn bats) ----
const aws = (args) => {
  console.log('> aws ' + args.join(' '));
  const r = spawnSync('aws', args, { stdio: 'inherit', shell: true });
  if (r.status !== 0) { console.error('aws failed'); process.exit(1); }
};

if (!noData) {
  aws(['s3', 'sync', join(dist, 'data'), `${BUCKET}/data`,
    '--cache-control', '"public, max-age=604800"']);
}
aws(['s3', 'sync', join(dist, 'src'), `${BUCKET}/src`, '--delete',
  '--cache-control', '"public, max-age=300"',
  '--content-type', 'application/javascript']);
aws(['s3', 'sync', join(dist, 'js'), `${BUCKET}/js`, '--delete',
  '--cache-control', '"public, max-age=300"',
  '--content-type', 'application/javascript']);
aws(['s3', 'sync', join(dist, 'css'), `${BUCKET}/css`, '--delete',
  '--cache-control', '"public, max-age=300"',
  '--content-type', 'text/css']);
aws(['s3', 'cp', join(dist, 'index.html'), `${BUCKET}/index.html`,
  '--cache-control', '"no-cache"',
  '--content-type', 'text/html']);

console.log(`\nlive: ${URL}`);
