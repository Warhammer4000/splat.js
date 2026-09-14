// Avatar-mode end-to-end through the real app (node tests/e2e/avatar_mode.mjs --train --video=scratch/lisa_test_4k.mp4;
// the .mov must be transcoded to H.264 first: headless Chrome has no HEVC). Stops at the sign-in click; downloads the package.: upload a clip, tick the box,
// accept the frames, watch the matte stage, screenshot the cut-outs card,
// accept, and (optionally --train) start training and wait for the avatar card.
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const VIDEO = opt('video', 'scratch/lisa_test_1080.mp4');
const OUT = opt('out', 'scratch/avatar_e2e');
const TRAIN = args.includes('--train');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const t0 = Date.now(); const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
import { appendFileSync, writeFileSync } from 'node:fs';
writeFileSync(`${OUT}_console.log`, '');
page.on('console', (m) => { const t = m.text(); appendFileSync(`${OUT}_console.log`, `[${((Date.now() - t0) / 1000).toFixed(0)}s] ${t.slice(0, 600)}
`); if (/\[avatar\]|\[video\]|\[session\]|matte|PAGEERROR/i.test(t) && !/favicon|GPU stall/i.test(t)) log('console: ' + t.slice(0, 220)); });
page.on('pageerror', (e) => log('PAGEERROR ' + String(e).slice(0, 300)));
await page.goto(`http://localhost:8734/app/index.html?iters=${opt('iters', '3000')}&faceiters=${opt('faceiters', '1500')}${opt('extra', '') ? '&' + opt('extra') : ''}`, { waitUntil: 'load' });
await page.waitForTimeout(2500);
await page.setInputFiles('#file-input', VIDEO);
log('video set');
await page.waitForSelector('#vid-use', { timeout: 300000 });
log('review card up');
await page.check('#vid-avatar');
await page.screenshot({ path: `${OUT}_review.png` });
await page.click('#vid-use');
await page.waitForSelector('#av-yes', { timeout: 600000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}_cutouts.png` });
log('cutouts card up');
await page.click('#av-yes');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}_detail.png` });
log('detail card: ' + (await page.textContent('#detail').catch(() => '')).replace(/\s+/g, ' ').slice(0, 160));
if (TRAIN) {
  await page.click('#btn-go');
  log('training started');
  await page.waitForSelector('#avcard', { timeout: 1800000 });
  log('avatar card up; dock splats: ' + (await page.textContent('#t-splats').catch(() => '?')));
  const tEnd = Date.now() + 25 * 60000; let last = '';
  while (Date.now() < tEnd) {
    await page.waitForTimeout(15000);
    const txt = (await page.textContent('#avcard').catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    if (txt !== last) { log('card: ' + txt); last = txt; }
    const dbg = await page.evaluate(() => window.__avatarDebug ? JSON.stringify(window.__avatarDebug) : null).catch(() => null);
    if (dbg && !globalThis.__dbgShown) { globalThis.__dbgShown = true; log('DEBUG ' + dbg.slice(0, 1600)); writeFileSync(`${OUT}_debug.json`, dbg); }
    if (await page.$('#av-lm-yes')) { await page.screenshot({ path: `${OUT}_markers.png` }); await page.click('#av-lm-yes'); log('accepted the joints'); }
    if (await page.$('#av-bf-yes')) { await page.screenshot({ path: `${OUT}_bodyfit.png` }); await page.click('#av-bf-yes'); log('accepted the body fit'); }
    if (await page.$('#av-go') || /failed|stopped here/.test(txt) || !(await page.$('#avcard'))) break;
  }
  await page.screenshot({ path: `${OUT}_avatar.png` });
  if (await page.$('#av-dl')) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#av-dl')]);
    await dl.saveAs(`${OUT}_package.zip`); log('package saved: ' + `${OUT}_package.zip`);
  }
}
await browser.close();
