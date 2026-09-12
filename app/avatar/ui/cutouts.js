// cutouts.js — the "is this the person?" checkpoint: a strip of frames with
// the room removed. Resolves true (looks right) or false (not a person /
// cancel), and nothing expensive has run yet when the user says no.

export function cutoutsCard(card, frames, { coverage }) {
  return new Promise((resolve) => {
    const n = Math.min(7, frames.length);
    const picks = Array.from({ length: n }, (_, i) => frames[Math.round((i * (frames.length - 1)) / Math.max(1, n - 1))]);
    card.innerHTML = `
      <div class="vid-head"><b>Cut out of the room</b><span class="prep-sub">${frames.length} frames · the person covers ${(coverage * 100).toFixed(0)}% of a frame</span></div>
      <div class="av-strip" id="av-strip"></div>
      <div class="upcard-row"><p class="fine">The avatar trains only on what is white here. Hair and finger tips should be there; the room should not.</p>
        <span style="display:flex;gap:8px"><button class="btn btn-outline" id="av-no">Not a person</button><button class="btn btn-accent" id="av-yes">Looks right</button></span></div>`;
    const strip = card.querySelector('#av-strip');
    (async () => {
      for (const f of picks) {
        const [bmp, mask] = await Promise.all([createImageBitmap(f.source), createImageBitmap(f.mask)]);
        const h = 320, w = Math.round((bmp.width / bmp.height) * h);   // drawn at 2x, shown at 160 px
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.style.height = '160px'; cv.style.width = `${w / 2}px`;
        const g = cv.getContext('2d');
        // photo × matte over white
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
        const tmp = new OffscreenCanvas(w, h); const t = tmp.getContext('2d');
        t.drawImage(bmp, 0, 0, w, h);
        t.globalCompositeOperation = 'destination-in';
        // the matte is grayscale: use its luminance as alpha
        const m = new OffscreenCanvas(w, h); const mg = m.getContext('2d');
        mg.drawImage(mask, 0, 0, w, h);
        const md = mg.getImageData(0, 0, w, h); const ad = mg.createImageData(w, h);
        for (let p = 0; p < w * h; p++) { ad.data[p * 4 + 3] = md.data[p * 4]; }
        mg.putImageData(ad, 0, 0);
        t.drawImage(m, 0, 0);
        g.drawImage(tmp, 0, 0);
        bmp.close(); mask.close();
        strip.appendChild(cv);
      }
    })().catch(() => {});
    card.querySelector('#av-yes').onclick = () => resolve(true);
    card.querySelector('#av-no').onclick = () => resolve(false);
  });
}
